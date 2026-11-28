// ==========================================
// 🗓️ /ops コマンドと下書き承認フロー
// ==========================================
// 📝 運営スケジューラーの管理（schedule / draft / run / stats /
// announce）と、下書きの承認ボタン処理を担う。すべてサーバー管理
// （ManageGuild）権限が必要で、実行時に再チェックする。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { MabusabaStore, OpsDraftRow } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_SUCCESS,
  generateId,
  joinLinesWithinLimit,
  replyEmbed,
} from "./util.js";
import { hasManageGuildPermission } from "./welcome.js";
import { getTemplate, listTemplateIds, renderTemplate } from "./templates.js";
import {
  parseScheduleTime,
  recentDateStrings,
  summarizeStats,
} from "./stats.js";
import { buildDefaultSchedules, type OpsScheduler } from "./scheduler.js";
import { postToChannel } from "./announce.js";

// ==========================================
// 🔐 権限チェック
// ==========================================
async function requireManageGuild(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<boolean> {
  if (hasManageGuildPermission(interaction.memberPermissions)) return true;
  const reply = {
    content: "この操作は「サーバー管理」権限を持つメンバーだけが使えます。",
    ephemeral: true as const,
  };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(reply).catch(() => undefined);
  } else {
    await interaction.reply(reply).catch(() => undefined);
  }
  return false;
}

// ==========================================
// 📝 下書きの承認ボタン
// ==========================================
export function draftButtons(draftId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`opsdraft:approve:${draftId}`)
      .setLabel("承認して投稿/確定")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`opsdraft:reject:${draftId}`)
      .setLabel("却下")
      .setStyle(ButtonStyle.Danger),
  );
}

// 📝 下書きを承認する共通処理。Discord 向けの下書きで投稿先がある
// ものはその場で投稿して published にし、それ以外（X / note）は
// approved に留める（外部投稿は Bot の外で行う設計: §5.5）。
export async function approveDraft(
  client: Client,
  store: MabusabaStore,
  draft: OpsDraftRow,
  decidedBy: string,
): Promise<"published" | "approved" | "already"> {
  if (draft.status !== "pending") return "already";
  if (draft.kind === "discord_post" && draft.target_channel_id) {
    if (!store.decideOpsDraft(draft.id, "approved", decidedBy))
      return "already";
    const messageId = await postToChannel(
      client,
      draft.target_channel_id,
      draft.title ?? "📢 お知らせ",
      draft.body,
    );
    store.decideOpsDraft(draft.id, "published", decidedBy, messageId);
    return "published";
  }
  if (!store.decideOpsDraft(draft.id, "approved", decidedBy)) return "already";
  return "approved";
}

export async function handleDraftButton(
  interaction: ButtonInteraction,
  client: Client,
  store: MabusabaStore,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const [, action, idText] = interaction.customId.split(":");
  const draft = store.getOpsDraft(Number(idText));
  if (!draft || draft.guild_id !== interaction.guildId) {
    await interaction
      .reply({ content: "下書きが見つかりません。", ephemeral: true })
      .catch(() => undefined);
    return;
  }
  if (action === "reject") {
    const ok = store.decideOpsDraft(draft.id, "rejected", interaction.user.id);
    await interaction
      .reply({
        content: ok
          ? `下書き #${draft.id} を却下しました。`
          : "この下書きは既に処理済みです。",
        ephemeral: true,
      })
      .catch(() => undefined);
    return;
  }
  const result = await approveDraft(client, store, draft, interaction.user.id);
  await interaction
    .reply({
      content:
        result === "published"
          ? `下書き #${draft.id} を承認し、投稿しました。`
          : result === "approved"
            ? `下書き #${draft.id} を承認しました。外部媒体への投稿はこの内容で行ってください。`
            : "この下書きは既に処理済みです。",
      ephemeral: true,
    })
    .catch(() => undefined);
}

