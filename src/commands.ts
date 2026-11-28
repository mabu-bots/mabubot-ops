// ==========================================
// ⌨️ スラッシュコマンド定義と振り分け
// ==========================================
// 📝 すべてのコマンド定義はここに集約し、sync-commands.ts が同じ
// 一覧を読み込んで登録する。必須オプションは任意オプションより
// 前に置く（Discord は必須が後だと 50035 で拒否する）。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  replyEmbed,
} from "./util.js";
import { handleAutoroleCommand, handleWelcomeCommand } from "./welcome.js";
import { handlePollCommand } from "./poll.js";
import { handleRecruitCommand } from "./recruit.js";
import { handleTimerCommand } from "./timer.js";
import { handleOpsCommand } from "./ops.js";
import type { OpsScheduler } from "./scheduler.js";
import { listTemplateIds } from "./templates.js";

// ==========================================
// 👋 ウェルカム・自動ロール
// ==========================================
export const welcomeCommand = new SlashCommandBuilder()
  .setName("welcome")
  .setDescription("参加時の歓迎メッセージを設定します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("歓迎メッセージの通知先と文言を設定します")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("通知先チャンネル")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText),
      )
      .addStringOption((opt) =>
        opt
          .setName("message")
          .setDescription(
            "文言（{user} {server} {count} が使えます。未指定なら既定の文言）",
          )
          .setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("show").setDescription("現在の歓迎メッセージ設定を表示します"),
  )
  .addSubcommand((sub) =>
    sub.setName("disable").setDescription("歓迎メッセージを止めます"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("test")
      .setDescription(
        "歓迎メッセージの見た目を確認します（チャンネル全員に見えます）",
      ),
  );

export const autoroleCommand = new SlashCommandBuilder()
  .setName("autorole")
  .setDescription("参加時に自動で付与する役職を設定します（複数可）")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription(
        "参加時に自動で付与する役職を追加します（繰り返し実行で複数設定可）",
      )
      .addRoleOption((opt) =>
        opt.setName("role").setDescription("付与する役職").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription(
        "自動役職を解除します（役職を指定するとその1件だけ、未指定なら全て解除）",
      )
      .addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("解除する役職（未指定なら全て解除）"),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("show").setDescription("現在の自動役職を表示します"),
  );

// ==========================================
// 🗳️ 投票
// ==========================================
export const pollCommand = new SlashCommandBuilder()
  .setName("poll")
  .setDescription("投票を作成します")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("投票を作成します（ボタンで投票・1人1票・変更可）")
      .addStringOption((opt) =>
        opt
          .setName("question")
          .setDescription("質問")
          .setRequired(true)
          .setMaxLength(200),
      )
      .addStringOption((opt) =>
        opt
          .setName("option1")
          .setDescription("選択肢1")
          .setRequired(true)
          .setMaxLength(80),
      )
      .addStringOption((opt) =>
        opt
          .setName("option2")
          .setDescription("選択肢2")
          .setRequired(true)
          .setMaxLength(80),
      )
      .addStringOption((opt) =>
        opt.setName("option3").setDescription("選択肢3").setMaxLength(80),
      )
      .addStringOption((opt) =>
        opt.setName("option4").setDescription("選択肢4").setMaxLength(80),
      )
      .addStringOption((opt) =>
        opt.setName("option5").setDescription("選択肢5").setMaxLength(80),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("duration")
          .setDescription("投票期間（分、1〜1440。未指定なら60分）")
          .setMinValue(1)
          .setMaxValue(1440),
      ),
  );

// ==========================================
// 📣 募集
// ==========================================
export const recruitCommand = new SlashCommandBuilder()
  .setName("recruit")
  .setDescription("募集を作成します")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("募集を作成します（参加/不参加ボタン付き）")
      .addStringOption((opt) =>
        opt
          .setName("title")
          .setDescription("募集のタイトル")
          .setRequired(true)
          .setMaxLength(100),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("members")
          .setDescription("定員（2〜20人）")
          .setRequired(true)
          .setMinValue(2)
          .setMaxValue(20),
      )
      .addStringOption((opt) =>
        opt
          .setName("time")
          .setDescription("開始時刻（例：21:00 / 30分後 / 2026-11-14 21:00）")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName("description").setDescription("説明").setMaxLength(1000),
      ),
  );

