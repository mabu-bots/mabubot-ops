// ==========================================
// ⏰ タイマー
// ==========================================
// 📝 メンション付きリマインダーの設定・発火・キャンセルを担う。
// SQLite に保存され、再起動後も再スケジュールされる（期限切れは
// 起動時にすぐ鳴る）。キャンセルできるのは設定した本人だけ。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { MabusabaStore, TimerRow } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_SUCCESS,
  buildEmbed,
  discordTimestamp,
  formatDuration,
  generateId,
  joinLinesWithinLimit,
  relativeTimestamp,
  replyEmbed,
} from "./util.js";

// ==========================================
// 🔔 発火とスケジュール
// ==========================================
const timerHandles = new Map<string, NodeJS.Timeout>();

// 📝 発火: 元のチャンネルで利用者をメンションし、行を削除して
// 二度鳴らないようにする。
export async function fireTimer(
  client: Client,
  store: MabusabaStore,
  timer: TimerRow,
): Promise<void> {
  timerHandles.delete(timer.id);
  store.deleteTimer(timer.id);
  const channel = await client.channels
    .fetch(timer.channel_id)
    .catch(() => null);
  // 📌 タイマーはスレッドからも設定できるため、GuildText に限定すると
  // 鳴らずに消えてしまう。送信可能なテキストチャンネル全般を受ける。
  if (!channel || !channel.isTextBased() || !channel.isSendable()) return;
  const embed = buildEmbed(
    "⏰ タイマーが鳴りました！",
    `<@${timer.user_id}> ${timer.message}`,
    EMBED_COLOR_SUCCESS,
  );
  await channel
    .send({ content: `<@${timer.user_id}>`, embeds: [embed] })
    .catch(() => undefined);
}

export function scheduleTimer(
  client: Client,
  store: MabusabaStore,
  timer: TimerRow,
): void {
  const delay = timer.fires_at_ms - Date.now();
  if (delay <= 0) {
    void fireTimer(client, store, timer).catch((error: unknown) => {
      console.error(`[mabubot-ops] timer fire failed (${timer.id}):`, error);
    });
    return;
  }
  const existing = timerHandles.get(timer.id);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    void fireTimer(client, store, timer).catch((error: unknown) => {
      console.error(`[mabubot-ops] timer fire failed (${timer.id}):`, error);
    });
  }, delay);
  handle.unref();
  timerHandles.set(timer.id, handle);
}

// 🔁 起動時に保留中のタイマーをすべて再スケジュールする。
// 期限切れのものは scheduleTimer 経由ですぐに発火する。
export function rescheduleTimers(client: Client, store: MabusabaStore): void {
  for (const timer of store.listTimers()) scheduleTimer(client, store, timer);
}

// ==========================================
// ⌨️ コマンド処理
// ==========================================
export async function handleTimerCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
): Promise<void> {
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
  const sub = interaction.options.getSubcommand();

  // ----------------------------------------
  // 📋 一覧
  // ----------------------------------------
  if (sub === "list") {
    const timers = store.listTimers(guildId);
    if (!timers.length) {
      await replyEmbed(
        interaction,
        "⏰ タイマー一覧",
        "設定されているタイマーはありません。",
      );
      return;
    }
    const lines = timers.map(
      (t) =>
        `\`${t.id}\`　${discordTimestamp(t.fires_at_ms)}（${relativeTimestamp(t.fires_at_ms)}）\n　<@${t.user_id}>：${t.message}`,
    );
    // 件数が多いと埋め込みの上限（4096字）を超えるため詰める
    const { text, omitted } = joinLinesWithinLimit(lines);
    await replyEmbed(
      interaction,
      `⏰ タイマー一覧（${timers.length}件）`,
      omitted ? `${text}\n…他 ${omitted} 件（省略）` : text,
    );
    return;
  }

  // ----------------------------------------
  // ❌ キャンセル
  // ----------------------------------------
  if (sub === "cancel") {
    const id = interaction.options.getString("id", true).trim();
    const timer = store.getTimer(id);
    if (!timer || timer.guild_id !== guildId) {
      await replyEmbed(
        interaction,
        "⚠️ タイマーが見つかりません",
        "IDを確認してください。`/timer list` で一覧が見られます。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    // 📌 キャンセルできるのは設定した本人だけ。ID は /timer list で
    // 全員に見えるため、以前は誰でも他人のリマインダーを消せた。
    if (timer.user_id !== interaction.user.id) {
      await replyEmbed(
        interaction,
        "⚠️ キャンセルできません",
        "キャンセルできるのは、タイマーを設定した本人だけです。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const handle = timerHandles.get(id);
    if (handle) clearTimeout(handle);
    timerHandles.delete(id);
    store.deleteTimer(id);
    await replyEmbed(
      interaction,
      "⏰ タイマーをキャンセルしました",
      `「${timer.message}」のタイマーをキャンセルしました。`,
      EMBED_COLOR_SUCCESS,
    );
    return;
  }

  // ----------------------------------------
  // ➕ 設定
  // ----------------------------------------
  // set — minutes（必須）、message（必須）の順
  const minutes = interaction.options.getInteger("minutes", true);
  const message = interaction.options.getString("message", true).trim();
  const id = generateId();
  const timer: TimerRow = {
    id,
    guild_id: guildId,
    channel_id: interaction.channelId,
    user_id: interaction.user.id,
    message,
    fires_at_ms: Date.now() + minutes * 60_000,
    created_at_ms: Date.now(),
  };
  store.createTimer(timer);
  scheduleTimer(client, store, timer);
  await replyEmbed(
    interaction,
    "⏰ タイマーを設定しました",
    `ID：\`${id}\`\n${formatDuration(minutes * 60_000)}後（${discordTimestamp(timer.fires_at_ms)}）にこのチャンネルでお知らせします。\n内容：${message}`,
    EMBED_COLOR_SUCCESS,
  );
}
