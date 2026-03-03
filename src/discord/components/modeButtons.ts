import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export type SessionMode = "action" | "plan" | "ask";

export function createModeButtons(currentMode: SessionMode) {
  const planButton = new ButtonBuilder()
    .setCustomId("mode_plan")
    .setLabel("Plan")
    .setStyle(currentMode === "plan" ? ButtonStyle.Primary : ButtonStyle.Secondary);

  const askButton = new ButtonBuilder()
    .setCustomId("mode_ask")
    .setLabel("Ask")
    .setStyle(currentMode === "ask" ? ButtonStyle.Primary : ButtonStyle.Secondary);

  const actionButton = new ButtonBuilder()
    .setCustomId("mode_action")
    .setLabel("Action")
    .setStyle(currentMode === "action" ? ButtonStyle.Primary : ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(planButton, askButton, actionButton);

  return row;
}

export function getModeDescription(mode: SessionMode): string {
  switch (mode) {
    case "plan":
      return "Plan mode: Claude will analyze and create a plan without making changes.";
    case "ask":
      return "Ask mode: Claude will answer questions without making changes.";
    case "action":
      return "Action mode: Claude will execute tasks and make changes.";
  }
}
