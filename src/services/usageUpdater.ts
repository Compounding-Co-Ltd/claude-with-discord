import type { Client, Message, TextChannel } from "discord.js";
import { fetchUsageInfo, formatUsageEmbed } from "./usageService.js";
import { createNewSessionButton } from "../discord/components/newSessionButton.js";

// Channel ID for claude-with-discord project
const CLAUDE_CODE_CHANNEL_ID = "1472468552916275342";
const UPDATE_INTERVAL_MS = 60_000; // 1 minute

let updateInterval: ReturnType<typeof setInterval> | null = null;
let trackedMessageId: string | null = null;

/**
 * Start the usage updater for the special channel
 */
export function startUsageUpdater(client: Client): void {
  if (updateInterval) {
    clearInterval(updateInterval);
  }

  updateInterval = setInterval(async () => {
    await updateUsageMessage(client);
  }, UPDATE_INTERVAL_MS);

  console.log("Usage updater started (1 minute interval)");
}

/**
 * Stop the usage updater
 */
export function stopUsageUpdater(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}

/**
 * Update the usage message in the special channel
 */
async function updateUsageMessage(client: Client): Promise<void> {
  if (!trackedMessageId) return;

  try {
    const channel = await client.channels.fetch(CLAUDE_CODE_CHANNEL_ID);
    if (!channel || !("messages" in channel)) return;

    const textChannel = channel as TextChannel;
    const message = await textChannel.messages.fetch(trackedMessageId).catch(() => null);
    if (!message) {
      trackedMessageId = null;
      return;
    }

    const usage = await fetchUsageInfo();
    if (!usage) return;

    const content = formatSessionMessageWithUsage(usage);
    await message.edit({
      content,
      components: [createNewSessionButton()],
    });
  } catch (err) {
    console.error("Failed to update usage message:", err);
  }
}

/**
 * Format the session message with usage info
 */
function formatSessionMessageWithUsage(usage: ReturnType<typeof fetchUsageInfo> extends Promise<infer T> ? T : never): string {
  if (!usage) {
    return "**Claude Code Session**";
  }

  const usageEmbed = formatUsageEmbed(usage);
  return `**Claude Code Session**\n\n${usageEmbed}`;
}

/**
 * Send the initial button message to a channel
 * For the special channel, include usage info
 */
export async function sendButtonToChannelWithUsage(
  client: Client,
  channelId: string
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !("send" in channel) || !("messages" in channel)) return;

    const textChannel = channel as TextChannel;

    // Delete previous bot messages with the button to avoid duplicates
    const messages = await textChannel.messages.fetch({ limit: 10 });
    const botButtonMessages = messages.filter(
      (m) => m.author.id === client.user?.id && m.components.length > 0
    );
    for (const msg of botButtonMessages.values()) {
      await msg.delete().catch(() => {});
    }

    // Check if this is the special channel
    if (channelId === CLAUDE_CODE_CHANNEL_ID) {
      const usage = await fetchUsageInfo();
      const content = usage
        ? `**Claude Code Session**\n\n${formatUsageEmbed(usage)}`
        : "**Claude Code Session**";

      const sentMessage = await textChannel.send({
        content,
        components: [createNewSessionButton()],
      });

      // Track this message for updates
      trackedMessageId = sentMessage.id;
      console.log(`Sent session button with usage to channel ${channelId}`);
    } else {
      // Regular channel - just send button
      await textChannel.send({
        content: "**Claude Code Session**",
        components: [createNewSessionButton()],
      });
      console.log(`Sent new session button to channel ${channelId}`);
    }
  } catch (err) {
    console.error(`Failed to send button to channel ${channelId}:`, err);
  }
}

/**
 * Check if a channel is the special Claude Code channel
 */
export function isClaudeCodeChannel(channelId: string): boolean {
  return channelId === CLAUDE_CODE_CHANNEL_ID;
}

/**
 * Get the tracked message ID
 */
export function getTrackedMessageId(): string | null {
  return trackedMessageId;
}
