import type { ThreadChannel } from "discord.js";
import type { AppConfig } from "../../types.js";
import { getConfig } from "../../config.js";
import type { SessionManager } from "../../claude/sessionManager.js";

export function handleThreadCreate(_config: AppConfig, sessionManager: SessionManager) {
  return async (thread: ThreadChannel) => {
    // Get fresh config for hot-reload support
    const config = getConfig();

    // Only handle threads in mapped channels
    const projectPath = config.channel_project_map[thread.parentId ?? ""];
    if (!projectPath) return;

    console.log(`New thread "${thread.name}" in mapped channel ${thread.parentId}`);

    // Fetch the starter message (thread name becomes the first prompt)
    const starterMessage = await thread.fetchStarterMessage().catch(() => null);

    if (starterMessage && !starterMessage.author.bot) {
      // Check user whitelist
      if (config.allowed_users.length > 0 && !config.allowed_users.includes(starterMessage.author.id)) {
        await thread.send("*You are not authorized to use this bot.*");
        return;
      }

      const prompt = starterMessage.content;
      if (prompt) {
        await sessionManager.sendMessage(
          thread.id,
          thread.parentId!,
          projectPath,
          prompt,
          thread,
        );
      }
    }
  };
}
