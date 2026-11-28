// ==========================================
// 🗄️ SQLite ストア
// ==========================================
// 📝 Bot の全状態を SQLite ファイル1つに保存する（Node 標準の
// node:sqlite を使用し、ネイティブ依存を持たない）。
// 既定の保存先は data/mabubot-ops.db。旧実装（v0.2.1）とスキーマは
// 互換で、本番 DB をそのまま読み続けられる。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDatabase } from "./backup.js";

// ==========================================
// 📐 行データの型定義
// ==========================================
export interface WelcomeRow {
  guild_id: string;
  channel_id: string;
  message: string | null;
}

export interface PollRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  question: string;
  options: string[];
  ends_at_ms: number;
  created_by: string;
  closed: number;
}

export interface RecruitRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  title: string;
  max_members: number;
  starts_at_ms: number;
  description: string | null;
  created_by: string;
  closed: number;
}

export interface TimerRow {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  message: string;
  fires_at_ms: number;
  created_at_ms: number;
}

export interface OpsScheduleRow {
  id: string;
  guild_id: string;
  kind: string;
  days: number[] | null;
  time: string;
  channel_id: string | null;
  template_id: string;
  params: Record<string, string>;
  mode: "auto" | "draft";
  enabled: boolean;
  last_run_key: string | null;
  last_status: string | null;
  fail_streak: number;
  created_at: string;
}

export interface OpsDraftRow {
  id: number;
  guild_id: string;
  kind: string;
  title: string | null;
  body: string;
  target_channel_id: string | null;
  status: "pending" | "approved" | "rejected" | "published";
  published_url: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface OpsStatsDailyRow {
  guild_id: string;
  date: string;
  member_count: number | null;
  joined: number;
  left: number;
  message_count: number;
  top_channels: Array<{ channel_id: string; count: number }>;
  events_held: number;
  event_attendees: number;
}

// ==========================================
// 🗄️ ストア本体
// ==========================================
export class MabusabaStore {
  private db: DatabaseSync;

