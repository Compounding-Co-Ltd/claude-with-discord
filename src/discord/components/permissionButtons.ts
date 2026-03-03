import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";

export function createPermissionButtons(
  toolUseId: string
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`permission:allow:${toolUseId}`)
      .setLabel("Allow")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`permission:allow_always:${toolUseId}`)
      .setLabel("Always Allow")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`permission:deny:${toolUseId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
  );
}

// Max content length to leave room for formatting (``` markers, etc.)
const MAX_CONTENT_LENGTH = 1800;

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n... (truncated)";
}

export function formatPermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
  decisionReason?: string
): string {
  let message = `**Permission Required: \`${toolName}\`**\n`;

  if (decisionReason) {
    message += `\n> ${decisionReason}\n`;
  }

  // Format input based on tool type
  if (toolName === "Bash" && input.command) {
    const command = truncate(String(input.command), MAX_CONTENT_LENGTH);
    message += `\n\`\`\`bash\n${command}\n\`\`\``;
  } else if (toolName === "Edit" && input.file_path) {
    message += `\nFile: \`${input.file_path}\``;
  } else if (toolName === "Write" && input.file_path) {
    message += `\nFile: \`${input.file_path}\``;
  } else if (toolName === "Read" && input.file_path) {
    message += `\nFile: \`${input.file_path}\``;
  } else if (toolName === "AskUserQuestion") {
    // AskUserQuestion is handled separately - don't show as permission request
    return "";
  } else {
    // Generic formatting for other tools
    const inputStr = JSON.stringify(input, null, 2);
    if (inputStr.length < 500) {
      message += `\n\`\`\`json\n${inputStr}\n\`\`\``;
    }
  }

  return message;
}

/**
 * Check if a tool is AskUserQuestion.
 */
export function isAskUserQuestion(toolName: string): boolean {
  return toolName === "AskUserQuestion";
}
