// ==========================================
// 👋 歓迎メッセージ・自動役職
// ==========================================
// 📝 メンバー参加時の歓迎メッセージ送信と、役職の自動付与を担う。
// /welcome と /autorole は管理者コマンドで、定義側の既定権限
// （ManageGuild）に加えてハンドラでも実行時チェックする（二重防御）。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import {
  ChannelType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  buildEmbed,
  replyEmbed,
} from "./util.js";

// ==========================================
// 💬 ウェルカムメッセージ
// ==========================================
// 📌 埋め込みの説明文上限。テンプレート自体は最大1,000字でも、
// プレースホルダ展開（{server} の繰り返しや長いサーバー名）で
// 簡単に上限を超え、送信が API エラーで失敗していたため切り詰める。
export const MAX_WELCOME_MESSAGE_LENGTH = 4096;

export function renderWelcomeMessage(
  template: string | null,
  member: GuildMember,
): string {
  const text =
    template?.trim() ||
    "ようこそ {server} へ、{user} さん！ {count}人目のメンバーです 🎉";
  const rendered = text
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{count}", String(member.guild.memberCount));
  if (rendered.length <= MAX_WELCOME_MESSAGE_LENGTH) return rendered;
  return `${rendered.slice(0, MAX_WELCOME_MESSAGE_LENGTH - 1)}…`;
}

