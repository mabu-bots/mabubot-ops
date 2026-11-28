// ==========================================
// 🗓️ 運営スケジューラー
// ==========================================
// 📝 決まった曜日・時刻にテンプレート投稿や下書き生成を自動実行する
// （運営自動化設計書 v1.1 の実装）。時刻はすべて日本時間で判定し、
// 実行環境のタイムゾーンに依存しない。ティックは1分間隔。
// 実行の中身（投稿・下書き生成・集計確定）は execute コールバックに
// 注入し、判定・冪等・失敗回数の管理はここに閉じる（テストでは
// 偽の execute で全体を検証できる）。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import type { MabusabaStore, OpsScheduleRow } from "./store.js";
import {
  isLastSundayOfMonth,
  jstDateString,
  jstParts,
  parseScheduleTime,
} from "./stats.js";

// ==========================================
// 🔍 実行可否の判定（純粋関数）
// ==========================================
// 📝 スケジュールの冪等キー。日次・週次は「その日」をキーにし、
// 同じ日に二重実行しない。手動実行は manual: を付けて通常の
// キーと分ける（手動で試しても定時の実行が潰れないように）。
export function runKeyFor(nowMs: number): string {
  return jstDateString(nowMs);
}

// そのスケジュールが nowMs の時点で実行すべきか。
// - 有効であること
// - 種別・曜日が今日（JST）に合うこと
// - 予定時刻を過ぎていること
// - 今日分をまだ実行していないこと（last_run_key との比較）
// Bot が止まっていた間に過ぎた分は、同日中なら復帰後にここで
// 拾われる（キャッチアップ）。日を跨いだ分は翌日の判定では
// 対象にならず、自然に skipped 扱いになる。
export function isScheduleDue(
  schedule: OpsScheduleRow,
  nowMs: number,
): boolean {
  if (!schedule.enabled) return false;
  const time = parseScheduleTime(schedule.time);
  if (!time) return false;
  const now = jstParts(nowMs);
  if (schedule.kind === "monthly_report") {
    if (!isLastSundayOfMonth(nowMs)) return false;
  } else if (schedule.days && schedule.days.length) {
    if (!schedule.days.includes(now.weekday)) return false;
  }
  if (now.h < time.h || (now.h === time.h && now.mi < time.mi)) return false;
  if (schedule.last_run_key === runKeyFor(nowMs)) return false;
  return true;
}

// ==========================================
// 🚦 投稿レート制限
// ==========================================
// 📝 スケジューラー全体で1サーバーあたり1時間に最大 N 投稿まで。
// 超えた分は捨てず、呼び出し側が次回ティックへ回す前提で
// 「今は出せない」ことだけを返す（設計書 §7.2）。
export class HourlyRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly limit = 4) {}

  canAcquire(guildId: string, nowMs: number): boolean {
    const windowStart = nowMs - 3_600_000;
    const kept = (this.hits.get(guildId) ?? []).filter((t) => t > windowStart);
    this.hits.set(guildId, kept);
    return kept.length < this.limit;
  }

  acquire(guildId: string, nowMs: number): boolean {
    if (!this.canAcquire(guildId, nowMs)) return false;
    const kept = this.hits.get(guildId) ?? [];
    kept.push(nowMs);
    this.hits.set(guildId, kept);
    return true;
  }
}

// ==========================================
// ⚙️ スケジューラー本体
// ==========================================
export type ScheduleExecuteResult =
  | { status: "success" | "pending_approval"; detail?: string }
  | { status: "failed"; detail?: string };

export interface SchedulerDeps {
  store: MabusabaStore;
  execute: (
    schedule: OpsScheduleRow,
    nowMs: number,
  ) => Promise<ScheduleExecuteResult>;
  // 投稿を伴う種別だけレート制限にかけるための判定。
  // 既定では stats_daily 以外を投稿扱いにする。
  isPostingKind?: (kind: string) => boolean;
  rateLimiter?: HourlyRateLimiter;
  onError?: (schedule: OpsScheduleRow, error: unknown) => void;
}

