import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { Question } from "../../types.js";

export type { Question };

/**
 * Create select menu or buttons for a question.
 * Uses buttons for 2-4 options, select menu for more.
 */
export function createQuestionComponents(
  toolUseId: string,
  questionIndex: number,
  question: Question
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  // For questions with 2-4 options, use buttons
  if (question.options.length <= 4) {
    const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();

    for (let i = 0; i < question.options.length; i++) {
      const opt = question.options[i];
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`question:${toolUseId}:${questionIndex}:${i}`)
          .setLabel(truncateLabel(opt.label, 80))
          .setStyle(ButtonStyle.Primary)
      );
    }

    // Add "Other" button
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`question:${toolUseId}:${questionIndex}:other`)
        .setLabel("Other")
        .setStyle(ButtonStyle.Secondary)
    );

    rows.push(buttonRow);
  } else {
    // For more options, use select menu
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`question_select:${toolUseId}:${questionIndex}`)
      .setPlaceholder("Select an option...")
      .setMinValues(1)
      .setMaxValues(question.multiSelect ? question.options.length : 1)
      .addOptions(
        question.options.map((opt, i) => ({
          label: truncateLabel(opt.label, 100),
          value: String(i),
          description: opt.description ? truncateLabel(opt.description, 100) : undefined,
        }))
      )
      .addOptions({
        label: "Other",
        value: "other",
        description: "Provide a custom answer",
      });

    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(selectMenu));
  }

  return rows;
}

/**
 * Create a submit button for multi-question forms.
 */
export function createQuestionSubmitButton(
  toolUseId: string
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`question_submit:${toolUseId}`)
      .setLabel("Submit Answers")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`question_cancel:${toolUseId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * Format an AskUserQuestion request for display.
 */
export function formatQuestionMessage(questions: Question[]): string {
  let message = "";

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    message += `**${q.header}**: ${q.question}\n`;

    if (q.options.length <= 4) {
      // Options will be shown as buttons, but list them for clarity
      for (const opt of q.options) {
        message += `- **${opt.label}**`;
        if (opt.description) {
          message += `: ${opt.description}`;
        }
        message += "\n";
      }
    }

    if (i < questions.length - 1) {
      message += "\n";
    }
  }

  return message;
}

function truncateLabel(label: string, maxLength: number): string {
  if (label.length <= maxLength) return label;
  return label.substring(0, maxLength - 3) + "...";
}
