// ==========================================
// 🧪 テスト: プレゼンス・サイクル
// ==========================================

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRESENCE_SEND_LEAD_MS,
  formatElapsedMinutes,
  nextPresenceSend,
  presenceCycleText,
} from "../src/presence-cycle.js";

// ==========================================
// ⏱️ 経過時間の整形
// ==========================================
describe("formatElapsedMinutes", () => {
  it("formats minutes below an hour without padding", () => {
    assert.equal(formatElapsedMinutes(0), "0分");
    assert.equal(formatElapsedMinutes(26 * 60_000), "26分");
  });

  it("formats hours with zero-padded minutes", () => {
    assert.equal(formatElapsedMinutes(86 * 60_000), "1時間26分");
    assert.equal(formatElapsedMinutes(120 * 60_000), "2時間00分");
  });

  it("clamps negative values to zero", () => {
    assert.equal(formatElapsedMinutes(-1), "0分");
  });
});

// ==========================================
// 🎮 サイクルの文言と位相
// ==========================================
describe("presenceCycleText", () => {
  const startedAt = Date.UTC(2026, 10, 28, 0, 0, 0);

  it("shows elapsed time on even Unix-minute phases", () => {
    // 2026-11-28 01:26 UTC は Unix 分が偶数位相になるよう選んだ時刻
    const at = new Date(startedAt + 86 * 60_000);
    assert.equal(Math.floor(at.getTime() / 60_000) % 2, 0);
    assert.equal(
      presenceCycleText("mabubot-ops", startedAt, at),
      "mabubot-ops | 起動して 1時間26分",
    );
  });

  it("shows the current JST time on odd Unix-minute phases", () => {
    const at = new Date(startedAt + 87 * 60_000);
    assert.equal(Math.floor(at.getTime() / 60_000) % 2, 1);
    // 01:27 UTC = 10:27 JST
    assert.equal(
      presenceCycleText("mabubot-ops", startedAt, at),
      "mabubot-ops | 現在時刻 10:27 JST",
    );
  });
});

// ==========================================
// ⏰ 先行送信のスケジュール
// ==========================================
describe("nextPresenceSend", () => {
  it("sends 200ms before the next minute boundary", () => {
    const now = Date.UTC(2026, 10, 28, 0, 0, 30_000);
    const { sendAt, boundary } = nextPresenceSend(now);
    assert.equal(boundary, Date.UTC(2026, 10, 28, 0, 1, 0));
    assert.equal(sendAt, boundary - PRESENCE_SEND_LEAD_MS);
  });

  it("advances to the following boundary when the send time has passed", () => {
    // 境界の 100ms 前: 今分の送信予定（200ms 前）は既に過ぎている
    const now = Date.UTC(2026, 10, 28, 0, 0, 59_900);
    const { sendAt, boundary } = nextPresenceSend(now);
    assert.equal(boundary, Date.UTC(2026, 10, 28, 0, 2, 0));
    assert.ok(sendAt > now);
  });
});