  // ----------------------------------------
  // 🏗️ 初期化
  // ----------------------------------------
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "mabubot-ops.db");
    this.db = new DatabaseSync(dbPath);
    // WAL + synchronous NORMAL: コミットを軽くし、この Bot の
    // アクセスパターン（単一書き手）では読み取りを妨げない。
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    // 🔄 旧形式の自動ロールテーブル（主キーが guild_id のみ＝ギルドに
    // 1件）を、複数形式（主キー guild_id + role_id）へ移行する。
    // 既存の設定は引き継ぐ。
    const autoroleSql = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'autorole'",
      )
      .get() as { sql: string } | undefined;
    if (autoroleSql?.sql.includes("guild_id TEXT PRIMARY KEY")) {
      this.db.exec(`
        CREATE TABLE autorole_new (
          guild_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, role_id)
        );
        INSERT INTO autorole_new (guild_id, role_id, updated_at)
          SELECT guild_id, role_id, updated_at FROM autorole;
        DROP TABLE autorole;
        ALTER TABLE autorole_new RENAME TO autorole;
      `);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS welcome (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autorole (
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );
      CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        ends_at_ms INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS poll_votes (
        poll_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        option_idx INTEGER NOT NULL,
        PRIMARY KEY (poll_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS recruits (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        title TEXT NOT NULL,
        max_members INTEGER NOT NULL,
        starts_at_ms INTEGER NOT NULL,
        description TEXT,
        created_by TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS recruit_members (
        recruit_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        PRIMARY KEY (recruit_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message TEXT NOT NULL,
        fires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_polls_open ON polls (closed, ends_at_ms);
      CREATE INDEX IF NOT EXISTS idx_recruits_open ON recruits (closed, starts_at_ms);
      CREATE TABLE IF NOT EXISTS ops_schedules (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        days TEXT,
        time TEXT NOT NULL,
        channel_id TEXT,
        template_id TEXT NOT NULL,
        params TEXT,
        mode TEXT NOT NULL DEFAULT 'auto',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_key TEXT,
        last_status TEXT,
        fail_streak INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        run_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        detail TEXT,
        UNIQUE(schedule_id, run_key)
      );
      CREATE TABLE IF NOT EXISTS ops_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        body TEXT NOT NULL,
        target_channel_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        published_url TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
      );
      CREATE TABLE IF NOT EXISTS ops_stats_daily (
        guild_id TEXT NOT NULL,
        date TEXT NOT NULL,
        member_count INTEGER,
        joined INTEGER NOT NULL DEFAULT 0,
        left_count INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        top_channels TEXT NOT NULL DEFAULT '[]',
        events_held INTEGER NOT NULL DEFAULT 0,
        event_attendees INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_ops_schedules_guild ON ops_schedules (guild_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_ops_drafts_guild ON ops_drafts (guild_id, status);
    `);
    // 💾 起動時バックアップ: DB を data/backups/<timestamp>/ へコピーし、
    // 直近の世代だけを残す（backup.ts）。バックアップの失敗で起動自体は
    // 止めない。
    try {
      const backupPath = backupDatabase(this.db, dbPath);
      if (backupPath) {
        console.log(`[mabubot-ops] database backup: ${backupPath}`);
      }
    } catch (error) {
      console.warn("[mabubot-ops] database backup failed:", error);
    }
  }

  // ----------------------------------------
  // 👋 ウェルカム
  // ----------------------------------------
  getWelcome(guildId: string): WelcomeRow | null {
    const row = this.db
      .prepare(
        "SELECT guild_id, channel_id, message FROM welcome WHERE guild_id = ?",
      )
      .get(guildId) as WelcomeRow | undefined;
    return row ?? null;
  }

  setWelcome(guildId: string, channelId: string, message: string | null): void {
    this.db
      .prepare(
        `INSERT INTO welcome (guild_id, channel_id, message, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message = excluded.message, updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, message, new Date().toISOString());
  }

  deleteWelcome(guildId: string): void {
    this.db.prepare("DELETE FROM welcome WHERE guild_id = ?").run(guildId);
  }

  // ----------------------------------------
  // 🎭 自動ロール（ギルドごとに複数）
  // ----------------------------------------
  getAutoroles(guildId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT role_id FROM autorole WHERE guild_id = ? ORDER BY updated_at, role_id",
      )
      .all(guildId) as Array<{ role_id: string }>;
    return rows.map((r) => r.role_id);
  }

  // 1件追加する。既に設定済みなら false を返す。
  addAutorole(guildId: string, roleId: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO autorole (guild_id, role_id, updated_at) VALUES (?, ?, ?)",
      )
      .run(guildId, roleId, new Date().toISOString());
    return result.changes === 1;
  }

  // 1件解除する。設定されていなければ false を返す。
  removeAutorole(guildId: string, roleId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM autorole WHERE guild_id = ? AND role_id = ?")
      .run(guildId, roleId);
    return result.changes === 1;
  }

  // ギルドの自動ロールをすべて解除する。
  deleteAutorole(guildId: string): void {
    this.db.prepare("DELETE FROM autorole WHERE guild_id = ?").run(guildId);
  }

  // ----------------------------------------
  // 🗳️ 投票
  // ----------------------------------------
  createPoll(poll: Omit<PollRow, "closed">): void {
    this.db
      .prepare(
        "INSERT INTO polls (id, guild_id, channel_id, message_id, question, options, ends_at_ms, created_by, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        poll.id,
        poll.guild_id,
        poll.channel_id,
        poll.message_id,
        poll.question,
        JSON.stringify(poll.options),
        poll.ends_at_ms,
        poll.created_by,
      );
  }

  // 📌 投票は公開メッセージの送信「前」に DB へ登録する（送信失敗時に
  // ボタンが死んだままのメッセージを残さないため）。message_id は
  // 送信成功後にこのメソッドで埋める。
  updatePollMessageId(id: string, messageId: string): void {
    this.db
      .prepare("UPDATE polls SET message_id = ? WHERE id = ?")
      .run(messageId, id);
  }

  deletePoll(id: string): void {
    this.db.prepare("DELETE FROM poll_votes WHERE poll_id = ?").run(id);
    this.db.prepare("DELETE FROM polls WHERE id = ?").run(id);
  }

  getPoll(id: string): PollRow | null {
    const row = this.db.prepare("SELECT * FROM polls WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...(row as unknown as PollRow),
      options: JSON.parse(String(row.options)) as string[],
    };
  }

  listOpenPolls(): PollRow[] {
    const rows = this.db
      .prepare("SELECT * FROM polls WHERE closed = 0 ORDER BY ends_at_ms")
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as PollRow),
      options: JSON.parse(String(r.options)) as string[],
    }));
  }

  closePoll(id: string): void {
    this.db.prepare("UPDATE polls SET closed = 1 WHERE id = ?").run(id);
  }

  setPollVote(pollId: string, userId: string, optionIdx: number): void {
    this.db
      .prepare(
        `INSERT INTO poll_votes (poll_id, user_id, option_idx) VALUES (?, ?, ?)
         ON CONFLICT(poll_id, user_id) DO UPDATE SET option_idx = excluded.option_idx`,
      )
      .run(pollId, userId, optionIdx);
  }

  pollVoteCounts(pollId: string, optionCount: number): number[] {
    const counts = new Array<number>(optionCount).fill(0);
    const rows = this.db
      .prepare(
        "SELECT option_idx, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_idx",
      )
      .all(pollId) as unknown as Array<{ option_idx: number; n: number }>;
    for (const r of rows)
      if (r.option_idx >= 0 && r.option_idx < optionCount)
        counts[r.option_idx] = r.n;
    return counts;
  }

  pollTotalVotes(pollId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?")
      .get(pollId) as { n: number };
    return row.n;
  }

  // ----------------------------------------
  // 📣 募集
  // ----------------------------------------
  createRecruit(recruit: Omit<RecruitRow, "closed">): void {
    this.db
      .prepare(
        "INSERT INTO recruits (id, guild_id, channel_id, message_id, title, max_members, starts_at_ms, description, created_by, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        recruit.id,
        recruit.guild_id,
        recruit.channel_id,
        recruit.message_id,
        recruit.title,
        recruit.max_members,
        recruit.starts_at_ms,
        recruit.description,
        recruit.created_by,
      );
  }

  // 📌 募集も投票と同じ DB-first の順序（updatePollMessageId 参照）。
  updateRecruitMessageId(id: string, messageId: string): void {
    this.db
      .prepare("UPDATE recruits SET message_id = ? WHERE id = ?")
      .run(messageId, id);
  }

  deleteRecruit(id: string): void {
    this.db.prepare("DELETE FROM recruit_members WHERE recruit_id = ?").run(id);
    this.db.prepare("DELETE FROM recruits WHERE id = ?").run(id);
  }

  getRecruit(id: string): RecruitRow | null {
    const row = this.db
      .prepare("SELECT * FROM recruits WHERE id = ?")
      .get(id) as RecruitRow | undefined;
    return row ?? null;
  }

  listOpenRecruits(): RecruitRow[] {
    return this.db
      .prepare("SELECT * FROM recruits WHERE closed = 0 ORDER BY starts_at_ms")
      .all() as unknown as RecruitRow[];
  }

  closeRecruit(id: string): void {
    this.db.prepare("UPDATE recruits SET closed = 1 WHERE id = ?").run(id);
  }

  addRecruitMember(recruitId: string, userId: string, now = Date.now()): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO recruit_members (recruit_id, user_id, joined_at_ms) VALUES (?, ?, ?)",
      )
      .run(recruitId, userId, now);
  }

  removeRecruitMember(recruitId: string, userId: string): void {
    this.db
      .prepare(
        "DELETE FROM recruit_members WHERE recruit_id = ? AND user_id = ?",
      )
      .run(recruitId, userId);
  }

  listRecruitMembers(recruitId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT user_id FROM recruit_members WHERE recruit_id = ? ORDER BY joined_at_ms",
      )
      .all(recruitId) as unknown as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  // ----------------------------------------
  // ⏰ タイマー
  // ----------------------------------------
  createTimer(timer: TimerRow): void {
    this.db
      .prepare(
        "INSERT INTO timers (id, guild_id, channel_id, user_id, message, fires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        timer.id,
        timer.guild_id,
        timer.channel_id,
        timer.user_id,
        timer.message,
        timer.fires_at_ms,
        timer.created_at_ms,
      );
  }

  getTimer(id: string): TimerRow | null {
    const row = this.db.prepare("SELECT * FROM timers WHERE id = ?").get(id) as
      TimerRow | undefined;
    return row ?? null;
  }

  listTimers(guildId?: string): TimerRow[] {
    if (guildId) {
      return this.db
        .prepare("SELECT * FROM timers WHERE guild_id = ? ORDER BY fires_at_ms")
        .all(guildId) as unknown as TimerRow[];
    }
    return this.db
      .prepare("SELECT * FROM timers ORDER BY fires_at_ms")
      .all() as unknown as TimerRow[];
  }

  deleteTimer(id: string): void {
    this.db.prepare("DELETE FROM timers WHERE id = ?").run(id);
  }

  // ----------------------------------------
  // 🗓️ 運営スケジューラー
  // ----------------------------------------
  private parseScheduleRow(row: Record<string, unknown>): OpsScheduleRow {
    return {
      id: String(row.id),
      guild_id: String(row.guild_id),
      kind: String(row.kind),
      days: row.days ? (JSON.parse(String(row.days)) as number[]) : null,
      time: String(row.time),
      channel_id: row.channel_id ? String(row.channel_id) : null,
      template_id: String(row.template_id),
      params: row.params
        ? (JSON.parse(String(row.params)) as Record<string, string>)
        : {},
      mode: row.mode === "draft" ? "draft" : "auto",
      enabled: Number(row.enabled) === 1,
      last_run_key: row.last_run_key ? String(row.last_run_key) : null,
      last_status: row.last_status ? String(row.last_status) : null,
      fail_streak: Number(row.fail_streak ?? 0),
      created_at: String(row.created_at),
    };
  }

  createOpsSchedule(schedule: {
    id: string;
    guild_id: string;
    kind: string;
    days: number[] | null;
    time: string;
    channel_id: string | null;
    template_id: string;
    params?: Record<string, string>;
    mode: "auto" | "draft";
  }): void {
    this.db
      .prepare(
        `INSERT INTO ops_schedules (id, guild_id, kind, days, time, channel_id, template_id, params, mode, enabled, fail_streak, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
      )
      .run(
        schedule.id,
        schedule.guild_id,
        schedule.kind,
        schedule.days ? JSON.stringify(schedule.days) : null,
        schedule.time,
        schedule.channel_id,
        schedule.template_id,
        JSON.stringify(schedule.params ?? {}),
        schedule.mode,
        new Date().toISOString(),
      );
  }

  getOpsSchedule(id: string): OpsScheduleRow | null {
    const row = this.db
      .prepare("SELECT * FROM ops_schedules WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.parseScheduleRow(row) : null;
  }

  listOpsSchedules(guildId?: string): OpsScheduleRow[] {
    const rows = (guildId
      ? this.db
          .prepare(
            "SELECT * FROM ops_schedules WHERE guild_id = ? ORDER BY created_at, id",
          )
          .all(guildId)
      : this.db
          .prepare("SELECT * FROM ops_schedules ORDER BY created_at, id")
          .all()) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.parseScheduleRow(r));
  }

  setOpsScheduleEnabled(id: string, enabled: boolean): boolean {
    const result = this.db
      .prepare("UPDATE ops_schedules SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    return result.changes === 1;
  }

  deleteOpsSchedule(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM ops_schedules WHERE id = ?")
      .run(id);
    return result.changes === 1;
  }

  // 📝 実行結果の記録: 成功で失敗連続をリセットし、失敗は連続回数を
  // 増やして3回連続で自動一時停止する（設計書 §5.8）。runKey は
  // 成功／承認待ちのときだけ last_run_key に残す（失敗分は再試行できる）。
  recordOpsScheduleResult(
    id: string,
    status: string,
    runKey: string | null,
    _nowMs: number,
  ): OpsScheduleRow | null {
    const current = this.getOpsSchedule(id);
    if (!current) return null;
    const failStreak = status === "failed" ? current.fail_streak + 1 : 0;
    const enabled = failStreak >= 3 ? false : current.enabled;
    this.db
      .prepare(
        "UPDATE ops_schedules SET last_status = ?, last_run_key = COALESCE(?, last_run_key), fail_streak = ?, enabled = ? WHERE id = ?",
      )
      .run(status, runKey, failStreak, enabled ? 1 : 0, id);
    return this.getOpsSchedule(id);
  }

  // (schedule_id, run_key) が既に存在すれば false を返す（冪等判定）。
  tryCreateOpsRun(
    scheduleId: string,
    guildId: string,
    runKey: string,
    nowMs: number,
  ): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO ops_runs (schedule_id, guild_id, run_key, started_at, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run(scheduleId, guildId, runKey, new Date(nowMs).toISOString());
    return result.changes === 1;
  }

  finishOpsRun(
    scheduleId: string,
    runKey: string,
    status: string,
    detail: string,
    nowMs: number,
  ): void {
    this.db
      .prepare(
        "UPDATE ops_runs SET status = ?, detail = ?, finished_at = ? WHERE schedule_id = ? AND run_key = ?",
      )
      .run(status, detail, new Date(nowMs).toISOString(), scheduleId, runKey);
  }

  // ----------------------------------------
  // 📝 承認待ち下書き
  // ----------------------------------------
  createOpsDraft(draft: {
    guild_id: string;
    kind: string;
    title: string | null;
    body: string;
    target_channel_id: string | null;
  }): number {
    const result = this.db
      .prepare(
        "INSERT INTO ops_drafts (guild_id, kind, title, body, target_channel_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(
        draft.guild_id,
        draft.kind,
        draft.title,
        draft.body,
        draft.target_channel_id,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  private parseDraftRow(row: Record<string, unknown>): OpsDraftRow {
    return {
      id: Number(row.id),
      guild_id: String(row.guild_id),
      kind: String(row.kind),
      title: row.title ? String(row.title) : null,
      body: String(row.body),
      target_channel_id: row.target_channel_id
        ? String(row.target_channel_id)
        : null,
      status: String(row.status) as OpsDraftRow["status"],
      published_url: row.published_url ? String(row.published_url) : null,
      created_at: String(row.created_at),
      decided_at: row.decided_at ? String(row.decided_at) : null,
      decided_by: row.decided_by ? String(row.decided_by) : null,
    };
  }

  getOpsDraft(id: number): OpsDraftRow | null {
    const row = this.db
      .prepare("SELECT * FROM ops_drafts WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.parseDraftRow(row) : null;
  }

  listOpsDrafts(guildId: string, status?: string): OpsDraftRow[] {
    const rows = (status
      ? this.db
          .prepare(
            "SELECT * FROM ops_drafts WHERE guild_id = ? AND status = ? ORDER BY id DESC",
          )
          .all(guildId, status)
      : this.db
          .prepare(
            "SELECT * FROM ops_drafts WHERE guild_id = ? ORDER BY id DESC",
          )
          .all(guildId)) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.parseDraftRow(r));
  }

  // 📌 決定できるのは pending の下書きだけ（二重クリック・二重承認で
  // 二重投稿にならないように）。Discord 向け下書きの承認は投稿と
  // 一体の操作のため、approved → published の遷移も許可する。
  decideOpsDraft(
    id: number,
    status: "approved" | "rejected" | "published",
    decidedBy: string,
    publishedUrl: string | null = null,
  ): boolean {
    const result = this.db
      .prepare(
        "UPDATE ops_drafts SET status = ?, decided_by = ?, decided_at = ?, published_url = COALESCE(?, published_url) WHERE id = ? AND status = 'pending'",
      )
      .run(status, decidedBy, new Date().toISOString(), publishedUrl, id);
    if (result.changes === 1) return true;
    if (status === "published") {
      const second = this.db
        .prepare(
          "UPDATE ops_drafts SET status = 'published', published_url = COALESCE(?, published_url) WHERE id = ? AND status = 'approved'",
        )
        .run(publishedUrl, id);
      return second.changes === 1;
    }
    return false;
  }

  // ----------------------------------------
  // 📊 日次集計
  // ----------------------------------------
  private ensureStatsRow(guildId: string, date: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO ops_stats_daily (guild_id, date) VALUES (?, ?)",
      )
      .run(guildId, date);
  }

  incrementOpsStats(
    guildId: string,
    date: string,
    field: "joined" | "left" | "events_held" | "event_attendees",
    delta = 1,
  ): void {
    this.ensureStatsRow(guildId, date);
    const column =
      field === "left"
        ? "left_count"
        : field === "events_held"
          ? "events_held"
          : field === "event_attendees"
            ? "event_attendees"
            : "joined";
    this.db
      .prepare(
        `UPDATE ops_stats_daily SET ${column} = ${column} + ? WHERE guild_id = ? AND date = ?`,
      )
      .run(delta, guildId, date);
  }

  incrementOpsMessage(guildId: string, date: string, channelId: string): void {
    this.ensureStatsRow(guildId, date);
    const row = this.getOpsStatsDaily(guildId, date);
    const top = row ? [...row.top_channels] : [];
    const entry = top.find((e) => e.channel_id === channelId);
    if (entry) entry.count += 1;
    else top.push({ channel_id: channelId, count: 1 });
    top.sort((a, b) => b.count - a.count);
    this.db
      .prepare(
        "UPDATE ops_stats_daily SET message_count = message_count + 1, top_channels = ? WHERE guild_id = ? AND date = ?",
      )
      .run(JSON.stringify(top.slice(0, 10)), guildId, date);
  }

  setOpsMemberCount(guildId: string, date: string, count: number): void {
    this.ensureStatsRow(guildId, date);
    this.db
      .prepare(
        "UPDATE ops_stats_daily SET member_count = ? WHERE guild_id = ? AND date = ?",
      )
      .run(count, guildId, date);
  }

  private parseStatsRow(row: Record<string, unknown>): OpsStatsDailyRow {
    return {
      guild_id: String(row.guild_id),
      date: String(row.date),
      member_count:
        row.member_count === null || row.member_count === undefined
          ? null
          : Number(row.member_count),
      joined: Number(row.joined ?? 0),
      left: Number(row.left_count ?? 0),
      message_count: Number(row.message_count ?? 0),
      top_channels: JSON.parse(
        String(row.top_channels ?? "[]"),
      ) as OpsStatsDailyRow["top_channels"],
      events_held: Number(row.events_held ?? 0),
      event_attendees: Number(row.event_attendees ?? 0),
    };
  }

  getOpsStatsDaily(guildId: string, date: string): OpsStatsDailyRow | null {
    const row = this.db
      .prepare("SELECT * FROM ops_stats_daily WHERE guild_id = ? AND date = ?")
      .get(guildId, date) as Record<string, unknown> | undefined;
    return row ? this.parseStatsRow(row) : null;
  }

  listOpsStatsDaily(guildId: string, dates: string[]): OpsStatsDailyRow[] {
    return dates
      .map((d) => this.getOpsStatsDaily(guildId, d))
      .filter((r): r is OpsStatsDailyRow => r !== null);
  }

  // ----------------------------------------
  // 🔚 終了処理
  // ----------------------------------------
  close(): void {
    this.db.close();
  }
}
