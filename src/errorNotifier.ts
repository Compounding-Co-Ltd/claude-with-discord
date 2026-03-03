import { Client, TextChannel } from "discord.js";

// Error notification channel ID
const ERROR_CHANNEL_ID = "1472468552916275342";

let discordClient: Client | null = null;

export function setErrorNotifierClient(client: Client): void {
  discordClient = client;
}

export async function notifyError(
  type: "uncaughtException" | "unhandledRejection" | "discordError" | "discordWarn" | "custom",
  error: unknown,
  context?: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.stack || error.message : String(error);

  // Always log to console
  console.error(`[${timestamp}] ${type}:`, error);

  // Truncate error message for Discord (max 2000 chars)
  const maxLength = 1800;
  const truncatedError =
    errorMessage.length > maxLength ? errorMessage.slice(0, maxLength) + "\n... (truncated)" : errorMessage;

  const discordMessage = [
    `**[${type}]** ${timestamp}`,
    context ? `**Context:** ${context}` : null,
    "```",
    truncatedError,
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  // Try to send to Discord
  if (discordClient?.isReady()) {
    try {
      const channel = await discordClient.channels.fetch(ERROR_CHANNEL_ID);
      if (channel instanceof TextChannel) {
        await channel.send(discordMessage);
      }
    } catch (sendError) {
      console.error("Failed to send error notification to Discord:", sendError);
    }
  } else {
    console.warn("Discord client not ready, error notification not sent to Discord");
  }
}

export function setupGlobalErrorHandlers(): void {
  process.on("uncaughtException", async (error, origin) => {
    console.error("[FATAL] Uncaught exception, will restart via PM2:", error);
    await notifyError("uncaughtException", error, `Origin: ${origin}`).catch(() => {});
    // Give time for Discord notification to be sent, then exit
    // PM2 will automatically restart the process
    setTimeout(() => {
      process.exit(1);
    }, 3000);
  });

  process.on("unhandledRejection", (reason, promise) => {
    // Log but don't crash on unhandled rejections - they're usually recoverable
    notifyError("unhandledRejection", reason, `Promise: ${String(promise)}`).catch(() => {});
  });
}

export function setupDiscordErrorHandlers(client: Client): void {
  client.on("error", (error) => {
    notifyError("discordError", error, "Discord.js client error").catch(() => {});
  });

  client.on("warn", (warning) => {
    notifyError("discordWarn", warning, "Discord.js client warning").catch(() => {});
  });

  // WebSocket shard errors
  client.on("shardError", (error, shardId) => {
    notifyError("discordError", error, `Shard ${shardId} error`).catch(() => {});
  });

  client.on("shardDisconnect", (event, shardId) => {
    notifyError("discordWarn", `Shard ${shardId} disconnected`, `Code: ${event.code}`).catch(() => {});
  });

  client.on("shardReconnecting", (shardId) => {
    console.log(`Shard ${shardId} reconnecting...`);
  });
}
