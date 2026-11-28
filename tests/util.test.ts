// ==========================================
// 🧪 テスト: ユーティリティ・ガード・ストア基礎
// ==========================================

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCommandExecLog,
  generateId,
  joinLinesWithinLimit,
  parseTimeInput,
} from "../src/util.js";
import { MabusabaStore } from "../src/store.js";
import {
  MAX_WELCOME_MESSAGE_LENGTH,
  hasManageGuildPermission,
  isRoleAssignableByBot,
  renderWelcomeMessage,
  strongPermissionLabels,
} from "../src/welcome.js";
import { PermissionFlagsBits, type GuildMember } from "discord.js";

// ------------------------------------------
// 🛠️ テスト用ヘルパー
// ------------------------------------------
const NOW = Date.UTC(2026, 10, 14, 3, 0, 0);
const jst = (h: number, m = 0, day = 14): number =>
  Date.UTC(2026, 10, day, h - 9, m, 0);

// ==========================================
// 🕑 parseTimeInput
// ==========================================
describe("parseTimeInput (future, JST)", () => {
  it("parses relative future times", () => {
    assert.equal(parseTimeInput("30分後", NOW), NOW + 1_800_000);
    assert.equal(parseTimeInput("2時間後", NOW), NOW + 7_200_000);
    assert.equal(parseTimeInput("1時間30分後", NOW), NOW + 5_400_000);
  });

  it("parses weeks in relative future times", () => {
    assert.equal(parseTimeInput("1週間後", NOW), NOW + 7 * 86_400_000);
    assert.equal(parseTimeInput("2週後", NOW), NOW + 14 * 86_400_000);
    assert.equal(parseTimeInput("1週間2日後", NOW), NOW + 9 * 86_400_000);
  });

  it("rejects relative times with stray text", () => {
    assert.equal(parseTimeInput("abc30分後", NOW), null);
    assert.equal(parseTimeInput("30分xyz後", NOW), null);
    assert.equal(parseTimeInput("30分30分後", NOW), null);
  });

  it("parses clock times today, or tomorrow when past", () => {
    assert.equal(parseTimeInput("21:00", NOW), jst(21));
    assert.equal(parseTimeInput("10:00", NOW), jst(10, 0, 15));
  });

  it("parses a full-width colon in clock times", () => {
    assert.equal(parseTimeInput("21：00", NOW), jst(21));
  });

  it("parses dated times", () => {
    assert.equal(parseTimeInput("2026-11-14 21:00", NOW), jst(21));
    assert.equal(parseTimeInput("11-14 21:00", NOW), jst(21));
  });

  it("rolls a past month/day to next year", () => {
    assert.equal(
      parseTimeInput("11-13 21:00", NOW),
      Date.UTC(2027, 10, 13, 12, 0, 0),
    );
    assert.equal(
      parseTimeInput("1-1 10:00", NOW),
      Date.UTC(2027, 0, 1, 1, 0, 0),
    );
  });

  it("rejects past times and garbage", () => {
    assert.equal(parseTimeInput("2026-11-13 21:00", NOW), null);
    assert.equal(parseTimeInput("あした", NOW), null);
    assert.equal(parseTimeInput("", NOW), null);
  });
});

// ==========================================
// 🆔 generateId
// ==========================================
describe("generateId", () => {
  it("produces unique ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    assert.equal(ids.size, 1000);
  });
});

// ==========================================
// 📏 joinLinesWithinLimit
// ==========================================
describe("joinLinesWithinLimit", () => {
  it("keeps short lists intact and truncates long ones", () => {
    assert.deepEqual(joinLinesWithinLimit(["a", "b"], 100), {
      text: "a\nb",
      omitted: 0,
    });
    const lines = Array.from({ length: 10 }, () => "x".repeat(100));
    const { text, omitted } = joinLinesWithinLimit(lines, 350);
    assert.ok(text.length <= 350);
    assert.ok(omitted > 0);
  });
});

