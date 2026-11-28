// ==========================================
// 📊 日次集計ヘルパー
// ==========================================
// 📝 日本時間の日付ヘルパーと、週次集計の要約を作る純粋関数群。
// 日次集計そのものの保存は store.ts（ops_stats_daily）が担う。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import type { OpsStatsDailyRow } from "./store.js";

// ==========================================
// 🗾 日本時間の日付ヘルパー
// ==========================================
// 📌 実行環境のタイムゾーンに依存しないよう、util.ts と同じく
// +9時間ずらして UTC ゲッターで読む方式で統一する。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface JstParts {
  y: number;
  mo: number;
  d: number;
  // 0=日曜 … 6=土曜
  weekday: number;
  h: number;
  mi: number;
}

export function jstParts(ms: number): JstParts {
  const date = new Date(ms + JST_OFFSET_MS);
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    weekday: date.getUTCDay(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
  };
}

export function jstDateString(ms: number): string {
  const p = jstParts(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

// 📅 その日が「月末の日曜日」か。7日後が翌月なら月末週の日曜日である。
export function isLastSundayOfMonth(ms: number): boolean {
  const p = jstParts(ms);
  if (p.weekday !== 0) return false;
  const sevenDaysLater = jstParts(ms + 7 * 86_400_000);
  return sevenDaysLater.mo !== p.mo;
}

// 🕐 "HH:MM" の検証と分解。不正な形式は null。
export function parseScheduleTime(
  text: string,
): { h: number; mi: number } | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

// ==========================================
// 📈 週次集計の要約
// ==========================================
// 📝 日次集計の行から、週次振り返りテンプレート用の変数を作る。
// 数字が無い週は呼び出し側で短文に切り替えるため、ここでは
// 素直に合計だけを返す。
export interface WeeklySummary {
  joined: number;
  left: number;
  messageCount: number;
  topChannelId: string | null;
  eventsHeld: number;
  eventAttendees: number;
}

export function summarizeStats(rows: OpsStatsDailyRow[]): WeeklySummary {
  const channelTotals = new Map<string, number>();
  const summary: WeeklySummary = {
    joined: 0,
    left: 0,
    messageCount: 0,
    topChannelId: null,
    eventsHeld: 0,
    eventAttendees: 0,
  };
  for (const row of rows) {
    summary.joined += row.joined;
    summary.left += row.left;
    summary.messageCount += row.message_count;
    summary.eventsHeld += row.events_held;
    summary.eventAttendees += row.event_attendees;
    for (const entry of row.top_channels) {
      channelTotals.set(
        entry.channel_id,
        (channelTotals.get(entry.channel_id) ?? 0) + entry.count,
      );
    }
  }
  let best = 0;
  for (const [channelId, count] of channelTotals) {
    if (count > best) {
      best = count;
      summary.topChannelId = channelId;
    }
  }
  return summary;
}

// 📅 直近 n 日分の日付文字列（JST、古い順）。集計の参照範囲に使う。
export function recentDateStrings(nowMs: number, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(jstDateString(nowMs - i * 86_400_000));
  }
  return out;
}
