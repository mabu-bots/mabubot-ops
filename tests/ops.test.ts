// ==========================================
// 🧪 テスト: テンプレート・集計ヘルパー・スケジューラー・ops ストア
// ==========================================

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MabusabaStore, type OpsScheduleRow } from "../src/store.js";
import {
  getTemplate,
  listTemplateIds,
  renderTemplate,
  sanitizeMentions,
} from "../src/templates.js";
import {
  isLastSundayOfMonth,
  jstDateString,
  parseScheduleTime,
  recentDateStrings,
  summarizeStats,
} from "../src/stats.js";
import {
  HourlyRateLimiter,
  OpsScheduler,
  buildDefaultSchedules,
  isScheduleDue,
  runKeyFor,
} from "../src/scheduler.js";

// ------------------------------------------
// 🛠️ テスト用ヘルパー
// ------------------------------------------
// 2026-11-16（月）12:00 JST = 2026-11-16 03:00 UTC
const MON_NOON = Date.UTC(2026, 10, 16, 3, 0, 0);
// 2026-11-29（日）12:00 JST（11月の最終日曜）
const LAST_SUN_NOON = Date.UTC(2026, 10, 29, 3, 0, 0);
// 2026-11-22（日）12:00 JST（最終ではない日曜）
const SUN_NOON = Date.UTC(2026, 10, 22, 3, 0, 0);

function makeStore(): { store: MabusabaStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mabubot-ops-sched-"));
  return { store: new MabusabaStore(dir), dir };
}

function makeSchedule(
  store: MabusabaStore,
  overrides: Partial<Parameters<MabusabaStore["createOpsSchedule"]>[0]> = {},
): OpsScheduleRow {
  const id = overrides.id ?? `sched-${Math.random().toString(36).slice(2, 9)}`;
  store.createOpsSchedule({
    id,
    guild_id: "g1",
    kind: "announce",
    days: [1],
    time: "19:00",
    channel_id: "c1",
    template_id: "weekly_plan",
    mode: "auto",
    ...overrides,
  });
  return store.getOpsSchedule(id)!;
}

// ==========================================
// 🧩 テンプレート
// ==========================================
describe("templates", () => {
  it("has all appendix-A templates", () => {
    for (const id of [
      "weekly_plan",
      "midweek_poll",
      "weekend_event",
      "recruit_monthly",
      "weekly_review",
      "x_event",
      "x_bot_intro",
      "note_monthly",
      "event_report",
    ]) {
      assert.ok(getTemplate(id), id);
    }
    assert.equal(listTemplateIds().length, 9);
  });

  it("renders variables and marks missing ones", () => {
    const rendered = renderTemplate("weekend_event", {
      title: "ゲーム大会",
      datetime: "11月21日（土）19:00",
      place: "雑談VC",
    });
    assert.ok(rendered?.body.includes("ゲーム大会"));
    assert.ok(rendered?.body.includes("11月21日"));
    const missing = renderTemplate("weekend_event", {});
    assert.ok(missing?.body.includes("（未設定）"));
    assert.equal(renderTemplate("no_such_template"), null);
  });

  it("sanitizes mentions in variables but keeps channel references", () => {
    assert.ok(!sanitizeMentions("@everyone").includes("@everyone"));
    assert.ok(!sanitizeMentions("@here").includes("@here"));
    assert.equal(sanitizeMentions("<@123456>"), "@ユーザー");
    assert.equal(sanitizeMentions("<@&123456>"), "@ロール");
    assert.equal(sanitizeMentions("<#123456>"), "<#123456>");
    const rendered = renderTemplate("x_event", {
      title: "@everyone 大会",
      datetime: "19:00",
      place: "VC",
    });
    assert.ok(!rendered?.body.includes("@everyone 大会"));
  });
});

// ==========================================
// 🕐 時刻・日付ヘルパー
// ==========================================
describe("stats time helpers", () => {
  it("formats JST dates regardless of environment timezone", () => {
    // 2026-11-16 03:00 UTC = 12:00 JST on the same day.
    assert.equal(jstDateString(MON_NOON), "2026-11-16");
    // 2026-11-15 16:00 UTC = 2026-11-16 01:00 JST (next day).
    assert.equal(jstDateString(Date.UTC(2026, 10, 15, 16, 0, 0)), "2026-11-16");
  });

  it("detects the last Sunday of a month", () => {
    assert.equal(isLastSundayOfMonth(LAST_SUN_NOON), true);
    assert.equal(isLastSundayOfMonth(SUN_NOON), false);
    assert.equal(isLastSundayOfMonth(MON_NOON), false);
  });

  it("parses schedule times strictly", () => {
    assert.deepEqual(parseScheduleTime("19:00"), { h: 19, mi: 0 });
    assert.deepEqual(parseScheduleTime("9:05"), { h: 9, mi: 5 });
    assert.equal(parseScheduleTime("24:00"), null);
    assert.equal(parseScheduleTime("19:60"), null);
    assert.equal(parseScheduleTime("19時"), null);
  });

  it("lists recent date strings oldest-first", () => {
    assert.deepEqual(recentDateStrings(MON_NOON, 3), [
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
    ]);
  });
});