// ==========================================
// 🛡️ ウェルカム・自動ロールのガード
// ==========================================
describe("welcome / autorole guards", () => {
  const fakeMember = (guildName: string): GuildMember =>
    ({
      id: "123456789012345678",
      guild: { name: guildName, memberCount: 42 },
    }) as unknown as GuildMember;

  it("truncates the rendered welcome message to the embed limit", () => {
    // {server} の繰り返しで短いテンプレートが 4,096 字をはるかに超える
    const rendered = renderWelcomeMessage(
      "{server}".repeat(200),
      fakeMember("あ".repeat(100)),
    );
    assert.ok(rendered.length <= MAX_WELCOME_MESSAGE_LENGTH);
    assert.ok(rendered.endsWith("…"));
    assert.equal(
      renderWelcomeMessage(null, fakeMember("テスト鯖")),
      "ようこそ テスト鯖 へ、<@123456789012345678> さん！ 42人目のメンバーです 🎉",
    );
  });

  it("checks ManageGuild on memberPermissions", () => {
    assert.equal(
      hasManageGuildPermission({
        has: (flag) => flag === PermissionFlagsBits.ManageGuild,
      }),
      true,
    );
    assert.equal(hasManageGuildPermission({ has: () => false }), false);
    assert.equal(hasManageGuildPermission(null), false);
    assert.equal(hasManageGuildPermission(undefined), false);
  });

  it("only allows roles below the bot's highest role", () => {
    assert.equal(isRoleAssignableByBot(3, 5), true);
    assert.equal(isRoleAssignableByBot(5, 5), false);
    assert.equal(isRoleAssignableByBot(6, 5), false);
  });

  it("labels strong permissions from bitfield and raw string forms", () => {
    assert.deepEqual(
      strongPermissionLabels({
        has: (flag: bigint) => flag === PermissionFlagsBits.Administrator,
      }),
      ["管理者"],
    );
    const raw = String(
      PermissionFlagsBits.ManageRoles | PermissionFlagsBits.BanMembers,
    );
    assert.deepEqual(strongPermissionLabels(raw), [
      "ロールの管理",
      "メンバーのBAN",
    ]);
    assert.deepEqual(strongPermissionLabels("0"), []);
  });
});

