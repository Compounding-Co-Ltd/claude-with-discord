import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Remove system-reminder tags from text content.
 */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/**
 * Extract displayable text from an SDK assistant message.
 */
export function formatAssistantMessage(message: SDKMessage & { type: "assistant" }): string | null {
  const parts: string[] = [];

  for (const block of message.message.content) {
    if (block.type === "text") {
      const cleaned = stripSystemReminders(block.text);
      if (cleaned) {
        parts.push(cleaned);
      }
    } else if (block.type === "tool_use") {
      parts.push(formatToolUse(block.name, block.input));
    }
  }

  const text = parts.join("\n").trim();
  return text || null;
}

function formatToolUse(name: string, input: unknown): string {
  const inp = input as Record<string, unknown>;
  switch (name) {
    case "Bash":
      return `> \`$ ${truncate(String(inp.command ?? ""), 200)}\``;
    case "Read":
      return `> \`Reading ${inp.file_path}\``;
    case "Write":
      return `> \`Writing ${inp.file_path}\``;
    case "Edit":
      return `> \`Editing ${inp.file_path}\``;
    case "Glob":
      return `> \`Searching for ${inp.pattern}\``;
    case "Grep":
      return `> \`Grep: ${inp.pattern}\``;
    case "Task":
      return `> \`Spawning subagent: ${truncate(String(inp.description ?? ""), 100)}\``;
    default:
      return `> \`Using tool: ${name}\``;
  }
}

/**
 * Format a result message with cost info.
 */
export function formatResultMessage(
  message: SDKMessage & { type: "result" }
): string {
  if (message.subtype === "success") {
    const cost = message.total_cost_usd.toFixed(4);
    const turns = message.num_turns;
    return `---\n*Completed (${turns} turns, $${cost})*`;
  }

  const cost = message.total_cost_usd.toFixed(4);
  const errors = "errors" in message ? (message.errors as string[]).join(", ") : "unknown error";
  return `---\n*Error: ${message.subtype}* — ${errors}\n*Cost: $${cost}*`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

/**
 * Generate a thread title from the user's first message.
 * Discord thread names have a 100 character limit.
 */
export function generateThreadTitle(userMessage: string): string | null {
  // Remove system context if present
  let cleanMessage = userMessage;
  const userMessageMatch = userMessage.match(/\[User Message\]\n(.+)/s);
  if (userMessageMatch) {
    cleanMessage = userMessageMatch[1];
  }

  // Clean up the message
  cleanMessage = cleanMessage
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/\n+/g, " ") // Replace newlines with spaces
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();

  if (!cleanMessage) return null;

  // Discord thread name limit is 100 characters
  const maxLength = 100;
  if (cleanMessage.length <= maxLength) {
    return cleanMessage;
  }

  // Truncate at word boundary
  const truncated = cleanMessage.slice(0, maxLength - 3);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.5) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated + "...";
}