// ==========================================
// 🔍 スケジュール判定
// ==========================================
describe("isScheduleDue", () => {
  it("is due on the right weekday after the time, once per day", () => {
    const { store } = makeStore();
    try {
      const schedule = makeSchedule(store);
      // 月曜 18:59 JST: まだ
      assert.equal(
        isScheduleDue(schedule, Date.UTC(2026, 10, 16, 9, 59, 0)),
        false,
      );
      // 月曜 19:00 JST: due
      assert.equal(
        isScheduleDue(schedule, Date.UTC(2026, 10, 16, 10, 0, 0)),
        true,
      );
      // 火曜 19:00 JST: 曜日が違う
      assert.equal(
        isScheduleDue(schedule, Date.UTC(2026, 10, 17, 10, 0, 0)),
        false,
      );
      // 実行済みにすると同日は二度と due にならない
      store.recordOpsScheduleResult(
        schedule.id,
        "success",
        runKeyFor(Date.UTC(2026, 10, 16, 10, 0, 0)),
        Date.UTC(2026, 10, 16, 10, 0, 0),
      );
      const after = store.getOpsSchedule(schedule.id)!;
      assert.equal(
        isScheduleDue(after, Date.UTC(2026, 10, 16, 11, 0, 0)),
        false,
      );
    } finally {
      store.close();
    }
  });

  it("monthly_report only runs on the last Sunday", () => {
    const { store } = makeStore();
    try {
      const schedule = makeSchedule(store, {
        kind: "monthly_report",
        days: null,
        time: "21:00",
        template_id: "note_monthly",
        mode: "draft",
      });
      // 最終日曜 21:00 JST
      assert.equal(
        isScheduleDue(schedule, Date.UTC(2026, 10, 29, 12, 0, 0)),
        true,
      );
      // 最終でない日曜 21:00 JST
      assert.equal(
        isScheduleDue(schedule, Date.UTC(2026, 10, 22, 12, 0, 0)),
        false,
      );
    } finally {
      store.close();
    }
  });

  it("disabled schedules are never due", () => {
    const { store } = makeStore();
    try {
      const schedule = makeSchedule(store);
      store.setOpsScheduleEnabled(schedule.id, false);
      const off = store.getOpsSchedule(schedule.id)!;
      assert.equal(isScheduleDue(off, Date.UTC(2026, 10, 16, 10, 0, 0)), false);
    } finally {
      store.close();
    }
  });
});

// ==========================================
// 🚦 レート制限
// ==========================================
describe("HourlyRateLimiter", () => {
  it("allows up to the limit per guild per hour", () => {
    const limiter = new HourlyRateLimiter(4);
    const t0 = MON_NOON;
    for (let i = 0; i < 4; i++)
      assert.equal(limiter.acquire("g1", t0 + i), true);
    assert.equal(limiter.acquire("g1", t0 + 10), false);
    // 別サーバーは影響を受けない
    assert.equal(limiter.acquire("g2", t0 + 10), true);
    // 1時間経てば回復する
    assert.equal(limiter.acquire("g1", t0 + 3_600_001), true);
  });
});