// ==========================================
// 🗄️ ストア
// ==========================================
describe("store (SQLite)", () => {
  it("welcome, autoroles, polls, recruits and timers round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "mabubot-ops-test-"));
    const store = new MabusabaStore(dir);
    try {
      store.setWelcome("g1", "c1", "ようこそ {user} さん");
      assert.equal(store.getWelcome("g1")?.channel_id, "c1");
      store.deleteWelcome("g1");
      assert.equal(store.getWelcome("g1"), null);

      assert.equal(store.addAutorole("g1", "r1"), true);
      assert.equal(store.addAutorole("g1", "r1"), false);
      assert.equal(store.addAutorole("g1", "r2"), true);
      assert.deepEqual(store.getAutoroles("g1"), ["r1", "r2"]);
      assert.equal(store.removeAutorole("g1", "r1"), true);
      assert.deepEqual(store.getAutoroles("g1"), ["r2"]);
      store.deleteAutorole("g1");
      assert.deepEqual(store.getAutoroles("g1"), []);

      store.createPoll({
        id: "p1",
        guild_id: "g1",
        channel_id: "c1",
        message_id: "m1",
        question: "好きなのは？",
        options: ["A", "B"],
        ends_at_ms: NOW + 60000,
        created_by: "u1",
      });
      // DB-first 作成: message_id は空で始まり UPDATE で埋まる
      store.updatePollMessageId("p1", "m1-updated");
      assert.equal(store.getPoll("p1")?.message_id, "m1-updated");
      store.setPollVote("p1", "u1", 0);
      store.setPollVote("p1", "u2", 1);
      store.setPollVote("p1", "u1", 1); // 投票の変更
      assert.deepEqual(store.pollVoteCounts("p1", 2), [0, 2]);
      assert.equal(store.pollTotalVotes("p1"), 2);
      assert.equal(store.listOpenPolls().length, 1);
      store.closePoll("p1");
      assert.equal(store.listOpenPolls().length, 0);

      store.createRecruit({
        id: "rc1",
        guild_id: "g1",
        channel_id: "c1",
        message_id: "m2",
        title: "テスト募集",
        max_members: 4,
        starts_at_ms: NOW + 3600000,
        description: null,
        created_by: "u1",
      });
      store.updateRecruitMessageId("rc1", "m2-updated");
      assert.equal(store.getRecruit("rc1")?.message_id, "m2-updated");
      store.addRecruitMember("rc1", "u1");
      store.addRecruitMember("rc1", "u1"); // 重複は無視される
      store.addRecruitMember("rc1", "u2");
      assert.deepEqual(store.listRecruitMembers("rc1"), ["u1", "u2"]);
      store.removeRecruitMember("rc1", "u1");
      assert.deepEqual(store.listRecruitMembers("rc1"), ["u2"]);
      assert.equal(store.listOpenRecruits().length, 1);
      store.closeRecruit("rc1");
      assert.equal(store.listOpenRecruits().length, 0);

      // DB-first 作成後に公開メッセージの送信が失敗したときの巻き戻し
      store.createPoll({
        id: "p2",
        guild_id: "g1",
        channel_id: "c1",
        message_id: "",
        question: "送信失敗時の巻き戻し",
        options: ["A", "B"],
        ends_at_ms: NOW + 60000,
        created_by: "u1",
      });
      store.deletePoll("p2");
      assert.equal(store.getPoll("p2"), null);
      store.createRecruit({
        id: "rc2",
        guild_id: "g1",
        channel_id: "c1",
        message_id: "",
        title: "送信失敗時の巻き戻し",
        max_members: 4,
        starts_at_ms: NOW + 3600000,
        description: null,
        created_by: "u1",
      });
      store.deleteRecruit("rc2");
      assert.equal(store.getRecruit("rc2"), null);

      store.createTimer({
        id: "t1",
        guild_id: "g1",
        channel_id: "c1",
        user_id: "u1",
        message: "テスト",
        fires_at_ms: NOW + 60000,
        created_at_ms: NOW,
      });
      assert.equal(store.listTimers("g1").length, 1);
      store.deleteTimer("t1");
      assert.equal(store.listTimers("g1").length, 0);
    } finally {
      store.close();
    }
  });
});

// ==========================================
// 📋 コマンド実行ログ（formatCommandExecLog）
// ==========================================
describe("formatCommandExecLog", () => {
  const now = new Date("2026-11-23T00:00:00.000Z");
  const base = {
    commandName: "ping",
    route: "slash" as const,
    guildId: "g1",
    channelId: "c1",
    userId: "u1",
    now,
  };

  it("formats a successful execution in the fleet-wide format", () => {
    assert.equal(
      formatCommandExecLog(base),
      "[exec] 2026-11-23T00:00:00.000Z cmd=ping route=slash guild=g1 channel=c1 user=u1 result=ok",
    );
  });

  it("uses - for missing guild/channel (e.g. DM)", () => {
    const line = formatCommandExecLog({
      ...base,
      guildId: null,
      channelId: null,
    });
    assert.ok(line.includes("guild=- channel=-"));
    assert.ok(line.endsWith("result=ok"));
  });

  it("appends a single-line error summary on failure", () => {
    const line = formatCommandExecLog({
      ...base,
      error: new Error('boom\n"quoted"  details'),
    });
    assert.ok(line.includes("result=error"));
    assert.ok(line.endsWith('error="boom quoted details"'));
    assert.ok(!line.includes("\n"));
  });

  it("stringifies non-Error failures", () => {
    const line = formatCommandExecLog({ ...base, error: "plain failure" });
    assert.ok(line.endsWith('error="plain failure"'));
  });
});
