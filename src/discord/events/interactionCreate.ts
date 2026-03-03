import {
  type Interaction,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ModalActionRowComponentBuilder,
} from "discord.js";
import type { AppConfig, SessionMode } from "../../types.js";
import { getConfig } from "../../config.js";
import type { SessionManager } from "../../claude/sessionManager.js";
import { createNewSessionButton } from "../components/newSessionButton.js";
import { createModeButtons } from "../components/modeButtons.js";

export function handleInteractionCreate(_config: AppConfig, sessionManager: SessionManager) {
  return async (interaction: Interaction) => {
    // Handle modal submissions (for custom question input)
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;
      if (customId.startsWith("question_modal:")) {
        const parts = customId.split(":");
        const toolUseId = parts[1];
        const questionIndex = parseInt(parts[2], 10);
        const customAnswer = interaction.fields.getTextInputValue("custom_answer");

        const channel = interaction.channel;
        if (!channel || (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)) {
          return;
        }

        const handled = await sessionManager.handleQuestionResponse(channel.id, toolUseId, questionIndex, customAnswer, channel);

        if (handled) {
          // Update the original message
          if (interaction.message) {
            await interaction.message.edit({
              content: `${interaction.message.content}\n\n*Selected: ${customAnswer}*`,
              components: [],
            });
          }
          await interaction.deferUpdate();
        } else {
          await interaction.reply({
            content: "*This question has expired or was already answered.*",
            ephemeral: true,
          });
        }
      }
      return;
    }

    // Handle select menu interactions
    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;
      if (customId.startsWith("question_select:")) {
        const parts = customId.split(":");
        const toolUseId = parts[1];
        const questionIndex = parseInt(parts[2], 10);

        const channel = interaction.channel;
        if (!channel || (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)) {
          return;
        }

        // Check if "other" was selected
        if (interaction.values.includes("other")) {
          // Show modal for custom input
          const modal = createCustomInputModal(toolUseId, questionIndex);
          await interaction.showModal(modal);
          return;
        }

        // Get selected option labels from session
        const selectedValues = interaction.values;
        const handled = await sessionManager.handleQuestionSelectResponse(channel.id, toolUseId, questionIndex, selectedValues, channel);

        if (handled) {
          // Get the selected labels for display
          const session = sessionManager.getSession(channel.id);
          const questions = session?.pendingPermission?.questions;
          const selectedLabels = selectedValues.map((v) => {
            const idx = parseInt(v, 10);
            if (isNaN(idx)) return v;
            return questions?.[questionIndex]?.options?.[idx]?.label ?? v;
          });
          await interaction.update({
            content: `${interaction.message.content}\n\n*Selected: ${selectedLabels.join(", ")}*`,
            components: [],
          });
        } else {
          await interaction.reply({
            content: "*This question has expired or was already answered.*",
            ephemeral: true,
          });
        }
      }
      return;
    }

    if (!interaction.isButton()) return;

    // Get fresh config for hot-reload support
    const config = getConfig();

    // Check user whitelist
    if (config.allowed_users.length > 0 && !config.allowed_users.includes(interaction.user.id)) {
      await interaction.reply({ content: "*You are not authorized to use this button.*", ephemeral: true });
      return;
    }

    const customId = interaction.customId;

    // Handle new session button (in parent channel, not thread)
    if (customId === "new_session") {
      const parentChannel = interaction.channel;
      if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
        await interaction.reply({
          content: "*This button can only be used in a text channel.*",
          ephemeral: true,
        });
        return;
      }

      // Check if this channel is mapped to a project
      const projectPath = config.channel_project_map[parentChannel.id];
      if (!projectPath) {
        await interaction.reply({
          content: "*This channel is not configured for Claude sessions.*",
          ephemeral: true,
        });
        return;
      }

      // Defer update to acknowledge the interaction without sending a message
      await interaction.deferUpdate();

      // Create a new thread
      const timestamp = new Date().toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const threadName = `Session ${timestamp}`;

      const thread = await parentChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 60,
      });

      // Delete the old button message and send a new one at the bottom
      try {
        await interaction.message?.delete();
      } catch {
        // Message might already be deleted
      }

      await parentChannel.send({
        content: "**Claude Code Session**",
        components: [createNewSessionButton()],
      });

      // Send initial message in thread with mode buttons
      await thread.send({
        content: "*Session ready. Send a message to start.*",
        components: [createModeButtons("action")],
      });

      return;
    }

    // Other button handlers require thread context
    const channel = interaction.channel;
    if (!channel || (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)) {
      return;
    }

    if (customId === "end_session") {
      // Use deferUpdate instead of deferReply to avoid "thinking..." message
      // that can't be deleted after thread is archived
      await interaction.deferUpdate();
      await sessionManager.endSession(channel.id, channel);
      return;
    }

    // Handle mode buttons
    if (customId.startsWith("mode_")) {
      const mode = customId.replace("mode_", "") as SessionMode;
      await interaction.deferUpdate();
      await sessionManager.setMode(channel.id, mode, channel);
      return;
    }

    // Handle question option buttons
    if (customId.startsWith("question:")) {
      const parts = customId.split(":");
      const toolUseId = parts[1];
      const questionIndex = parseInt(parts[2], 10);
      const optionValue = parts[3];

      // Check if "other" was selected - show modal for custom input
      if (optionValue === "other") {
        const modal = createCustomInputModal(toolUseId, questionIndex);
        await interaction.showModal(modal);
        return;
      }

      const optionIndex = parseInt(optionValue, 10);

      // Get the label before handling (since session state may change)
      const session = sessionManager.getSession(channel.id);
      const questions = session?.pendingPermission?.questions;
      const selectedLabel = questions?.[questionIndex]?.options?.[optionIndex]?.label ?? `Option ${optionIndex + 1}`;

      const handled = await sessionManager.handleQuestionResponse(channel.id, toolUseId, questionIndex, optionIndex, channel);

      if (handled) {
        await interaction.update({
          content: `${interaction.message.content}\n\n*Selected: ${selectedLabel}*`,
          components: [],
        });
      } else {
        await interaction.reply({
          content: "*This question has expired or was already answered.*",
          ephemeral: true,
        });
      }
      return;
    }

    // Handle question cancel button
    if (customId.startsWith("question_cancel:")) {
      const toolUseId = customId.split(":")[1];
      const handled = sessionManager.handleQuestionCancel(channel.id, toolUseId);

      if (handled) {
        await interaction.update({
          content: `${interaction.message.content}\n\n*Cancelled*`,
          components: [],
        });
      } else {
        await interaction.reply({
          content: "*This question has expired or was already handled.*",
          ephemeral: true,
        });
      }
      return;
    }

    // Handle permission buttons
    if (customId.startsWith("permission:")) {
      const parts = customId.split(":");
      const action = parts[1] as "allow" | "allow_always" | "deny";
      const toolUseId = parts[2];

      const handled = sessionManager.handlePermissionResponse(channel.id, toolUseId, action);

      if (handled) {
        const actionText =
          action === "allow"
            ? "Allowed"
            : action === "allow_always"
              ? "Always allowed"
              : "Denied";
        await interaction.update({
          content: `${interaction.message.content}\n\n*${actionText}*`,
          components: [],
        });
      } else {
        await interaction.reply({
          content: "*This permission request has expired or was already handled.*",
          ephemeral: true,
        });
      }
    }
  };
}

function createCustomInputModal(toolUseId: string, questionIndex: number): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`question_modal:${toolUseId}:${questionIndex}`)
    .setTitle("Custom Answer");

  const textInput = new TextInputBuilder()
    .setCustomId("custom_answer")
    .setLabel("Enter your answer")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  const actionRow = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(textInput);
  modal.addComponents(actionRow);

  return modal;
}