// ==========================================
// ⚙️ スケジューラー本体
// ==========================================
describe("OpsScheduler", () => {
  it("runs due schedules once, records runs, and skips duplicates", async () => {
    const { store } = makeStore();
    try {
      const schedule = makeSchedule(store);
      let calls = 0;
      const scheduler = new OpsScheduler({
        store,
        execute: async () => {
          calls++;
          return { status: "success", detail: "ok" };
        },
      });
      const at = Date.UTC(2026, 10, 16, 10, 0, 0); // 月曜 19:00 JST
      assert.deepEqual(await scheduler.tick(at), [schedule.id]);
      assert.equal(calls, 1);
      // 同じ日に再度ティックしても実行しない（冪等）
      assert.deepEqual(await scheduler.tick(at + 60_000), []);
      assert.equal(calls, 1);
      const after = store.getOpsSchedule(schedule.id)!;
      assert.equal(after.last_status, "success");
      assert.equal(after.last_run_key, "2026-11-16");
    } finally {
      store.close();
    }
  });

  it("catches up a job missed earlier the same day", async () => {
    const { store } = makeStore();
    try {
      const schedule = makeSchedule(store);
      const scheduler = new OpsScheduler({
        store,
        execute: async () => ({ status: "success" }),
      });
      // 予定 19:00、Bot は 23:30 に復帰した想定でも同日中なら実行する
      const ran = await scheduler.tick(Date.UTC(2026, 10, 16, 14, 30, 0));
      assert.deepEqual(ran, [schedule.id]);
    } finally {
      store.close();
    }
  });

  it("auto-pauses after 3 consecutive failures", async () => {
    const { store } = makeStore();
    try {
      const schedule = makeSchedule(store, { days: null });
      const scheduler = new OpsScheduler({
        store,
        execute: async () => ({ status: "failed", detail: "boom" }),
      });
      // 手動実行で失敗を3回積む（手動は fail_streak にも反映される）
      await scheduler.runNow(schedule.id, MON_NOON);
      await scheduler.runNow(schedule.id, MON_NOON + 1000);
      const third = store.getOpsSchedule(schedule.id)!;
      assert.equal(third.fail_streak, 2);
      await scheduler.runNow(schedule.id, MON_NOON + 2000);
      const after = store.getOpsSchedule(schedule.id)!;
      assert.equal(after.fail_streak, 3);
      assert.equal(after.enabled, false);
    } finally {
      store.close();
    }
  });

  it("rate limit skips posting kinds but not stats_daily", async () => {
    const { store } = makeStore();
    try {
      const limiter = new HourlyRateLimiter(0); // 常に上限
      const posting = makeSchedule(store, { id: "posting1" });
      makeSchedule(store, {
        id: "stats1",
        kind: "stats_daily",
        days: null,
        time: "19:00",
        template_id: "weekly_review",
      });
      let executed: string[] = [];
      const scheduler = new OpsScheduler({
        store,
        rateLimiter: limiter,
        execute: async (s) => {
          executed.push(s.id);
          return { status: "success" };
        },
      });
      await scheduler.tick(Date.UTC(2026, 10, 16, 10, 0, 0));
      assert.deepEqual(executed, ["stats1"]);
      assert.ok(posting.id); // 参照だけ（投稿系は実行されていないこと上で確認済み）
    } finally {
      store.close();
    }
  });

  it("buildDefaultSchedules matches the design weekly calendar", () => {
    const specs = buildDefaultSchedules();
    assert.equal(specs.length, 6);
    assert.ok(
      specs.some((s) => s.templateId === "weekly_plan" && s.days?.includes(1)),
    );
    assert.ok(specs.some((s) => s.kind === "monthly_report"));
    assert.ok(
      specs.some((s) => s.kind === "stats_daily" && s.time === "23:55"),
    );
  });
});

// ==========================================
// 🗄️ ストア: スケジュール・下書き・集計
// ==========================================
describe("ops store", () => {
  it("schedules, drafts and stats round-trip", () => {
    const { store } = makeStore();
    try {
      const schedule = makeSchedule(store, {
        days: [1, 3, 5],
        params: { events: "なし" },
      });
      assert.deepEqual(schedule.days, [1, 3, 5]);
      assert.deepEqual(schedule.params, { events: "なし" });
      assert.equal(store.listOpsSchedules("g1").length, 1);
      assert.equal(store.listOpsSchedules("other").length, 0);

      // 実行履歴の冪等
      assert.equal(
        store.tryCreateOpsRun(schedule.id, "g1", "2026-11-16", MON_NOON),
        true,
      );
      assert.equal(
        store.tryCreateOpsRun(schedule.id, "g1", "2026-11-16", MON_NOON),
        false,
      );
      store.finishOpsRun(schedule.id, "2026-11-16", "success", "ok", MON_NOON);

      // 下書き: pending のときだけ決定でき、二重承認はできない
      const draftId = store.createOpsDraft({
        guild_id: "g1",
        kind: "x_post",
        title: "告知",
        body: "本文",
        target_channel_id: null,
      });
      assert.equal(store.getOpsDraft(draftId)?.status, "pending");
      assert.equal(store.decideOpsDraft(draftId, "approved", "u1"), true);
      assert.equal(store.decideOpsDraft(draftId, "approved", "u1"), false);
      assert.equal(store.listOpsDrafts("g1", "pending").length, 0);
      assert.equal(store.listOpsDrafts("g1", "approved").length, 1);

      // 集計: 発言・参加を積み上げる
      store.incrementOpsMessage("g1", "2026-11-16", "c1");
      store.incrementOpsMessage("g1", "2026-11-16", "c1");
      store.incrementOpsMessage("g1", "2026-11-16", "c2");
      store.incrementOpsStats("g1", "2026-11-16", "joined", 3);
      store.incrementOpsStats("g1", "2026-11-16", "events_held");
      store.setOpsMemberCount("g1", "2026-11-16", 42);
      const row = store.getOpsStatsDaily("g1", "2026-11-16")!;
      assert.equal(row.message_count, 3);
      assert.equal(row.joined, 3);
      assert.equal(row.member_count, 42);
      assert.deepEqual(row.top_channels[0], { channel_id: "c1", count: 2 });

      const summary = summarizeStats([row]);
      assert.equal(summary.topChannelId, "c1");
      assert.equal(summary.messageCount, 3);
    } finally {
      store.close();
    }
  });
});