// ==========================================
// ⌨️ /ops コマンド処理
// ==========================================
export async function handleOpsCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
  scheduler: OpsScheduler | null,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  // ----------------------------------------
  // 🗓️ スケジュール
  // ----------------------------------------
  if (group === "schedule") {
    if (sub === "list") {
      const schedules = store.listOpsSchedules(guildId);
      if (!schedules.length) {
        await replyEmbed(
          interaction,
          "🗓️ スケジュール一覧",
          "登録されているスケジュールはありません。`/ops schedule defaults` で標準セットを登録できます。",
        );
        return;
      }
      const lines = schedules.map(
        (s) =>
          `\`${s.id}\` ${s.enabled ? "▶️" : "⏸️"} ${s.kind} / ${s.days ? `曜日 ${s.days.join(",")}` : "毎日・月次"} ${s.time} / ${s.template_id} / ${s.mode}${s.last_status ? ` / 最終: ${s.last_status}` : ""}`,
      );
      const { text, omitted } = joinLinesWithinLimit(lines);
      await replyEmbed(
        interaction,
        `🗓️ スケジュール一覧（${schedules.length}件）`,
        omitted ? `${text}\n…他 ${omitted} 件` : text,
      );
      return;
    }
    if (sub === "defaults") {
      const channel = interaction.options.getChannel("channel", true);
      const existing = store.listOpsSchedules(guildId);
      if (existing.length) {
        await replyEmbed(
          interaction,
          "⚠️ 既に登録があります",
          `このサーバーには既に ${existing.length}件のスケジュールがあります。追加する場合は \`/ops schedule add\` を使ってください。`,
          EMBED_COLOR_ERROR,
        );
        return;
      }
      for (const spec of buildDefaultSchedules()) {
        store.createOpsSchedule({
          id: generateId(),
          guild_id: guildId,
          kind: spec.kind,
          days: spec.days,
          time: spec.time,
          channel_id: spec.kind === "stats_daily" ? null : channel.id,
          template_id: spec.templateId,
          mode: spec.mode,
        });
      }
      await replyEmbed(
        interaction,
        "🗓️ 標準スケジュールを登録しました",
        `<#${channel.id}> を投稿先として、標準の6件を登録しました。\`/ops schedule list\` で確認できます。`,
        EMBED_COLOR_SUCCESS,
      );
      return;
    }
    if (sub === "add") {
      const kind = interaction.options.getString("kind", true);
      const time = interaction.options.getString("time", true);
      const templateId = interaction.options.getString("template", true);
      if (!parseScheduleTime(time)) {
        await replyEmbed(
          interaction,
          "⚠️ 時刻の形式が違います",
          "時刻は `19:00` の形式（日本時間）で指定してください。",
          EMBED_COLOR_ERROR,
        );
        return;
      }
      if (!getTemplate(templateId)) {
        await replyEmbed(
          interaction,
          "⚠️ テンプレートが見つかりません",
          `使えるテンプレート: ${listTemplateIds().join(", ")}`,
          EMBED_COLOR_ERROR,
        );
        return;
      }
      const daysText = interaction.options.getString("days")?.trim();
      let days: number[] | null = null;
      if (daysText) {
        days = daysText
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((d) => Number(d));
        if (
          !days.length ||
          days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
        ) {
          await replyEmbed(
            interaction,
            "⚠️ 曜日の形式が違います",
            "曜日は 0=日曜 … 6=土曜 をカンマ区切りで指定してください（例: `1,3,5`）。",
            EMBED_COLOR_ERROR,
          );
          return;
        }
      }
      const channel = interaction.options.getChannel("channel");
      const mode =
        interaction.options.getString("mode") === "auto" ? "auto" : "draft";
      const id = generateId();
      store.createOpsSchedule({
        id,
        guild_id: guildId,
        kind,
        days,
        time,
        channel_id: channel?.id ?? null,
        template_id: templateId,
        mode,
      });
      await replyEmbed(
        interaction,
        "🗓️ スケジュールを登録しました",
        `ID: \`${id}\`\n種別: ${kind} / 時刻: ${time}（日本時間）/ テンプレート: ${templateId} / 方式: ${mode}`,
        EMBED_COLOR_SUCCESS,
      );
      return;
    }
    if (sub === "pause" || sub === "resume" || sub === "remove") {
      const id = interaction.options.getString("id", true).trim();
      const schedule = store.getOpsSchedule(id);
      if (!schedule || schedule.guild_id !== guildId) {
        await replyEmbed(
          interaction,
          "⚠️ スケジュールが見つかりません",
          "`/ops schedule list` で ID を確認してください。",
          EMBED_COLOR_ERROR,
        );
        return;
      }
      if (sub === "remove") {
        store.deleteOpsSchedule(id);
        await replyEmbed(
          interaction,
          "🗓️ スケジュールを削除しました",
          `ID: \`${id}\``,
          EMBED_COLOR_SUCCESS,
        );
        return;
      }
      store.setOpsScheduleEnabled(id, sub === "resume");
      await replyEmbed(
        interaction,
        sub === "resume"
          ? "🗓️ スケジュールを再開しました"
          : "🗓️ スケジュールを一時停止しました",
        `ID: \`${id}\``,
        EMBED_COLOR_SUCCESS,
      );
      return;
    }
  }

  // ----------------------------------------
  // 📝 下書き
  // ----------------------------------------
  if (group === "draft") {
    if (sub === "list") {
      const drafts = store.listOpsDrafts(guildId, "pending").slice(0, 20);
      if (!drafts.length) {
        await replyEmbed(
          interaction,
          "📝 承認待ちの下書き",
          "承認待ちの下書きはありません。",
        );
        return;
      }
      const lines = drafts.map(
        (d) =>
          `#${d.id} [${d.kind}] ${d.title ?? "（無題）"} — ${d.created_at.slice(0, 10)}`,
      );
      await replyEmbed(
        interaction,
        `📝 承認待ちの下書き（${drafts.length}件）`,
        `${lines.join("\n")}\n\n承認・却下は \`/ops draft approve\` / \`/ops draft reject\` で行えます。`,
      );
      return;
    }
    const id = interaction.options.getInteger("id", true);
    const draft = store.getOpsDraft(id);
    if (!draft || draft.guild_id !== guildId) {
      await replyEmbed(
        interaction,
        "⚠️ 下書きが見つかりません",
        "`/ops draft list` で ID を確認してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    if (sub === "reject") {
      const ok = store.decideOpsDraft(id, "rejected", interaction.user.id);
      await replyEmbed(
        interaction,
        ok ? "📝 下書きを却下しました" : "⚠️ 処理済みです",
        ok ? `#${id}` : "この下書きは既に処理済みです。",
        ok ? EMBED_COLOR_SUCCESS : EMBED_COLOR_ERROR,
      );
      return;
    }
    // approve
    const result = await approveDraft(
      client,
      store,
      draft,
      interaction.user.id,
    );
    await replyEmbed(
      interaction,
      result === "already" ? "⚠️ 処理済みです" : "📝 下書きを承認しました",
      result === "published"
        ? `#${id} を承認し、投稿しました。`
        : result === "approved"
          ? `#${id} を承認しました。外部媒体への投稿はこの内容で行ってください。\n\n${draft.body.slice(0, 1500)}`
          : "この下書きは既に処理済みです。",
      result === "already" ? EMBED_COLOR_ERROR : EMBED_COLOR_SUCCESS,
    );
    return;
  }

  // ----------------------------------------
  // ▶️ 手動実行
  // ----------------------------------------
  if (sub === "run" && !group) {
    const id = interaction.options.getString("id", true).trim();
    const schedule = store.getOpsSchedule(id);
    if (!schedule || schedule.guild_id !== guildId) {
      await replyEmbed(
        interaction,
        "⚠️ スケジュールが見つかりません",
        "`/ops schedule list` で ID を確認してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    if (!scheduler) {
      await replyEmbed(
        interaction,
        "⚠️ スケジューラーが起動していません",
        "Bot の起動処理でスケジューラーが開始されていません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await scheduler.runNow(id);
    const after = store.getOpsSchedule(id);
    await replyEmbed(
      interaction,
      "▶️ 実行しました",
      `ID: \`${id}\` の結果: ${after?.last_status ?? "不明"}`,
      EMBED_COLOR_SUCCESS,
    );
    return;
  }

  // ----------------------------------------
  // 📊 集計
  // ----------------------------------------
  if (sub === "stats" && !group) {
    const rows = store.listOpsStatsDaily(
      guildId,
      recentDateStrings(Date.now(), 7),
    );
    if (!rows.length) {
      await replyEmbed(
        interaction,
        "📊 直近7日の集計",
        "まだ集計データがありません。発言・参加があると日々積み上がります。",
      );
      return;
    }
    const summary = summarizeStats(rows);
    const latest = [...rows].reverse().find((r) => r.member_count !== null);
    await replyEmbed(
      interaction,
      "📊 直近7日の集計",
      [
        `メンバー数（最新）: ${latest?.member_count ?? "未集計"}`,
        `新規参加: ${summary.joined}人 / 退出: ${summary.left}人`,
        `発言数: ${summary.messageCount}件`,
        `よく賑わった場所: ${summary.topChannelId ? `<#${summary.topChannelId}>` : "なし"}`,
        `イベント: ${summary.eventsHeld}件 / 参加延べ ${summary.eventAttendees}人`,
      ].join("\n"),
    );
    return;
  }

  // ----------------------------------------
  // 📢 即時お知らせ（プレビュー＋ボタン）
  // ----------------------------------------
  if (sub === "announce" && !group) {
    const templateId = interaction.options.getString("template", true);
    const rendered = renderTemplate(templateId, {});
    if (!rendered) {
      await replyEmbed(
        interaction,
        "⚠️ テンプレートが見つかりません",
        `使えるテンプレート: ${listTemplateIds().join(", ")}`,
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const channel =
      interaction.options.getChannel("channel") ?? interaction.channel;
    const draftId = store.createOpsDraft({
      guild_id: guildId,
      kind: rendered.draftKind,
      title: rendered.title,
      body: rendered.body,
      target_channel_id:
        rendered.draftKind === "discord_post" ? (channel?.id ?? null) : null,
    });
    await interaction.reply({
      content: `下書き #${draftId} のプレビューです。承認すると投稿されます。\n**${rendered.title}**\n${rendered.body}`,
      components: [draftButtons(draftId)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await replyEmbed(
    interaction,
    "⚠️ 不明なサブコマンドです",
    "使い方を確認してください。",
    EMBED_COLOR_ERROR,
  );
}
