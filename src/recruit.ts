// ==========================================
// 📣 募集
// ==========================================
// 📝 参加/不参加ボタン付きの募集の作成・表示・自動締切を担う。
// 投票と同じく DB-first で登録し、開始時刻は再起動後も
// 再スケジュールされる。

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
import type { MabusabaStore, RecruitRow } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  buildEmbed,
  discordTimestamp,
  generateId,
  parseTimeInput,
  relativeTimestamp,
  replyEmbed,
} from "./util.js";
import { jstDateString } from "./stats.js";

// ==========================================
// 📋 募集の表示
// ==========================================
export function recruitEmbed(
  recruit: RecruitRow,
  members: string[],
  closed: boolean,
): ReturnType<typeof buildEmbed> {
  const full = members.length >= recruit.max_members;
  const lines = members.length
    ? members.map((id, i) => `${i + 1}. <@${id}>`).join("\n")
    : "まだ参加者はいません。";
  const status = closed
    ? "📣 募集は締め切られました"
    : full
      ? "📣 **満員です！**"
      : `📣 募集中 — 開始 ${relativeTimestamp(recruit.starts_at_ms)}`;
  return buildEmbed(
    `📣 ${recruit.title}`,
    [
      recruit.description ? `${recruit.description}\n` : "",
      `**開始時刻**　${discordTimestamp(recruit.starts_at_ms)}（${relativeTimestamp(recruit.starts_at_ms)}）`,
      `**定員**　${members.length}/${recruit.max_members}人${full ? "（満員）" : ""}`,
      `**参加者**\n${lines}`,
      "",
      status,
    ].join("\n"),
    full || closed ? EMBED_COLOR_INFO : EMBED_COLOR_SUCCESS,
  );
}

export function recruitButtons(
  recruit: RecruitRow,
  closed: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`recruit:${recruit.id}:join`)
      .setLabel("参加する")
      .setStyle(ButtonStyle.Success)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId(`recruit:${recruit.id}:leave`)
      .setLabel("不参加にする")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(closed),
  );
}

// ==========================================
// 🔒 締め切りとスケジュール
// ==========================================
export async function closeRecruit(
  client: Client,
  store: MabusabaStore,
  recruit: RecruitRow,
): Promise<void> {
  store.closeRecruit(recruit.id);
  const members = store.listRecruitMembers(recruit.id);
  const channel = await client.channels
    .fetch(recruit.channel_id)
    .catch(() => null);
  // 📌 投票と同じく、締切側も送信可能なテキストチャンネル全般を受ける
  if (!channel || !channel.isTextBased() || !channel.isSendable()) return;
  const message = await channel.messages
    .fetch(recruit.message_id)
    .catch(() => null);
  if (!message) return;
  await message
    .edit({
      embeds: [recruitEmbed(recruit, members, true)],
      components: [recruitButtons(recruit, true)],
    })
    .catch(() => undefined);
}

const recruitTimers = new Map<string, NodeJS.Timeout>();

// 📌 Node の setTimeout は 2^31-1 ミリ秒（約24.8日）を超える遅延を
// 表現できず、警告を出して1ミリ秒で発火してしまう。募集の開始時刻は
// 無制限（来月の日付など）なため、長い遅延は上限ごとに分割して
// 張り直し、即座に締め切ってしまわないようにする。
const MAX_TIMEOUT_MS = 2_147_483_647;

export function scheduleRecruitClose(
  client: Client,
  store: MabusabaStore,
  recruit: RecruitRow,
): void {
  const delay = recruit.starts_at_ms - Date.now();
  if (delay <= 0) {
    void closeRecruit(client, store, recruit).catch((error: unknown) => {
      console.error(
        `[mabubot-ops] recruit close failed (${recruit.id}):`,
        error,
      );
    });
    return;
  }
  const existing = recruitTimers.get(recruit.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => {
      recruitTimers.delete(recruit.id);
      if (delay > MAX_TIMEOUT_MS) scheduleRecruitClose(client, store, recruit);
      else
        void closeRecruit(client, store, recruit).catch((error: unknown) => {
          console.error(
            `[mabubot-ops] recruit close failed (${recruit.id}):`,
            error,
          );
        });
    },
    Math.min(delay, MAX_TIMEOUT_MS),
  );
  timer.unref();
  recruitTimers.set(recruit.id, timer);
}

