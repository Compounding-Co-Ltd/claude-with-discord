import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { AppConfig } from "../types.js";
import { getConfig, onConfigChange } from "../config.js";
import { SessionManager } from "../claude/sessionManager.js";
import { handleThreadCreate } from "./events/threadCreate.js";
import { handleMessageCreate } from "./events/messageCreate.js";
import { handleInteractionCreate } from "./events/interactionCreate.js";
import { sendButtonToChannelWithUsage, startUsageUpdater } from "../services/usageUpdater.js";
import { startThreadCleaner } from "../services/threadCleaner.js";

export function createDiscordClient(_config?: AppConfig): { client: Client; sessionManager: SessionManager } {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  const sessionManager = new SessionManager();
  sessionManager.setClient(client);

  client.once("ready", async (c) => {
    const config = getConfig();
    console.log(`Logged in as ${c.user.tag}`);
    console.log(`Watching ${Object.keys(config.channel_project_map).length} channel(s)`);

    // Send "New Session" button to each mapped channel
    for (const channelId of Object.keys(config.channel_project_map)) {
      await sendButtonToChannelWithUsage(client, channelId);
    }

    // Start usage updater for the special channel
    startUsageUpdater(client);

    // Start thread cleaner to auto-delete threads older than 7 days
    startThreadCleaner(client);

    // Watch for config changes and send buttons to newly added channels
    onConfigChange(async (oldConfig, newConfig) => {
      const oldChannels = new Set(Object.keys(oldConfig.channel_project_map));
      const newChannels = Object.keys(newConfig.channel_project_map);

      for (const channelId of newChannels) {
        if (!oldChannels.has(channelId)) {
          console.log(`New channel detected: ${channelId}`);
          await sendButtonToChannelWithUsage(client, channelId);
        }
      }
    });
  });

  // Note: handlers use getConfig() internally for hot-reload, config param is unused
  const unusedConfig = getConfig();
  client.on("threadCreate", handleThreadCreate(unusedConfig, sessionManager));
  client.on("messageCreate", handleMessageCreate(unusedConfig, sessionManager));
  client.on("interactionCreate", handleInteractionCreate(unusedConfig, sessionManager));

  return { client, sessionManager };
}
