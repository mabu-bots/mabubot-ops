// ==========================================
// 🧰 共通ユーティリティ
// ==========================================
// 埋め込み返信・時刻パース・ID 生成・実行ログなど、モジュール横断で
// 使う部品を集めたファイル。純粋関数は単体テスト（tests/util.test.ts）
// の対象になる。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import { randomBytes } from "node:crypto";
import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";

// ==========================================
// 🎨 埋め込みの共通部品
// ==========================================
// 📌 すべての返信は埋め込みで統一する（プレーンテキストは使わない）。
export const EMBED_COLOR_INFO = 0x5865f2;
export const EMBED_COLOR_SUCCESS = 0x57f287;
export const EMBED_COLOR_ERROR = 0xed4245;
export const EMBED_FOOTER = "✨ まぶさば";

export function buildEmbed(
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  fields?: Array<{ name: string; value: string; inline?: boolean }>,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: EMBED_FOOTER })
    .setTimestamp(new Date());
  if (fields?.length) embed.addFields(fields);
  return embed;
}

// 💬 コマンド返信はすべてここを通し、見た目を揃える。
// 限定表示（ephemeral）でも埋め込みはそのまま描画される。
// 応答済み・遅延済みのインタラクションには followUp を使う。
export async function replyEmbed(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  ephemeral = true,
  fields?: Array<{ name: string; value: string; inline?: boolean }>,
): Promise<void> {
  const embed = buildEmbed(title, description, color, fields);
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ embeds: [embed], ephemeral });
  } else {
    await interaction.reply({ embeds: [embed], ephemeral });
  }
}

// ==========================================
// ⏱️ 時間の表示整形
// ==========================================
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}日`);
  if (hours) parts.push(`${hours}時間`);
  if (minutes) parts.push(`${minutes}分`);
  // 上位の単位で割り切れる場合を除き、秒まで表示する
  if (seconds || !parts.length) parts.push(`${seconds}秒`);
  return parts.join("");
}

// 🕐 Discord のタイムスタンプ記法（絶対表示 / 相対表示）
export function discordTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

export function relativeTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

// ==========================================
// 🗾 日本時間ヘルパー
// ==========================================
// 📌 実行環境のタイムゾーンに依存しないよう、UTC に +9 時間ずらして
// UTC ゲッターで読む方式に統一する。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstParts(ms: number): {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
} {
  const date = new Date(ms + JST_OFFSET_MS);
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
    s: date.getUTCSeconds(),
  };
}

// JST の年月日時分秒 → epoch ms。存在しない日時（2月30日など）は
// 往復変換で検出して null を返す。
function jstToMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s = 0,
): number | null {
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31 ||
    h < 0 ||
    h > 23 ||
    mi < 0 ||
    mi > 59 ||
    s < 0 ||
    s > 59
  )
    return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - JST_OFFSET_MS;
  const back = jstParts(ms);
  if (
    back.y !== y ||
    back.mo !== mo ||
    back.d !== d ||
    back.h !== h ||
    back.mi !== mi ||
    back.s !== s
  )
    return null;
  return ms;
}

// ==========================================
// 🕑 時刻入力のパース
// ==========================================
// 📝 /recruit と /timer 用の未来時刻パース（すべて日本時間）。
// 受け付ける形式:
//   - 相対: `30分後` `2時間後` `1時間30分後` `3日後` `1週間後`
//   - 当日の時刻: `21:00`（過ぎていれば明日とみなす）
//   - 日付＋時刻: `2026-11-14 21:00` `2026/11/14 21:00` `11-14 21:00`
//     （月日だけの指定で今年分が過去なら来年とみなす）
//   - ISO 8601: `2026-11-14T21:00:00+09:00`
// 未来でない・解釈できない場合は null を返す。
export function parseTimeInput(input: string, now = Date.now()): number | null {
  const text = input
    .trim()
    .replace(/[０-９]/g, (c) => String("０１２３４５６７８９".indexOf(c)))
    .replace(/：/g, ":")
    .replace(/　/g, " ");
  if (!text) return null;

  // 相対指定（〜後）。単位をすべて消費しきることを要求し、
  // `abc30分後` や `30分xyz後` のような混入は弾く。
  const relative = text.match(/^(.+?)後$/);
  if (relative) {
    let rest = relative[1].replace(/\s+/g, "");
    const units: Array<[RegExp, number]> = [
      [/(\d+(?:\.\d+)?)(?:週間|週)/, 7 * 86400000],
      [/(\d+(?:\.\d+)?)日/, 86400000],
      [/(\d+(?:\.\d+)?)時間/, 3600000],
      [/(\d+(?:\.\d+)?)分/, 60000],
      [/(\d+(?:\.\d+)?)秒/, 1000],
    ];
    let deltaMs = 0;
    let matched = false;
    for (const [re, ms] of units) {
      const m = rest.match(re);
      if (m) {
        matched = true;
        deltaMs += Number(m[1]) * ms;
        rest = rest.replace(m[0], "");
      }
    }
    if (!matched || rest !== "" || !deltaMs) return null;
    return now + deltaMs;
  }

  let ms: number | null = null;
  const dated = text.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (dated) {
    ms = jstToMs(
      Number(dated[1]),
      Number(dated[2]),
      Number(dated[3]),
      Number(dated[4]),
      Number(dated[5]),
      Number(dated[6] ?? 0),
    );
  } else {
    const monthDay = text.match(
      /^(\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (monthDay) {
      ms = jstToMs(
        jstParts(now).y,
        Number(monthDay[1]),
        Number(monthDay[2]),
        Number(monthDay[3]),
        Number(monthDay[4]),
        Number(monthDay[5] ?? 0),
      );
      // 今年のその日付が既に過去なら来年とみなす（時刻のみ指定で
      // 過去なら明日、と同じ考え方）
      if (ms !== null && ms <= now) {
        ms = jstToMs(
          jstParts(now).y + 1,
          Number(monthDay[1]),
          Number(monthDay[2]),
          Number(monthDay[3]),
          Number(monthDay[4]),
          Number(monthDay[5] ?? 0),
        );
      }
    } else {
      const timeOnly = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (timeOnly) {
        const today = jstParts(now);
        ms = jstToMs(
          today.y,
          today.mo,
          today.d,
          Number(timeOnly[1]),
          Number(timeOnly[2]),
          Number(timeOnly[3] ?? 0),
        );
        // 当日の時刻が過ぎていれば明日とみなす
        if (ms !== null && ms <= now) ms += 86400000;
      } else {
        const parsed = Date.parse(text);
        ms = Number.isNaN(parsed) ? null : parsed;
      }
    }
  }
  if (ms === null || ms <= now) return null;
  return ms;
}

// ==========================================
// 🔧 汎用ユーティリティ
// ==========================================
// 🆔 投票・募集・タイマー・スケジュールの一意 ID。
// SQLite の主キーになり、ボタンの customId にも埋め込まれる。
// 旧方式（base36 時刻＋4桁の Math.random）は1ミリ秒あたり 9,000 通り
// しかなく、衝突すると送信済みメッセージの INSERT が失敗してボタンが
// 死んだまま残る事故につながった。48 ビットの暗号乱数で実質回避する。
export function generateId(): string {
  return `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

