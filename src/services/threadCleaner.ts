import type { Client, TextChannel, ThreadChannel } from "discord.js";
import { getConfig } from "../config.js";

// Run cleanup every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Delete threads older than 7 days
const THREAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the thread cleaner service
 * Periodically deletes threads older than 7 days in all mapped channels
 */
export function startThreadCleaner(client: Client): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  // Run immediately on start, then periodically
  cleanupOldThreads(client);

  cleanupInterval = setInterval(() => {
    cleanupOldThreads(client);
  }, CLEANUP_INTERVAL_MS);

  console.log("Thread cleaner started (1 hour interval, 7 day max age)");
}

/**
 * Stop the thread cleaner service
 */
export function stopThreadCleaner(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log("Thread cleaner stopped");
  }
}

/**
 * Clean up old threads in all mapped channels
 */
async function cleanupOldThreads(client: Client): Promise<void> {
  const config = getConfig();
  const channelIds = Object.keys(config.channel_project_map);

  if (channelIds.length === 0) {
    return;
  }

  const now = Date.now();
  let deletedCount = 0;

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("threads" in channel)) continue;

      const textChannel = channel as TextChannel;

      // Fetch all active threads
      const activeThreads = await textChannel.threads.fetchActive();
      // Fetch archived threads
      const archivedThreads = await textChannel.threads.fetchArchived({ limit: 100 });

      const allThreads = [
        ...activeThreads.threads.values(),
        ...archivedThreads.threads.values(),
      ];

      for (const thread of allThreads) {
        const createdAt = thread.createdTimestamp ?? thread.createdAt?.getTime() ?? 0;
        const threadAge = now - createdAt;

        if (createdAt > 0 && threadAge > THREAD_MAX_AGE_MS) {
          try {
            await thread.delete(`Auto-cleanup: thread older than 7 days`);
            deletedCount++;
            console.log(`Deleted old thread: ${thread.name} (${thread.id})`);
          } catch (err) {
            console.error(`Failed to delete thread ${thread.id}:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to process channel ${channelId}:`, err);
    }
  }

  if (deletedCount > 0) {
    console.log(`Thread cleanup complete: deleted ${deletedCount} thread(s)`);
  }
}
