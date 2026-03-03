import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export function createEndSessionButton() {
  const button = new ButtonBuilder()
    .setCustomId("end_session")
    .setLabel("End Session")
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  return row;
}