// 📏 埋め込みの説明文上限（4096字）を超えないよう行を詰める。
// 入りきらなかった行数は omitted で返し、呼び出し側が「他 N 件」と
// 注記できるようにする（返信自体を失敗させないため）。
export function joinLinesWithinLimit(
  lines: string[],
  maxChars = 3800,
): { text: string; omitted: number } {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length + (kept.length ? 1 : 0) + line.length;
    if (next > maxChars) break;
    kept.push(line);
    length = next;
  }
  return { text: kept.join("\n"), omitted: lines.length - kept.length };
}

// ==========================================
// 📋 コマンド実行ログ
// ==========================================
// 📝 コマンドが実行されるたびに標準出力へ1行残す（pm2 の out ログに残る形）。
// 書式は艦隊で統一する:
//   [exec] <ISO時刻> cmd=<名前> route=<slash|context|prefix>
//          guild=<ID> channel=<ID> user=<ID> result=<ok|error>
// 失敗時は末尾に error="<要点>" を付ける。記録するのはコマンド名・
// ID類・成否のみで、利用者の入力テキスト（オプション値やメッセージ
// 本文）は記録しない。ops_runs（スケジューラーの実行記録）とは別に、
// 「コマンドが呼ばれた事実」を残すための記録である。
export interface CommandExecLogInput {
  commandName: string;
  route: "slash" | "context" | "prefix";
  guildId: string | null;
  channelId: string | null;
  userId: string;
  error?: unknown;
  now?: Date;
}

export function formatCommandExecLog(input: CommandExecLogInput): string {
  const at = (input.now ?? new Date()).toISOString();
  const base =
    `[exec] ${at} cmd=${input.commandName} route=${input.route} ` +
    `guild=${input.guildId ?? "-"} channel=${input.channelId ?? "-"} ` +
    `user=${input.userId} result=${input.error ? "error" : "ok"}`;
  if (!input.error) return base;
  const raw =
    input.error instanceof Error ? input.error.message : String(input.error);
  // 1行書式を保つため、空白類と引用符を潰して短くする
  const summary = raw
    .replace(/[\s"]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${base} error="${summary}"`;
}

export function logCommandExec(input: CommandExecLogInput): void {
  console.log(formatCommandExecLog(input));
}
