// ==========================================
// 📢 スケジュールの実行（投稿・下書き生成・集計確定）
// ==========================================
// 📝 scheduler.ts の execute コールバックの本番実装。種別ごとの動作:
// - stats_daily: その日のメンバー数を確定させるだけ（投稿なし）
// - weekly_review: 直近7日の集計から変数を組み立てて描画する
// - monthly_report: 当月のメンバー数などを変数にする
// - それ以外 (announce 等): テンプレートをそのまま描画する
// mode が draft のものは投稿せず、下書きを作って承認待ちにする。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import type { Client } from "discord.js";
import type { MabusabaStore, OpsScheduleRow } from "./store.js";
import type { ScheduleExecuteResult } from "./scheduler.js";
import { renderTemplate } from "./templates.js";
import { recentDateStrings, summarizeStats } from "./stats.js";
import { EMBED_COLOR_INFO, buildEmbed } from "./util.js";

// ==========================================
// 📨 Discord への投稿
// ==========================================
// 📌 スケジューラーからの自動投稿は allowedMentions を空にし、
// テンプレートや変数から @everyone 等が発火しないようにする
// （設計書 §7.1）。
export async function postToChannel(
  client: Client,
  channelId: string,
  title: string,
  body: string,
): Promise<string> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    throw new Error(`channel ${channelId} is not sendable`);
  }
  const embed = buildEmbed(title, body, EMBED_COLOR_INFO);
  const message = await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
  return message.id;
}

// ==========================================
// ⚙️ 実行部の組み立て
// ==========================================
export function createScheduleExecutor(
  client: Client,
  store: MabusabaStore,
): (schedule: OpsScheduleRow, nowMs: number) => Promise<ScheduleExecuteResult> {
  return async (schedule, nowMs) => {
    if (schedule.kind === "stats_daily") {
      // メンバー数の確定は Guild の取得が必要。失敗しても集計の
      // 他項目は既に日々積み上がっているため、成功扱いで確定する。
      const date = recentDateStrings(nowMs, 1)[0];
      try {
        const guild = await client.guilds.fetch(schedule.guild_id);
        store.setOpsMemberCount(schedule.guild_id, date, guild.memberCount);
      } catch {
        // Guild が引けない場合はメンバー数なしで確定する
      }
      return { status: "success", detail: `stats finalized for ${date}` };
    }

    const vars: Record<string, string | number> = { ...schedule.params };
    if (schedule.kind === "weekly_review") {
      const rows = store.listOpsStatsDaily(
        schedule.guild_id,
        recentDateStrings(nowMs, 7),
      );
      const summary = summarizeStats(rows);
      vars.joined ??= summary.joined;
      vars.top_channel ??= summary.topChannelId
        ? `<#${summary.topChannelId}>`
        : "（集計なし）";
      vars.event_attendees ??= summary.eventAttendees;
    }
    if (schedule.kind === "monthly_report") {
      const rows = store.listOpsStatsDaily(
        schedule.guild_id,
        recentDateStrings(nowMs, 30),
      );
      const latest = [...rows].reverse().find((r) => r.member_count !== null);
      vars.member_count ??= latest?.member_count ?? "（未集計）";
      vars.events ??= `${rows.reduce((n, r) => n + r.events_held, 0)}件`;
      vars.next_month ??= "（来月の予定を加筆してください）";
    }

    const rendered = renderTemplate(schedule.template_id, vars);
    if (!rendered) {
      return {
        status: "failed",
        detail: `unknown template: ${schedule.template_id}`,
      };
    }

    if (schedule.mode === "draft") {
      const draftId = store.createOpsDraft({
        guild_id: schedule.guild_id,
        kind: rendered.draftKind,
        title: rendered.title,
        body: rendered.body,
        target_channel_id:
          rendered.draftKind === "discord_post" ? schedule.channel_id : null,
      });
      return { status: "pending_approval", detail: `draft #${draftId}` };
    }

    if (!schedule.channel_id) {
      return { status: "failed", detail: "channel_id is not set" };
    }
    const messageId = await postToChannel(
      client,
      schedule.channel_id,
      rendered.title,
      rendered.body,
    );
    return { status: "success", detail: `message ${messageId}` };
  };
}
