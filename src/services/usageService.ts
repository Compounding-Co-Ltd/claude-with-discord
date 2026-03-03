/**
 * Usage service - fetches Claude Code usage limits via tmux
 * Replaced expect-based approach with more reliable tmux-based solution
 */

import { execSync } from "node:child_process";

export interface UsageInfo {
  currentSession: {
    percent: number;
    resetTime: string;
  };
  weeklyAllModels: {
    percent: number;
    resetTime: string;
  };
  weeklySonnet: {
    percent: number;
    resetTime: string;
  };
  fetchedAt: number;
}

// Cache usage data with TTL
let cachedUsage: UsageInfo | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds cache

// Find claude CLI path - check multiple locations
let claudePath: string | null = null;
const possiblePaths = [
  // Try which first
  () => {
    try {
      return execSync("which claude", { encoding: "utf-8" }).trim();
    } catch {
      return null;
    }
  },
  // Cursor extension paths (sorted by version desc to get latest)
  () => {
    try {
      const result = execSync(
        'ls -d ~/.cursor/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1',
        { encoding: "utf-8" }
      ).trim();
      return result || null;
    } catch {
      return null;
    }
  },
  // VS Code extension paths
  () => {
    try {
      const result = execSync(
        'ls -d ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1',
        { encoding: "utf-8" }
      ).trim();
      return result || null;
    } catch {
      return null;
    }
  },
];

for (const finder of possiblePaths) {
  const path = finder();
  if (path) {
    claudePath = path;
    console.log(`[UsageService] Found claude CLI at: ${claudePath}`);
    break;
  }
}

if (!claudePath) {
  console.warn("[UsageService] Claude CLI not found in PATH or known locations");
}

// Check if tmux is available
let tmuxAvailable = false;
try {
  execSync("which tmux", { encoding: "utf-8" });
  tmuxAvailable = true;
} catch {
  console.warn(
    "[UsageService] tmux not found, usage fetching will be disabled"
  );
}

const SESSION_NAME = "claude_usage_fetcher";

/**
 * Fetch usage info from Claude CLI using tmux
 */
export async function fetchUsageInfo(): Promise<UsageInfo | null> {
  // Return cached data if still valid
  if (cachedUsage && Date.now() - cachedUsage.fetchedAt < CACHE_TTL_MS) {
    return cachedUsage;
  }

  if (!claudePath || !tmuxAvailable) {
    console.warn("[UsageService] Prerequisites not met");
    return cachedUsage;
  }

  return new Promise((resolve) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        console.warn("[UsageService] Timeout fetching usage");
        resolve(cachedUsage);
      }
    }, 35_000);

    const cleanup = () => {
      try {
        execSync(`tmux kill-session -t ${SESSION_NAME} 2>/dev/null`, {
          encoding: "utf-8",
        });
      } catch {
        // Session may not exist, that's fine
      }
    };

    try {
      // Kill any existing session first
      cleanup();

      // Create environment without CLAUDECODE
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;

      // Start a new tmux session
      execSync(`tmux new-session -d -s ${SESSION_NAME} -x 120 -y 40`, {
        env: cleanEnv,
      });

      // Start claude in the session
      execSync(
        `tmux send-keys -t ${SESSION_NAME} "unset CLAUDECODE && ${claudePath}" Enter`,
        { env: cleanEnv }
      );

      // Wait for initial load
      setTimeout(() => {
        try {
          // Send /usage command
          execSync(`tmux send-keys -t ${SESSION_NAME} "/usage"`, {
            env: cleanEnv,
          });

          setTimeout(() => {
            // Press Enter to select from autocomplete
            execSync(`tmux send-keys -t ${SESSION_NAME} Enter`, {
              env: cleanEnv,
            });

            setTimeout(() => {
              // Press Enter again to execute
              execSync(`tmux send-keys -t ${SESSION_NAME} Enter`, {
                env: cleanEnv,
              });

              // Wait for response and capture
              setTimeout(() => {
                try {
                  const output = execSync(
                    `tmux capture-pane -t ${SESSION_NAME} -p -S -100`,
                    { encoding: "utf-8", env: cleanEnv }
                  );

                  // Parse the output
                  const usage = parseUsageOutput(output);

                  if (usage) {
                    cachedUsage = usage;
                    console.log("[UsageService] Usage fetched successfully:", {
                      session: usage.currentSession.percent + "%",
                      weekly: usage.weeklyAllModels.percent + "%",
                      sonnet: usage.weeklySonnet.percent + "%",
                    });
                  }

                  if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    cleanup();
                    resolve(usage);
                  }
                } catch (err) {
                  console.error("[UsageService] Failed to capture pane:", err);
                  if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    cleanup();
                    resolve(cachedUsage);
                  }
                }
              }, 8000); // Wait 8s for usage to display
            }, 1500); // Wait 1.5s after first Enter
          }, 1500); // Wait 1.5s after typing command
        } catch (err) {
          console.error("[UsageService] Failed to send commands:", err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            cleanup();
            resolve(cachedUsage);
          }
        }
      }, 8000); // Wait 8s for claude to start
    } catch (err) {
      console.error("[UsageService] Failed to start tmux session:", err);
      clearTimeout(timeout);
      cleanup();
      resolve(cachedUsage);
    }
  });
}

