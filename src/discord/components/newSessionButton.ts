import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export function createNewSessionButton() {
  const button = new ButtonBuilder()
    .setCustomId("new_session")
    .setLabel("New Session")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  return row;
}
