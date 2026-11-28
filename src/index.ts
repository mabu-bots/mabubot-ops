// ==========================================
// 🚀 エントリポイント
// ==========================================
// 📝 起動と全体の配線を担う。コマンド同期はここでは行わない
// （登録は sync-commands.ts の上書き同期だけが行う）。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import { Client, EmbedBuilder, GatewayIntentBits, Partials } from "discord.js";
import { MabusabaStore } from "./store.js";
import { handleChatInputCommand } from "./commands.js";
import { registerEvents } from "./events.js";
import { reschedulePolls } from "./poll.js";
import { rescheduleRecruits } from "./recruit.js";
import { rescheduleTimers } from "./timer.js";
import { EMBED_COLOR_ERROR, EMBED_FOOTER, logCommandExec } from "./util.js";
import { attachReadyWatchdog } from "./watchdog.js";
import { startPresenceCycle } from "./presence-cycle.js";
import { OpsScheduler } from "./scheduler.js";
import { createScheduleExecutor } from "./announce.js";

// ==========================================
// ⚙️ 初期化
// ==========================================
const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error(
    "DISCORD_TOKEN is required. Copy .env.example to .env and set it.",
  );
  process.exit(1);
}
const dataDir = process.env.DATA_DIR?.trim() || "./data";
const store = new MabusabaStore(dataDir);

// 📌 Partials は、キャッシュに無いオブジェクトでもイベントが
// 内容・送信者を運べるようにするために必要。
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // 特権: 参加・自動ロール
    GatewayIntentBits.GuildMessages,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.User,
  ],
});

// 🐕 Gateway 安全構造: READY が来ないサイレント停滞を検知して終了する
attachReadyWatchdog(client);

// 🗓️ 運営スケジューラー（設計書 §4）。実行の中身は announce.ts が担う。
const scheduler = new OpsScheduler({
  store,
  execute: createScheduleExecutor(client, store),
  onError: (schedule, error) => {
    console.error(
      `[mabubot-ops] scheduled job failed (${schedule.id}):`,
      error,
    );
  },
});

// ==========================================
// 🎉 起動時の処理
// ==========================================
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  // 🎮 プレゼンスは全 Bot 共通のプレゼンス・サイクルが担う
  startPresenceCycle(client);

  // 🔁 SQLite に残っている投票・募集・タイマーを再スケジュールし、
  // 再起動で失われないようにする（期限切れは即時に締切・発火）。
  // 個別に保護し、1種類の失敗で残りが飛ばないようにする。
  for (const [name, reschedule] of [
    ["polls", reschedulePolls],
    ["recruits", rescheduleRecruits],
    ["timers", rescheduleTimers],
  ] as const) {
    try {
      reschedule(client, store);
    } catch (error) {
      console.error(`[mabubot-ops] reschedule ${name} failed:`, error);
    }
  }
  // 🗓️ 運営スケジューラーを開始する（1分間隔、同日分の取りこぼしは
  // 起動直後のティックでキャッチアップする）
  try {
    scheduler.start();
  } catch (error) {
    console.error("[mabubot-ops] scheduler start failed:", error);
  }
  // 📌 コマンドはここでは同期しない。`npm run sync:commands` で
  // 上書き同期すること（sync-commands.ts 参照）。起動時同期をすると、
  // 同期で消したコマンドが再起動で復活してしまう。
});

// ==========================================
// ⌨️ コマンド実行時の処理
// ==========================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  // 📋 コマンド実行ログ（util.ts）: コマンド名・ID類・成否のみを1行残す
  const execLog = {
    commandName: interaction.commandName,
    route: "slash" as const,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
  };
  try {
    await handleChatInputCommand(interaction, client, store, scheduler);
    logCommandExec(execLog);
  } catch (error) {
    logCommandExec({ ...execLog, error });
    console.error("interaction failed", error);
    // 📌 reply() は未応答のインタラクションにしか使えない。ハンドラが
    // 応答済み・遅延済みなら followUp でないと投げてしまい、利用者に
    // 何も見えなくなる。
    const embed = new EmbedBuilder()
      .setTitle("⚠️ 処理に失敗しました")
      .setDescription("処理に失敗しました。")
      .setColor(EMBED_COLOR_ERROR)
      .setFooter({ text: EMBED_FOOTER })
      .setTimestamp(new Date());
    if (interaction.replied || interaction.deferred) {
      await interaction
        .followUp({ embeds: [embed], ephemeral: true })
        .catch(() => undefined);
    } else {
      await interaction
        .reply({ embeds: [embed], ephemeral: true })
        .catch(() => undefined);
    }
  }
});

// ==========================================
// 🔚 イベント登録と終了処理
// ==========================================
registerEvents(client, store);

// 📝 ログだけの全般ハンドラ（mabubot-play / mabubot-guard と同じ構成）:
// これが無いと、漏れた rejection や Gateway/クライアントのエラーが
// 文脈のない未処理 rejection として現れ（最近の Node ではプロセス
// 終了にもつながる）。ログに残すことで Bot を生かし続け、診断の
// 手がかりを残す。
client.on("error", (error) => {
  console.error("[mabubot-ops] client error:", error);
});
client.on("shardError", (error, shardId) => {
  console.error(`[mabubot-ops] shard ${shardId} error:`, error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[mabubot-ops] unhandled rejection:", reason);
});

process.on("SIGINT", () => {
  scheduler.stop();
  store.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  scheduler.stop();
  store.close();
  process.exit(0);
});

await client.login(token);
