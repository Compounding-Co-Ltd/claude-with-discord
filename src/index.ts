import "dotenv/config";
import { loadConfig, destroyConfigManager } from "./config.js";
import { createDiscordClient } from "./discord/client.js";
import {
  setupGlobalErrorHandlers,
  setupDiscordErrorHandlers,
  setErrorNotifierClient,
} from "./errorNotifier.js";

// Setup global error handlers early (before Discord client is ready)
setupGlobalErrorHandlers();

// Load initial config (also starts file watcher)
loadConfig();

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN is not set in .env");
  process.exit(1);
}

const { client, sessionManager } = createDiscordClient();

// Setup Discord-specific error handlers and notifier
setErrorNotifierClient(client);
setupDiscordErrorHandlers(client);

// Graceful shutdown
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("\nShutting down gracefully...");

  try {
    await sessionManager.gracefulShutdown();
  } catch (err) {
    console.error("Error during graceful shutdown:", err);
  }

  destroyConfigManager();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(token);