// ------------------------------------------
// 🔐 管理者権限の実行時チェック
// ------------------------------------------
// 📝 定義の setDefaultMemberPermissions(ManageGuild) はサーバー側の
// 連携設定で上書きされ得るため、ハンドラでも再チェックする。
export function hasManageGuildPermission(
  memberPermissions: { has(flag: bigint): boolean } | null | undefined,
): boolean {
  return memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function requireManageGuild(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (hasManageGuildPermission(interaction.memberPermissions)) return true;
  await replyEmbed(
    interaction,
    "⚠️ 権限がありません",
    "このコマンドは「サーバー管理」権限を持つメンバーだけが使えます。",
    EMBED_COLOR_ERROR,
  );
  return false;
}

// ------------------------------------------
// 🎭 自動ロールの階層・強い権限チェック
// ------------------------------------------
// Bot は自分の最上位ロールより下のロールしか付与できない。
export function isRoleAssignableByBot(
  rolePosition: number,
  botHighestPosition: number,
): boolean {
  return rolePosition < botHighestPosition;
}

const STRONG_PERMISSIONS: Array<[bigint, string]> = [
  [PermissionFlagsBits.Administrator, "管理者"],
  [PermissionFlagsBits.ManageGuild, "サーバー管理"],
  [PermissionFlagsBits.ManageRoles, "ロールの管理"],
  [PermissionFlagsBits.ManageChannels, "チャンネルの管理"],
  [PermissionFlagsBits.ManageWebhooks, "Webhookの管理"],
  [PermissionFlagsBits.KickMembers, "メンバーのキック"],
  [PermissionFlagsBits.BanMembers, "メンバーのBAN"],
  [PermissionFlagsBits.ModerateMembers, "メンバーのタイムアウト"],
  [PermissionFlagsBits.MentionEveryone, "全員へのメンション"],
];

// 🏷️ ロールが持つ強い権限のラベル一覧。/autorole set で、危険なロールを
// 全参加者へ自動付与する前に警告するために使う。Role の
// PermissionsBitField と、生のビットフィールド文字列（APIRole）の
// 両方を受け付ける。
export function strongPermissionLabels(permissions: unknown): string[] {
  const has = (flag: bigint): boolean => {
    if (
      permissions &&
      typeof permissions === "object" &&
      "has" in permissions &&
      typeof (permissions as { has: unknown }).has === "function"
    ) {
      return (permissions as { has(flag: bigint): boolean }).has(flag);
    }
    try {
      return (BigInt(String(permissions)) & flag) !== 0n;
    } catch {
      return false;
    }
  };
  return STRONG_PERMISSIONS.filter(([flag]) => has(flag)).map(
    ([, label]) => label,
  );
}

// 📨 参加イベントで歓迎メッセージを送る（通知先が設定されている場合）。
export async function sendWelcome(
  member: GuildMember,
  store: MabusabaStore,
): Promise<void> {
  const welcome = store.getWelcome(member.guild.id);
  if (!welcome) return;
  const channel = await member.guild.channels
    .fetch(welcome.channel_id)
    .catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  if (!channel.isSendable()) return;
  const embed = buildEmbed(
    `👋 ようこそ、${member.user.username} さん！`,
    renderWelcomeMessage(welcome.message, member),
    EMBED_COLOR_INFO,
    [
      { name: "👤 ユーザー", value: `<@${member.id}>`, inline: true },
      {
        name: "📅 アカウント作成日",
        value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
        inline: true,
      },
      {
        name: "📌 まぶ鯖の案内",
        value:
          "公式X: https://x.com/mabu_saba\n公式note: https://note.com/mabu_saba\nまずはルールと自己紹介のチャンネルを覗いてみてください。ROM専・覗くだけも歓迎です。",
      },
    ],
  );
  await channel.send({ embeds: [embed] }).catch((error: unknown) => {
    // 失敗した歓迎が黙って消えないよう、ログに残す
    console.error(
      `[mabubot-ops] welcome send failed in ${member.guild.id} (channel ${welcome.channel_id}):`,
      error,
    );
  });
}

// ==========================================
// 🎭 自動ロール
// ==========================================
// 📌 ギルドごとの自動ロールの上限。
export const MAX_AUTOROLES = 10;

// 📝 参加時に自動ロールを付与する。失敗（権限不足・階層）はログに
// 残すだけで投げない（参加処理自体を失敗させないため）。
// まず一括付与を試し、失敗したらロールごとに個別に再試行して、
// 1件の不良ロールが残りを巻き込まないようにする。
export async function applyAutorole(
  member: GuildMember,
  store: MabusabaStore,
): Promise<void> {
  const roleIds = store.getAutoroles(member.guild.id);
  if (!roleIds.length) return;
  try {
    await member.roles.add(roleIds);
    return;
  } catch {
    // 個別再試行へフォールスルー
  }
  for (const roleId of roleIds) {
    try {
      await member.roles.add(roleId);
    } catch (error) {
      console.error(
        `[mabubot-ops] autorole failed for ${member.id} in ${member.guild.id} (role ${roleId}):`,
        error,
      );
    }
  }
}

// ==========================================
// ⌨️ コマンド処理
// ==========================================
export async function handleWelcomeCommand(
  interaction: ChatInputCommandInteraction,
  store: MabusabaStore,
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
  const sub = interaction.options.getSubcommand();
  if (sub === "show") {
    const welcome = store.getWelcome(guildId);
    if (!welcome) {
      await replyEmbed(
        interaction,
        "👋 歓迎メッセージ",
        "歓迎メッセージは設定されていません。`/welcome set` で設定してください。",
      );
      return;
    }
    await replyEmbed(
      interaction,
      "👋 歓迎メッセージ",
      `通知先：<#${welcome.channel_id}>\nメッセージ：${welcome.message ?? "（既定のメッセージ）"}\n\nプレースホルダ：{user}（メンション）{server}（サーバー名）{count}（メンバー数）`,
    );
    return;
  }
  if (sub === "disable") {
    store.deleteWelcome(guildId);
    await replyEmbed(
      interaction,
      "👋 歓迎メッセージを止めました",
      "参加時の歓迎メッセージを送信しなくなります。",
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  if (sub === "test") {
    const welcome = store.getWelcome(guildId);
    if (!welcome) {
      await replyEmbed(
        interaction,
        "⚠️ 未設定です",
        "まず `/welcome set` で通知先を設定してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const member = interaction.member;
    if (!member || !("guild" in member)) {
      await replyEmbed(
        interaction,
        "⚠️ サーバー内で使用してください",
        "このコマンドはサーバー内で使用してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "👋 歓迎メッセージのテスト",
      renderWelcomeMessage(welcome.message, member as GuildMember),
      EMBED_COLOR_INFO,
      false,
    );
    return;
  }
  // set — channel（必須）が message（任意）より前に来る
  const channel = interaction.options.getChannel("channel", true);
  // 空白だけの文言は既定文として扱うため、未設定（null）として保存し、
  // show で空白が表示されないようにする
  const message = interaction.options.getString("message")?.trim() || null;
  store.setWelcome(guildId, channel.id, message);
  await replyEmbed(
    interaction,
    "👋 歓迎メッセージを設定しました",
    `通知先：<#${channel.id}>\nメッセージ：${message ?? "（既定のメッセージ）"}`,
    EMBED_COLOR_SUCCESS,
  );
}

// ------------------------------------------
// 🎭 自動ロールのコマンド処理
// ------------------------------------------
export async function handleAutoroleCommand(
  interaction: ChatInputCommandInteraction,
  store: MabusabaStore,
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
  const sub = interaction.options.getSubcommand();
  if (sub === "show") {
    const roleIds = store.getAutoroles(guildId);
    await replyEmbed(
      interaction,
      "🎭 自動役職",
      roleIds.length
        ? `参加時に自動で付与する役職（${roleIds.length}件）：\n${roleIds.map((id) => `・<@&${id}>`).join("\n")}`
        : "自動役職は設定されていません。`/autorole set` で設定してください。",
    );
    return;
  }
  if (sub === "remove") {
    const role = interaction.options.getRole("role");
    if (role) {
      if (!store.removeAutorole(guildId, role.id)) {
        await replyEmbed(
          interaction,
          "⚠️ 設定されていません",
          `<@&${role.id}> は自動役職に設定されていません。`,
          EMBED_COLOR_ERROR,
        );
        return;
      }
      const remaining = store.getAutoroles(guildId);
      await replyEmbed(
        interaction,
        "🎭 自動役職を解除しました",
        `<@&${role.id}> の自動付与を止めました。${remaining.length ? `\n残り（${remaining.length}件）：\n${remaining.map((id) => `・<@&${id}>`).join("\n")}` : "\n自動役職はすべて解除されました。"}`,
        EMBED_COLOR_SUCCESS,
      );
      return;
    }
    store.deleteAutorole(guildId);
    await replyEmbed(
      interaction,
      "🎭 自動役職をすべて解除しました",
      "参加時の自動役職付与を止めます。",
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  // set — 追加式: 呼び出すたびに1件追加される（置き換えではない）。
  // 複数設定したい場合は繰り返し実行する。
  const role = interaction.options.getRole("role", true);
  // @everyone と連携サービス管理ロールは付与自体ができないため、
  // 参加時に失敗するだけの設定を受け付けない
  if (role.id === guildId || role.managed) {
    await replyEmbed(
      interaction,
      "⚠️ その役職は付与できません",
      `<@&${role.id}> は自動付与できない役職です（@everyone・連携サービス管理の役職は付与できません）。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  // Bot 自身の最上位以上のロールは付与できない（参加時に黙って失敗する
  // 設定を受け付けない）
  const botMember =
    interaction.guild?.members.me ??
    (interaction.guild
      ? await interaction.guild.members.fetchMe().catch(() => null)
      : null);
  if (
    botMember &&
    "position" in role &&
    !isRoleAssignableByBot(role.position, botMember.roles.highest.position)
  ) {
    await replyEmbed(
      interaction,
      "⚠️ その役職は付与できません",
      `<@&${role.id}> は Bot（<@&${botMember.roles.highest.id}>）と同じか上位の役職のため、自動付与できません。Bot の役職をその役職より上へ移動してから設定してください。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const current = store.getAutoroles(guildId);
  if (current.includes(role.id)) {
    await replyEmbed(
      interaction,
      "🎭 すでに設定されています",
      `<@&${role.id}> はすでに自動役職に設定されています。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (current.length >= MAX_AUTOROLES) {
    await replyEmbed(
      interaction,
      "⚠️ 上限に達しました",
      `自動役職は最大 ${MAX_AUTOROLES}件までです。先に \`/autorole remove\` で減らしてください。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  store.addAutorole(guildId, role.id);
  const roleIds = store.getAutoroles(guildId);
  const strong = strongPermissionLabels(role.permissions);
  const warning = strong.length
    ? `\n\n⚠️ **警告**：この役職には強い権限（${strong.join("、")}）が含まれます。参加者全員へ自動で付与されます。本当に付与してよい役職か確認してください。`
    : "";
  await replyEmbed(
    interaction,
    "🎭 自動役職を設定しました",
    `参加時に <@&${role.id}> を自動で付与します。\n現在の自動役職（${roleIds.length}件）：\n${roleIds.map((id) => `・<@&${id}>`).join("\n")}${warning}`,
    EMBED_COLOR_SUCCESS,
  );
}