/**
 * Parse usage output from tmux capture
 */
function parseUsageOutput(output: string): UsageInfo | null {
  try {
    // Parse percentages - look for pattern like "20% used"
    const percentRegex = /(\d+)%\s*used/g;
    const percents: number[] = [];
    let match;
    while ((match = percentRegex.exec(output)) !== null) {
      percents.push(parseInt(match[1], 10));
    }

    // Parse reset times - look for pattern like "Resets 12am" or "Resets Feb 21 at 3pm"
    const resetRegex = /Resets?\s+([^\n]+?)(?:\s*$|\s*(?=\n|Current|Extra))/gim;
    const resets: string[] = [];
    while ((match = resetRegex.exec(output)) !== null) {
      const resetTime = match[1].trim();
      // Clean up the reset time string
      const cleaned = resetTime.replace(/\s+/g, " ").trim();
      if (cleaned && !cleaned.includes("used")) {
        resets.push(cleaned);
      }
    }

    if (percents.length >= 3) {
      return {
        currentSession: {
          percent: percents[0],
          resetTime: resets[0] || "Unknown",
        },
        weeklyAllModels: {
          percent: percents[1],
          resetTime: resets[1] || "Unknown",
        },
        weeklySonnet: {
          percent: percents[2],
          resetTime: resets[2] || resets[1] || "Unknown",
        },
        fetchedAt: Date.now(),
      };
    }

    // If we found at least some data, try to create a partial result
    if (percents.length >= 1) {
      return {
        currentSession: {
          percent: percents[0],
          resetTime: resets[0] || "Unknown",
        },
        weeklyAllModels: {
          percent: percents[1] || percents[0],
          resetTime: resets[1] || resets[0] || "Unknown",
        },
        weeklySonnet: {
          percent: percents[2] || percents[1] || percents[0],
          resetTime: resets[2] || resets[1] || resets[0] || "Unknown",
        },
        fetchedAt: Date.now(),
      };
    }

    return null;
  } catch (err) {
    console.error("[UsageService] Failed to parse usage output:", err);
    return null;
  }
}

/**
 * Format usage info for Discord embed
 */
export function formatUsageEmbed(usage: UsageInfo): string {
  const bar = (percent: number): string => {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return "█".repeat(filled) + "░".repeat(empty);
  };

  return [
    "```",
    "📊 Usage Status",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `Session:  ${bar(usage.currentSession.percent)} ${usage.currentSession.percent}%`,
    `          Resets ${usage.currentSession.resetTime}`,
    "",
    `Weekly:   ${bar(usage.weeklyAllModels.percent)} ${usage.weeklyAllModels.percent}%`,
    `          Resets ${usage.weeklyAllModels.resetTime}`,
    "",
    `Sonnet:   ${bar(usage.weeklySonnet.percent)} ${usage.weeklySonnet.percent}%`,
    "```",
  ].join("\n");
}

/**
 * Get cached usage or null
 */
export function getCachedUsage(): UsageInfo | null {
  return cachedUsage;
}