// ==========================================
// ⏰ タイマー
// ==========================================
export const timerCommand = new SlashCommandBuilder()
  .setName("timer")
  .setDescription("タイマー（リマインダー）を設定します")
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("タイマーを設定します")
      .addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("何分後か（1〜1440）")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(1440),
      )
      .addStringOption((opt) =>
        opt
          .setName("message")
          .setDescription("鳴ったときに表示する内容")
          .setRequired(true)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("設定中のタイマーを一覧表示します"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("タイマーをキャンセルします")
      .addStringOption((opt) =>
        opt
          .setName("id")
          .setDescription("タイマーのID（/timer list で確認）")
          .setRequired(true),
      ),
  );

// ==========================================
// 🗓️ 運営スケジューラー
// ==========================================
const TEMPLATE_CHOICES = listTemplateIds().map((id) => ({
  name: id,
  value: id,
}));
const SCHEDULE_KIND_CHOICES = [
  { name: "announce（お知らせ）", value: "announce" },
  { name: "weekly_review（週次振り返り）", value: "weekly_review" },
  { name: "monthly_report（月報）", value: "monthly_report" },
  { name: "stats_daily（日次集計）", value: "stats_daily" },
];

export const opsCommand = new SlashCommandBuilder()
  .setName("ops")
  .setDescription("運営スケジューラー（スケジュール・下書き・集計）")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup((group) =>
    group
      .setName("schedule")
      .setDescription("スケジュール管理")
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("スケジュール一覧を表示します"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("defaults")
          .setDescription("標準スケジュール6件を一括登録します")
          .addChannelOption((opt) =>
            opt
              .setName("channel")
              .setDescription("投稿先チャンネル")
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("スケジュールを追加します")
          .addStringOption((opt) =>
            opt
              .setName("kind")
              .setDescription("種別")
              .setRequired(true)
              .addChoices(...SCHEDULE_KIND_CHOICES),
          )
          .addStringOption((opt) =>
            opt
              .setName("time")
              .setDescription("時刻（日本時間、例: 19:00）")
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName("template")
              .setDescription("テンプレート")
              .setRequired(true)
              .addChoices(...TEMPLATE_CHOICES),
          )
          .addChannelOption((opt) =>
            opt
              .setName("channel")
              .setDescription("投稿先チャンネル")
              .addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((opt) =>
            opt
              .setName("days")
              .setDescription(
                "曜日（0=日曜…6=土曜、カンマ区切り。未指定なら毎日/月次）",
              ),
          )
          .addStringOption((opt) =>
            opt
              .setName("mode")
              .setDescription("方式（未指定なら draft）")
              .addChoices(
                { name: "draft（承認待ちにする）", value: "draft" },
                { name: "auto（そのまま投稿）", value: "auto" },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("pause")
          .setDescription("スケジュールを一時停止します")
          .addStringOption((opt) =>
            opt
              .setName("id")
              .setDescription("スケジュールID")
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("resume")
          .setDescription("スケジュールを再開します")
          .addStringOption((opt) =>
            opt
              .setName("id")
              .setDescription("スケジュールID")
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("スケジュールを削除します")
          .addStringOption((opt) =>
            opt
              .setName("id")
              .setDescription("スケジュールID")
              .setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("draft")
      .setDescription("承認待ち下書き")
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("承認待ちの下書き一覧を表示します"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("approve")
          .setDescription("下書きを承認します（Discord向けは投稿されます）")
          .addIntegerOption((opt) =>
            opt.setName("id").setDescription("下書きID").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("reject")
          .setDescription("下書きを却下します")
          .addIntegerOption((opt) =>
            opt.setName("id").setDescription("下書きID").setRequired(true),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("run")
      .setDescription("スケジュールを今すぐ1回実行します")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("スケジュールID").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("stats").setDescription("直近7日の集計を表示します"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("announce")
      .setDescription(
        "テンプレートからお知らせの下書きを作り、プレビューします",
      )
      .addStringOption((opt) =>
        opt
          .setName("template")
          .setDescription("テンプレート")
          .setRequired(true)
          .addChoices(...TEMPLATE_CHOICES),
      )
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("投稿先（未指定ならこのチャンネル）")
          .addChannelTypes(ChannelType.GuildText),
      ),
  );

// ==========================================
// ⚙️ その他
// ==========================================
export const pingCommand = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("mabubot-ops の応答状態を確認します");

export const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("mabubot-ops のコマンド一覧を表示します");

// ==========================================
// 📋 コマンド一覧とヘルプ文
// ==========================================
export const allCommands = [
  welcomeCommand,
  autoroleCommand,
  pollCommand,
  recruitCommand,
  timerCommand,
  opsCommand,
  pingCommand,
  helpCommand,
];

const HELP_TEXT = [
  "**👋 歓迎・自動役職**（管理者）\n`/welcome set` `/welcome show` `/welcome disable` `/welcome test` ／ `/autorole set` `/autorole remove` `/autorole show`",
  "**📊 投票・募集・タイマー**\n`/poll create` ／ `/recruit create` ／ `/timer set|list|cancel`",
  "**🗓️ 運営スケジューラー**（管理者）\n`/ops schedule list|defaults|add|pause|resume|remove` ／ `/ops draft list|approve|reject` ／ `/ops run` ／ `/ops stats` ／ `/ops announce`",
  "**⚙️ その他**\n`/ping`",
].join("\n\n");

// ==========================================
// ⌨️ コマンド処理
// ==========================================
export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await replyEmbed(
    interaction,
    "✨ mabubot-ops のコマンド一覧",
    HELP_TEXT,
    EMBED_COLOR_INFO,
    false,
  );
}

export async function handlePingCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  await replyEmbed(
    interaction,
    "🏓 Pong!",
    `mabubot-ops は正常に稼働しています。（ping: ${client.ws.ping}ms）`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
  scheduler: OpsScheduler | null = null,
): Promise<void> {
  switch (interaction.commandName) {
    case "welcome":
      await handleWelcomeCommand(interaction, store);
      break;
    case "autorole":
      await handleAutoroleCommand(interaction, store);
      break;
    case "poll":
      await handlePollCommand(interaction, client, store);
      break;
    case "recruit":
      await handleRecruitCommand(interaction, client, store);
      break;
    case "timer":
      await handleTimerCommand(interaction, client, store);
      break;
    case "ops":
      await handleOpsCommand(interaction, client, store, scheduler);
      break;
    case "ping":
      await handlePingCommand(interaction, client);
      break;
    case "help":
      await handleHelpCommand(interaction);
      break;
    default:
      await replyEmbed(
        interaction,
        "⚠️ 不明なコマンドです",
        "不明なコマンドです。",
        EMBED_COLOR_ERROR,
      );
  }
}