export class OpsScheduler {
  private readonly rateLimiter: HourlyRateLimiter;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SchedulerDeps) {
    this.rateLimiter = deps.rateLimiter ?? new HourlyRateLimiter(4);
  }

  // ----------------------------------------
  // 🔁 1回分のティック
  // ----------------------------------------
  // due なスケジュールを拾って順に実行する。1件の失敗で残りを
  // 止めない。戻り値は今回実行したスケジュール ID の一覧。
  async tick(nowMs = Date.now()): Promise<string[]> {
    const executed: string[] = [];
    for (const schedule of this.deps.store.listOpsSchedules()) {
      if (!isScheduleDue(schedule, nowMs)) continue;
      const ran = await this.runSchedule(schedule, runKeyFor(nowMs), nowMs);
      if (ran) executed.push(schedule.id);
    }
    return executed;
  }

  // ----------------------------------------
  // ▶️ 手動実行
  // ----------------------------------------
  // /ops run 用。due 判定を飛ばし、冪等キーを手動用に分ける。
  async runNow(scheduleId: string, nowMs = Date.now()): Promise<boolean> {
    const schedule = this.deps.store.getOpsSchedule(scheduleId);
    if (!schedule) return false;
    return this.runSchedule(schedule, `manual:${nowMs}`, nowMs, true);
  }

  private async runSchedule(
    schedule: OpsScheduleRow,
    runKey: string,
    nowMs: number,
    manual = false,
  ): Promise<boolean> {
    const store = this.deps.store;
    // 冪等: 実行履歴に同じキーがあれば二重実行しない（手動は除く）
    if (
      !manual &&
      !store.tryCreateOpsRun(schedule.id, schedule.guild_id, runKey, nowMs)
    ) {
      return false;
    }
    const isPosting = this.deps.isPostingKind
      ? this.deps.isPostingKind(schedule.kind)
      : schedule.kind !== "stats_daily";
    if (isPosting && !this.rateLimiter.acquire(schedule.guild_id, nowMs)) {
      store.finishOpsRun(schedule.id, runKey, "skipped", "rate limited", nowMs);
      return false;
    }
    let result: ScheduleExecuteResult;
    try {
      result = await this.deps.execute(schedule, nowMs);
    } catch (error) {
      this.deps.onError?.(schedule, error);
      result = { status: "failed", detail: String(error) };
    }
    if (manual) {
      // 手動実行は履歴テーブルに通常キーで残さない代わりに、
      // 実行結果だけを last_status へ反映する（runKey は更新しない）
      store.recordOpsScheduleResult(schedule.id, result.status, null, nowMs);
    } else {
      store.finishOpsRun(
        schedule.id,
        runKey,
        result.status,
        result.detail ?? "",
        nowMs,
      );
      store.recordOpsScheduleResult(
        schedule.id,
        result.status,
        result.status === "failed" ? null : runKey,
        nowMs,
      );
    }
    return true;
  }

  // ----------------------------------------
  // 🚀 定期実行の開始・停止
  // ----------------------------------------
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        console.error("[mabubot-ops] scheduler tick failed:", error);
      });
    }, intervalMs);
    this.timer.unref();
    // 起動直後にも1回ティックし、同日分のキャッチアップを早める
    void this.tick().catch((error: unknown) => {
      console.error("[mabubot-ops] scheduler initial tick failed:", error);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ==========================================
// 📋 標準スケジュール
// ==========================================
// 📝 設計書 §3.2 の週間カレンダー。チャンネルが決まっているサーバー
// に対して /ops schedule defaults から一括登録する。
export interface DefaultScheduleSpec {
  kind: string;
  days: number[] | null;
  time: string;
  templateId: string;
  mode: "auto" | "draft";
}

export function buildDefaultSchedules(): DefaultScheduleSpec[] {
  return [
    // 月 19:00 今週の予定（#お知らせ想定のチャンネルへ）
    {
      kind: "announce",
      days: [1],
      time: "19:00",
      templateId: "weekly_plan",
      mode: "auto",
    },
    // 水 19:00 軽い企画の下書き（承認してから出す）
    {
      kind: "announce",
      days: [3],
      time: "19:00",
      templateId: "midweek_poll",
      mode: "draft",
    },
    // 金 19:00 週末告知の下書き
    {
      kind: "announce",
      days: [5],
      time: "19:00",
      templateId: "weekend_event",
      mode: "draft",
    },
    // 日 20:00 週の振り返り（数字入りなので承認制）
    {
      kind: "weekly_review",
      days: [0],
      time: "20:00",
      templateId: "weekly_review",
      mode: "draft",
    },
    // 毎日 23:55 日次集計の確定（投稿なし）
    {
      kind: "stats_daily",
      days: null,
      time: "23:55",
      templateId: "weekly_review",
      mode: "auto",
    },
    // 月末の日曜 21:00 月報の下書き
    {
      kind: "monthly_report",
      days: null,
      time: "21:00",
      templateId: "note_monthly",
      mode: "draft",
    },
  ];
}