export function rescheduleRecruits(client: Client, store: MabusabaStore): void {
  for (const recruit of store.listOpenRecruits())
    scheduleRecruitClose(client, store, recruit);
}

// ==========================================
// ⌨️ コマンドとボタン処理
// ==========================================
export async function handleRecruitCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.channel || !("send" in interaction.channel)) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバーのテキストチャンネルで使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  // create — title, members, time（必須）が description（任意）より前に来る
  const title = interaction.options.getString("title", true).trim();
  const maxMembers = interaction.options.getInteger("members", true);
  const timeInput = interaction.options.getString("time", true);
  const description =
    interaction.options.getString("description")?.trim() || null;
  const startsAtMs = parseTimeInput(timeInput);
  if (startsAtMs === null) {
    await replyEmbed(
      interaction,
      "⚠️ 開始時刻を読み取れませんでした",
      "例：`21:00` / `30分後` / `2026-11-14 21:00`（日本時間・未来の時刻）",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const id = generateId();
  const recruit: RecruitRow = {
    id,
    guild_id: guildId,
    channel_id: interaction.channelId,
    message_id: "",
    title,
    max_members: maxMembers,
    starts_at_ms: startsAtMs,
    description,
    created_by: interaction.user.id,
    closed: 0,
  };
  // 📌 DB-first（投票・タイマーと同じ順序）: 送信失敗時は行を巻き戻す
  store.createRecruit(recruit);
  let message;
  try {
    message = await interaction.channel.send({
      embeds: [recruitEmbed(recruit, [], false)],
      components: [recruitButtons(recruit, false)],
    });
  } catch (error) {
    store.deleteRecruit(recruit.id);
    throw error;
  }
  recruit.message_id = message.id;
  store.updateRecruitMessageId(recruit.id, message.id);
  store.incrementOpsStats(guildId, jstDateString(Date.now()), "events_held");
  scheduleRecruitClose(client, store, recruit);
  await replyEmbed(
    interaction,
    "📣 募集を作成しました",
    `「${title}」の募集を作成しました。開始は ${discordTimestamp(startsAtMs)}、定員 ${maxMembers}人です。`,
    EMBED_COLOR_SUCCESS,
    true,
  );
}

// ------------------------------------------
// 🔘 参加・不参加ボタン
// ------------------------------------------
export async function handleRecruitButton(
  interaction: ButtonInteraction,
  store: MabusabaStore,
): Promise<void> {
  const [, recruitId, action] = interaction.customId.split(":");
  const recruit = recruitId ? store.getRecruit(recruitId) : null;
  if (!recruit || recruit.closed) {
    await interaction
      .reply({
        content: "この募集は締め切られているか、見つかりませんでした。",
        ephemeral: true,
      })
      .catch(() => undefined);
    return;
  }
  if (action === "join") {
    const members = store.listRecruitMembers(recruit.id);
    if (members.includes(interaction.user.id)) {
      await interaction
        .reply({ content: "すでに参加しています。", ephemeral: true })
        .catch(() => undefined);
      return;
    }
    if (members.length >= recruit.max_members) {
      await interaction
        .reply({
          content: "定員に達しているため参加できません。",
          ephemeral: true,
        })
        .catch(() => undefined);
      return;
    }
    store.addRecruitMember(recruit.id, interaction.user.id);
    store.incrementOpsStats(
      recruit.guild_id,
      jstDateString(Date.now()),
      "event_attendees",
    );
  } else {
    store.removeRecruitMember(recruit.id, interaction.user.id);
  }
  const members = store.listRecruitMembers(recruit.id);
  await interaction
    .update({
      embeds: [recruitEmbed(recruit, members, false)],
      components: [recruitButtons(recruit, false)],
    })
    .catch(async () => {
      await interaction
        .reply({
          content: action === "join" ? "参加しました！" : "不参加にしました。",
          ephemeral: true,
        })
        .catch(() => undefined);
    });
}
