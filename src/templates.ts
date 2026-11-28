// ==========================================
// 🧩 投稿テンプレート
// ==========================================
// 📝 投稿テンプレートの正本。文面の原案は『まぶ鯖 3媒体運営スターター
// キット』§6 で、運営自動化設計書 v1.1 付録 A の一覧に対応する。
// テンプレート自体は信頼できる前提でメンション記法は含めない。
// 利用者入力は埋め込み前に必ず無害化する（§メンション無害化）。
// （依存なし: テンプレートは純粋なデータと文字列処理だけを持つ）

// ==========================================
// 📐 テンプレート定義
// ==========================================
export interface OpsTemplate {
  id: string;
  title: string;
  body: string;
  // draft 化したときの下書き種別（ops_drafts.kind）
  draftKind: "discord_post" | "x_post" | "note_article" | "event_report";
}

export const OPS_TEMPLATES: OpsTemplate[] = [
  {
    id: "weekly_plan",
    title: "📅 今週の予定",
    body: [
      "今週のまぶ鯖の予定です。",
      "",
      "{events}",
      "",
      "雑談のお題は毎日出しています。話したいときだけどうぞ。ROM専・覗くだけも歓迎です。",
    ].join("\n"),
    draftKind: "discord_post",
  },
  {
    id: "midweek_poll",
    title: "🗳️ みんなに質問",
    body: "{question}",
    draftKind: "discord_post",
  },
  {
    id: "weekend_event",
    title: "🎉 イベント告知",
    body: [
      "{title}",
      "",
      "日時: {datetime}",
      "場所: {place}",
      "参加方法: 募集メッセージのボタンで表明してください。",
      "",
      "初めての方もこの機会にどうぞ。",
    ].join("\n"),
    draftKind: "discord_post",
  },
  {
    id: "recruit_monthly",
    title: "🌙 メンバー募集中！",
    body: [
      "まぶ鯖は自分のペースで楽しめるDiscordコミュニティです。",
      "雑談 / ゲーム / 音楽 / 画像・動画 / スレッド自由。",
      "話したい時だけ話してOK、ROM専も歓迎です。",
      "",
      "初見さんも、Discord初めての人もどうぞ。",
      "参加はこちら: https://discord.gg/GKkW4wCAVp",
    ].join("\n"),
    draftKind: "discord_post",
  },
  {
    id: "weekly_review",
    title: "🌙 週の振り返り",
    body: [
      "今週もありがとうございました。",
      "",
      "・新規参加: {joined}人",
      "・よく賑わった場所: {top_channel}",
      "・イベント参加: {event_attendees}人",
      "",
      "来週も自分のペースでどうぞ。予定は月曜にお知らせします。",
    ].join("\n"),
    draftKind: "discord_post",
  },
  {
    id: "x_event",
    title: "🎉 イベント告知",
    body: [
      "🎉 イベント告知",
      "",
      "{title}",
      "日時: {datetime}",
      "場所: まぶ鯖 {place}",
      "参加方法: Discordの募集ボタンから",
      "",
      "初めての方もこの機会にどうぞ👇",
      "https://discord.gg/GKkW4wCAVp",
    ].join("\n"),
    draftKind: "x_post",
  },
  {
    id: "x_bot_intro",
    title: "🤖 Bot紹介",
    body: [
      "🤖 まぶ鯖のBot紹介",
      "",
      "{bot_name}: {feature}",
      "",
      "サーバーの中で使えます。気になったら覗いてみてください。",
      "https://discord.gg/GKkW4wCAVp",
    ].join("\n"),
    draftKind: "x_post",
  },
  {
    id: "note_monthly",
    title: "月刊まぶ鯖だより",
    body: [
      "# 月刊まぶ鯖だより",
      "",
      "## 今月のまぶ鯖",
      "",
      "- メンバー数: {member_count}人",
      "- 実施したイベント: {events}",
      "",
      "## 人気の話題",
      "",
      "（ここに今月の様子を加筆してください。個人が特定できる発言の引用は、本人の許可があるものだけにしてください）",
      "",
      "## 来月の予定",
      "",
      "{next_month}",
      "",
      "## 参加はこちら",
      "",
      "https://discord.gg/GKkW4wCAVp",
    ].join("\n"),
    draftKind: "note_article",
  },
  {
    id: "event_report",
    title: "イベントレポート",
    body: [
      "# {title} を開催しました",
      "",
      "- 日時: {datetime}",
      "- 参加人数: {attendees}人",
      "",
      "## 当日の様子",
      "",
      "（ここに当日の様子を加筆してください。スクショは参加者の許可とIDへの配慮を確認してから載せてください）",
      "",
      "## 次回予告",
      "",
      "次回もまぶ鯖でお知らせします。",
      "参加はこちら: https://discord.gg/GKkW4wCAVp",
    ].join("\n"),
    draftKind: "event_report",
  },
];

const TEMPLATE_BY_ID = new Map(OPS_TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id: string): OpsTemplate | null {
  return TEMPLATE_BY_ID.get(id) ?? null;
}

export function listTemplateIds(): string[] {
  return OPS_TEMPLATES.map((t) => t.id);
}

// ==========================================
// 🛡️ メンション無害化
// ==========================================
// 📝 利用者入力（イベント名・説明など）に含まれるメンション記法を
// 無効化する。@everyone / @here はゼロ幅スペースを挟んで発火を防ぎ、
// <@...> <@&...> 形式は表示用のプレーンテキストへ落とす。
// <#...> のチャンネル参照は通知を発しないため、そのまま残す。
export function sanitizeMentions(text: string): string {
  return text
    .replaceAll("@everyone", "@\u200beveryone")
    .replaceAll("@here", "@\u200bhere")
    .replace(/<@!?\d+>/g, "@ユーザー")
    .replace(/<@&\d+>/g, "@ロール");
}

// ==========================================
// 🖨️ テンプレートの描画
// ==========================================
// 📝 {name} 形式の変数を置換する。値は必ず sanitizeMentions を通す。
// 未指定の変数は空文字ではなく「（未設定）」として残し、運営者が
// 下書き段階で気づけるようにする（自動投稿では下書き経由が既定の
// テンプレートもあるため、黙って空になるより安全）。
export function renderTemplate(
  templateId: string,
  vars: Record<string, string | number> = {},
): { title: string; body: string; draftKind: OpsTemplate["draftKind"] } | null {
  const template = getTemplate(templateId);
  if (!template) return null;
  const fill = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (_whole, name: string) => {
      const value = vars[name];
      if (value === undefined) return "（未設定）";
      return sanitizeMentions(String(value));
    });
  return {
    title: fill(template.title),
    body: fill(template.body),
    draftKind: template.draftKind,
  };
}
