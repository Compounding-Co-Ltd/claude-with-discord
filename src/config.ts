import { readFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./types.js";

const CONFIG_PATH = resolve(process.cwd(), "config.json");

const DEFAULTS: AppConfig = {
  channel_project_map: {},
  channel_system_prompts: {},
  global_context: "",
  permission_mode: "acceptEdits",
  max_budget_usd: 5.0,
  max_turns: 50,
  max_concurrent_sessions: 5,
  session_timeout_minutes: 1440,
  allowed_users: [],
  openai_api_key: process.env.OPENAI_API_KEY,
};

function parseConfig(): AppConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.warn(`config.json not found at ${CONFIG_PATH}, using defaults`);
    return DEFAULTS;
  }

  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  const config: AppConfig = { ...DEFAULTS, ...raw };

  // Validate project paths exist
  for (const [channelId, path] of Object.entries(config.channel_project_map)) {
    if (!existsSync(path)) {
      console.warn(`Warning: project path "${path}" for channel ${channelId} does not exist`);
    }
  }

  if (Object.keys(config.channel_project_map).length === 0) {
    console.warn("Warning: no channel-project mappings configured");
  }

  return config;
}

type ConfigChangeCallback = (oldConfig: AppConfig, newConfig: AppConfig) => void;

/**
 * ConfigManager provides hot-reloading of config.json.
 * Changes to the config file are automatically detected and applied.
 */
class ConfigManager {
  private _config: AppConfig;
  private watcher: FSWatcher | null = null;
  private reloadTimeout: ReturnType<typeof setTimeout> | null = null;
  private changeCallbacks: ConfigChangeCallback[] = [];

  constructor() {
    this._config = parseConfig();
    this.startWatching();
  }

  get config(): AppConfig {
    return this._config;
  }

  /**
   * Register a callback to be called when config changes.
   */
  onConfigChange(callback: ConfigChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  private startWatching(): void {
    if (!existsSync(CONFIG_PATH)) return;

    try {
      this.watcher = watch(CONFIG_PATH, (eventType) => {
        if (eventType === "change") {
          // Debounce to handle multiple rapid changes
          if (this.reloadTimeout) {
            clearTimeout(this.reloadTimeout);
          }
          this.reloadTimeout = setTimeout(() => {
            this.reload();
          }, 100);
        }
      });

      this.watcher.on("error", (err) => {
        console.error("Config watcher error:", err);
      });
    } catch (err) {
      console.error("Failed to watch config file:", err);
    }
  }

  private reload(): void {
    try {
      const oldConfig = this._config;
      const newConfig = parseConfig();
      this._config = newConfig;
      console.log("Config reloaded successfully");

      // Notify callbacks
      for (const callback of this.changeCallbacks) {
        try {
          callback(oldConfig, newConfig);
        } catch (err) {
          console.error("Config change callback error:", err);
        }
      }
    } catch (err) {
      console.error("Failed to reload config:", err);
    }
  }

  /**
   * Manually reload config (useful for testing or explicit refresh).
   */
  forceReload(): void {
    this.reload();
  }

  /**
   * Stop watching for changes.
   */
  destroy(): void {
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

// Singleton instance
const configManager = new ConfigManager();

/**
 * Get the current config. This always returns the latest config,
 * automatically updated when config.json changes.
 */
export function getConfig(): AppConfig {
  return configManager.config;
}

/**
 * Legacy function for initial load. Returns the same as getConfig().
 * @deprecated Use getConfig() instead for hot-reloading support.
 */
export function loadConfig(): AppConfig {
  return configManager.config;
}

/**
 * Manually reload config.
 */
export function reloadConfig(): void {
  configManager.forceReload();
}

/**
 * Stop config file watching.
 */
export function destroyConfigManager(): void {
  configManager.destroy();
}

/**
 * Register a callback to be called when config changes.
 */
export function onConfigChange(callback: ConfigChangeCallback): void {
  configManager.onConfigChange(callback);
}
