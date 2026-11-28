// ==========================================
// 🗳️ 投票
// ==========================================
// 📝 ボタンで投票する投票の作成・集計表示・自動締切を担う。
// 1人1票・変更可。投票は DB-first で登録し、期限は再起動後も
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
import type { MabusabaStore, PollRow } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  buildEmbed,
  generateId,
  replyEmbed,
} from "./util.js";
import { jstDateString } from "./stats.js";

// ==========================================
// 📊 投票の表示
// ==========================================
export function pollEmbed(
  poll: PollRow,
  counts: number[],
  closed: boolean,
): ReturnType<typeof buildEmbed> {
  const total = counts.reduce((a, b) => a + b, 0);
  const lines = poll.options.map((opt, i) => {
    const n = counts[i] ?? 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const bar =
      "▰".repeat(Math.round(pct / 10)) + "▱".repeat(10 - Math.round(pct / 10));
    return `${i + 1}. ${opt}\n　${bar} ${n}票（${pct}%）`;
  });
  const status = closed
    ? "🗳️ 投票は締め切られました"
    : `🗳️ 投票受付中 — <t:${Math.floor(poll.ends_at_ms / 1000)}:R>に締め切ります`;
  return buildEmbed(
    `📊 ${poll.question}`,
    `${lines.join("\n")}\n\n合計 ${total}票\n${status}`,
    closed ? EMBED_COLOR_INFO : EMBED_COLOR_SUCCESS,
  );
}

export function pollButtons(
  poll: PollRow,
  closed: boolean,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  poll.options.forEach((opt, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll:${poll.id}:${i}`)
        .setLabel(`${i + 1}. ${opt}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(closed),
    );
  });
  return row;
}

// ==========================================
// 🔒 締め切りとスケジュール
// ==========================================
// 📝 締切: DB を締切済みにし、メッセージを最終結果＋無効化ボタンへ編集する。
export async function closePoll(
  client: Client,
  store: MabusabaStore,
  poll: PollRow,
): Promise<void> {
  store.closePoll(poll.id);
  const counts = store.pollVoteCounts(poll.id, poll.options.length);
  const channel = await client.channels
    .fetch(poll.channel_id)
    .catch(() => null);
  // 📌 作成は送信可能なテキストチャンネル全般（スレッド・お知らせ
  // チャンネル含む）で許可しているため、締切側も GuildText に限定
  // しない（限定すると DB だけ締切済みになりメッセージが更新されない）。
  if (!channel || !channel.isTextBased() || !channel.isSendable()) return;
  const message = await channel.messages
    .fetch(poll.message_id)
    .catch(() => null);
  if (!message) return;
  await message
    .edit({
      embeds: [pollEmbed(poll, counts, true)],
      components: [pollButtons(poll, true)],
    })
    .catch(() => undefined);
}

const pollTimers = new Map<string, NodeJS.Timeout>();

export function schedulePollClose(
  client: Client,
  store: MabusabaStore,
  poll: PollRow,
): void {
  const delay = poll.ends_at_ms - Date.now();
  if (delay <= 0) {
    void closePoll(client, store, poll).catch((error: unknown) => {
      console.error(`[mabubot-ops] poll close failed (${poll.id}):`, error);
    });
    return;
  }
  const existing = pollTimers.get(poll.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pollTimers.delete(poll.id);
    void closePoll(client, store, poll).catch((error: unknown) => {
      console.error(`[mabubot-ops] poll close failed (${poll.id}):`, error);
    });
  }, delay);
  timer.unref();
  pollTimers.set(poll.id, timer);
}

export function reschedulePolls(client: Client, store: MabusabaStore): void {
  for (const poll of store.listOpenPolls())
    schedulePollClose(client, store, poll);
}

// ==========================================
// ⌨️ コマンドとボタン処理
// ==========================================
export async function handlePollCommand(
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
  // create — question, option1, option2（必須）が option3〜5 と
  // duration（任意）より前に来る
  const question = interaction.options.getString("question", true).trim();
  const options = [
    interaction.options.getString("option1", true).trim(),
    interaction.options.getString("option2", true).trim(),
    interaction.options.getString("option3")?.trim(),
    interaction.options.getString("option4")?.trim(),
    interaction.options.getString("option5")?.trim(),
  ].filter((o): o is string => Boolean(o));
  const durationMin = interaction.options.getInteger("duration") ?? 60;
  const id = generateId();
  const poll: PollRow = {
    id,
    guild_id: guildId,
    channel_id: interaction.channelId,
    message_id: "",
    question,
    options,
    ends_at_ms: Date.now() + durationMin * 60_000,
    created_by: interaction.user.id,
    closed: 0,
  };
  // 📌 DB-first（タイマーと同じ順序）: 公開メッセージの送信前に登録する
  // ことで、送信失敗時にボタンが死んだままのメッセージを残さない。
  // message_id は送信成功後に UPDATE で埋め、送信に失敗したら行を
  // 巻き戻してエラーを呼び出し側へ伝える。
  store.createPoll(poll);
  let message;
  try {
    message = await interaction.channel.send({
      embeds: [pollEmbed(poll, new Array(options.length).fill(0), false)],
      components: [pollButtons(poll, false)],
    });
  } catch (error) {
    store.deletePoll(poll.id);
    throw error;
  }
  poll.message_id = message.id;
  store.updatePollMessageId(poll.id, message.id);
  store.incrementOpsStats(guildId, jstDateString(Date.now()), "events_held");
  schedulePollClose(client, store, poll);
  await replyEmbed(
    interaction,
    "📊 投票を作成しました",
    `「${question}」の投票を作成しました。${durationMin}分後に自動で締め切ります。`,
    EMBED_COLOR_SUCCESS,
    true,
  );
}

// ------------------------------------------
// 🔘 投票ボタン
// ------------------------------------------
// 📝 1人1票・変更可。埋め込みは新しい票数で即時更新する。
export async function handlePollButton(
  interaction: ButtonInteraction,
  store: MabusabaStore,
): Promise<void> {
  const [, pollId, idxRaw] = interaction.customId.split(":");
  const idx = Number(idxRaw);
  const poll = pollId ? store.getPoll(pollId) : null;
  if (
    !poll ||
    poll.closed ||
    Number.isNaN(idx) ||
    idx < 0 ||
    idx >= poll.options.length
  ) {
    await interaction
      .reply({
        content: "この投票は締め切られているか、見つかりませんでした。",
        ephemeral: true,
      })
      .catch(() => undefined);
    return;
  }
  store.setPollVote(poll.id, interaction.user.id, idx);
  const counts = store.pollVoteCounts(poll.id, poll.options.length);
  await interaction
    .update({
      embeds: [pollEmbed(poll, counts, false)],
      components: [pollButtons(poll, false)],
    })
    .catch(async () => {
      await interaction
        .reply({
          content: `「${poll.options[idx]}」に投票しました。`,
          ephemeral: true,
        })
        .catch(() => undefined);
    });
}
