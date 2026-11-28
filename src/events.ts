// ==========================================
// 🎧 イベント登録
// ==========================================
// 📝 mabubot-ops が購読するイベントは、日次集計の件数カウント、
// メンバー参加（ウェルカム・自動ロール）、ボタン操作（投票・募集・
// 下書き承認）。元 mabubot にあったメッセージ処理（スパム対策・
// XP付与）は mabubot-guard / mabubot-play へ分離済み。

// ------------------------------------------
// 📥 インポート
// ------------------------------------------
import type { Client } from "discord.js";
import type { MabusabaStore } from "./store.js";
import { applyAutorole, sendWelcome } from "./welcome.js";
import { handlePollButton } from "./poll.js";
import { handleRecruitButton } from "./recruit.js";
import { handleDraftButton } from "./ops.js";
import { jstDateString } from "./stats.js";

// ==========================================
// 📝 イベント登録
// ==========================================
export function registerEvents(client: Client, store: MabusabaStore): void {
  // ----------------------------------------
  // 📊 日次集計（件数だけを数える。本文は保存しない）
  // ----------------------------------------
  client.on("messageCreate", (message) => {
    try {
      if (!message.guildId || message.author.bot) return;
      store.incrementOpsMessage(
        message.guildId,
        jstDateString(Date.now()),
        message.channelId,
      );
    } catch (error) {
      console.error("ops stats message counting failed", error);
    }
  });
  client.on("guildMemberRemove", (member) => {
    try {
      if (member.user.bot) return;
      store.incrementOpsStats(
        member.guild.id,
        jstDateString(Date.now()),
        "left",
      );
    } catch (error) {
      console.error("ops stats leave counting failed", error);
    }
  });

  // ----------------------------------------
  // 👋 メンバー参加（ウェルカム・自動ロール）
  // ----------------------------------------
  client.on("guildMemberAdd", async (member) => {
    try {
      if (!member.user.bot) {
        store.incrementOpsStats(
          member.guild.id,
          jstDateString(Date.now()),
          "joined",
        );
        store.setOpsMemberCount(
          member.guild.id,
          jstDateString(Date.now()),
          member.guild.memberCount,
        );
      }
    } catch (error) {
      console.error("ops stats join counting failed", error);
    }
    // 📌 このリスナーには例外を受け取る呼び出し側がいないため、未処理の
    // rejection がプロセスを落とし得る。ウェルカムと自動ロールは
    // 個別に保護し（片方の失敗でもう片方を飛ばさない）、リスナー
    // 全体も包む。
    try {
      if (member.user.bot) return;
      try {
        await sendWelcome(member, store);
      } catch (error) {
        console.error(
          `[mabubot-ops] welcome failed for ${member.id} in ${member.guild.id}:`,
          error,
        );
      }
      try {
        await applyAutorole(member, store);
      } catch (error) {
        console.error(
          `[mabubot-ops] autorole failed for ${member.id} in ${member.guild.id}:`,
          error,
        );
      }
    } catch (error) {
      console.error("guildMemberAdd handler failed", error);
    }
  });

  // ----------------------------------------
  // 🔘 ボタン操作（投票・募集・下書き承認）
  // ----------------------------------------
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    try {
      if (interaction.customId.startsWith("poll:"))
        await handlePollButton(interaction, store);
      else if (interaction.customId.startsWith("recruit:"))
        await handleRecruitButton(interaction, store);
      else if (interaction.customId.startsWith("opsdraft:"))
        await handleDraftButton(interaction, client, store);
    } catch (error) {
      console.error("button interaction failed", error);
      if (!interaction.replied) {
        await interaction
          .reply({ content: "処理に失敗しました。", ephemeral: true })
          .catch(() => undefined);
      }
    }
  });
}
