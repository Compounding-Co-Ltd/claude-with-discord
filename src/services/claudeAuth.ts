import { execSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export interface AuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string;
}

export interface LoginSession {
  url: string;
  /** Exchange the authorization code for OAuth tokens. Returns null on success, error message on failure. */
  submitCode: (code: string) => Promise<string | null>;
  /** Cancel the login */
  cancel: () => void;
}

const OAUTH_CONFIG = {
  CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  AUTHORIZE_URL: "https://claude.ai/oauth/authorize",
  TOKEN_URL: "https://platform.claude.com/v1/oauth/token",
  PROFILE_URL: "https://api.anthropic.com/api/oauth/profile",
  REDIRECT_URI: "https://platform.claude.com/oauth/code/callback",
  SCOPES: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
};

const CONFIG_PATH = resolve(homedir(), ".claude.json");
const CLAUDE_DIR = resolve(homedir(), ".claude");
const CREDENTIALS_PATH = join(CLAUDE_DIR, ".credentials.json");

/**
 * Check if Claude Code is authenticated.
 * Checks credentials file directly for token validity.
 */
export function isAuthenticated(): boolean {
  try {
    if (existsSync(CREDENTIALS_PATH)) {
      const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
      const oauth = creds.claudeAiOauth;
      if (oauth?.accessToken && oauth?.expiresAt) {
        const bufferMs = 5 * 60 * 1000;
        if (Date.now() < oauth.expiresAt - bufferMs) {
          return true;
        }
        console.log("[claudeAuth] Token expired, will need re-login");
        return false;
      }
    }
  } catch { /* ignore */ }
  return false;
}

// In-process mutex: the bot must be the sole refresher. The spawned claude
// cli.js refreshes only at the 5-minute expiry boundary; we keep the on-disk
// token far fresher than that, so the only refresher is this process. The
// mutex guarantees we never double-fire even if the timer and a manual call
// overlap.
let refreshInFlight: Promise<boolean> | null = null;

// Minimum remaining validity (ms) below which we still consider a freshly-read
// on-disk token "stale enough" to bother refreshing. Anything fresher than this
// means another writer already refreshed and we can skip.
const SKIP_IF_FRESHER_THAN_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Attempt to refresh the OAuth token using the refresh token.
 * Returns true if refresh succeeded (or the on-disk token is already fresh),
 * false otherwise. Serialized via an in-process mutex.
 */
export async function refreshToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefreshToken(): Promise<boolean> {
  try {
    if (!existsSync(CREDENTIALS_PATH)) return false;

    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
    const oauth = creds.claudeAiOauth;
    if (!oauth?.refreshToken) {
      console.log("[claudeAuth] No refresh token available");
      return false;
    }

    // Skip if another writer (interactive claude, a prior cycle) already left a
    // fresh token on disk. Avoids needlessly rotating the single-use refresh
    // token and racing with whoever just wrote it.
    if (oauth.expiresAt && oauth.expiresAt - Date.now() > SKIP_IF_FRESHER_THAN_MS) {
      return true;
    }

    console.log("[claudeAuth] Attempting token refresh...");
    const response = await fetch(OAUTH_CONFIG.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: OAUTH_CONFIG.CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[claudeAuth] Token refresh failed:", response.status, errText);
      return false;
    }

    const tokenData = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    // Update credentials with new tokens
    oauth.accessToken = tokenData.access_token;
    if (tokenData.refresh_token) {
      oauth.refreshToken = tokenData.refresh_token;
    }
    oauth.expiresAt = tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : Date.now() + 24 * 60 * 60 * 1000;

    if (tokenData.scope) {
      oauth.scopes = tokenData.scope.split(" ");
    }

    writeJsonFile(CREDENTIALS_PATH, creds, 0o600);
    console.log("[claudeAuth] Token refreshed successfully, new expiry:", new Date(oauth.expiresAt).toISOString());
    return true;
  } catch (err) {
    console.error("[claudeAuth] Token refresh error:", err);
    return false;
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a background timer that auto-refreshes the OAuth token before expiry.
 * Checks every 30 minutes and refreshes when <1 hour remains.
 */
export function startTokenAutoRefresh(): void {
  if (refreshTimer) return;

  // The spawned claude cli.js refreshes only when <5 min (300s) of validity
  // remain. We keep the on-disk token far fresher so those many concurrent
  // child processes NEVER reach their refresh boundary — making this process
  // the single refresher and eliminating the rotating-refresh-token race that
  // produced 401 "Invalid authentication credentials" storms.
  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const REFRESH_THRESHOLD_MS = 2 * 60 * 60 * 1000; // refresh when <2 hours left (>> 5 min child threshold)

  const checkAndRefresh = async () => {
    try {
      if (!existsSync(CREDENTIALS_PATH)) return;

      const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
      const oauth = creds.claudeAiOauth;
      if (!oauth?.expiresAt) return;

      const timeLeft = oauth.expiresAt - Date.now();
      if (timeLeft > REFRESH_THRESHOLD_MS) {
        return; // Still plenty of time
      }

      if (timeLeft > 0) {
        console.log(`[claudeAuth] Token expires in ${Math.round(timeLeft / 60000)}m, refreshing proactively...`);
      } else {
        console.log("[claudeAuth] Token already expired, attempting refresh...");
      }

      const success = await refreshToken();
      if (!success) {
        console.warn("[claudeAuth] Auto-refresh failed. User will need to re-login via Discord.");
      }
    } catch (err) {
      console.error("[claudeAuth] Auto-refresh check error:", err);
    }
  };

  // Delay the first check briefly. On a pm2 restart the OUTGOING process is
  // still gracefully closing its sessions with the current (pre-rotation)
  // token; if we refresh immediately we rotate the refresh token out from
  // under it and it 401s on cleanup. A short delay lets it finish first.
  const STARTUP_DELAY_MS = 12 * 1000;
  setTimeout(checkAndRefresh, STARTUP_DELAY_MS);
  refreshTimer = setInterval(checkAndRefresh, CHECK_INTERVAL_MS);
  console.log("[claudeAuth] Token auto-refresh started (5 min interval, refresh at <2h remaining)");
}

/**
 * Stop the auto-refresh timer.
 */
export function stopTokenAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Bot-private OAuth token manager (isolated from the shared credential file).
//
// Why: the bot and any interactive Claude Code session share
// ~/.claude/.credentials.json. OAuth refresh tokens are single-use, so whenever
// one side refreshes it rotates the token and can invalidate the other side →
// 401 "Invalid authentication credentials".
//
// Fix: the bot keeps its OWN credential copy (~/.claude-discord/oauth.json),
// refreshes only that, and injects the current access token into every spawned
// claude cli.js via CLAUDE_CODE_OAUTH_TOKEN. When that env var is set the
// runtime authenticates straight from it and NEVER reads/writes/refreshes the
// shared file. So: single writer (no internal storm) + isolated file (no
// collision with interactive sessions). The bot becomes the sole owner of its
// own refresh-token lineage.
// ───────────────────────────────────────────────────────────────────────────

interface BotOAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}

const BOT_AUTH_DIR = resolve(homedir(), ".claude-discord");
const BOT_CREDENTIALS_PATH = join(BOT_AUTH_DIR, "oauth.json");

function readBotCreds(): BotOAuthCreds | null {
  try {
    if (existsSync(BOT_CREDENTIALS_PATH)) {
      return JSON.parse(readFileSync(BOT_CREDENTIALS_PATH, "utf-8")) as BotOAuthCreds;
    }
  } catch { /* ignore */ }
  return null;
}

function writeBotCreds(c: BotOAuthCreds): void {
  if (!existsSync(BOT_AUTH_DIR)) mkdirSync(BOT_AUTH_DIR, { recursive: true });
  const tmp = `${BOT_CREDENTIALS_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, BOT_CREDENTIALS_PATH);
}

/** Copy the shared file's current OAuth creds into the bot-private store.
 *  `force` overwrites even if bot creds already exist (used for recovery when
 *  the bot's refresh token was consumed by another consumer). Copy only — does
 *  NOT refresh, so the shared refresh token is not consumed here. */
function seedBotCredsFromShared(force = false): boolean {
  if (!force && readBotCreds()?.refreshToken) return true;
  try {
    if (!existsSync(CREDENTIALS_PATH)) return false;
    const shared = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")).claudeAiOauth;
    if (!shared?.accessToken || !shared?.refreshToken) return false;
    writeBotCreds({
      accessToken: shared.accessToken,
      refreshToken: shared.refreshToken,
      expiresAt: shared.expiresAt ?? Date.now() + 8 * 60 * 60 * 1000,
      scopes: shared.scopes,
      subscriptionType: shared.subscriptionType ?? null,
      rateLimitTier: shared.rateLimitTier ?? null,
    });
    console.log(`[botAuth] ${force ? "Re-seeded" : "Seeded"} bot-private credentials from shared file (copy, no rotation).`);
    return true;
  } catch (err) {
    console.error("[botAuth] Seed failed:", err);
    return false;
  }
}

/** Point spawned cli.js at the bot-private token. */
function applyBotTokenToEnv(): boolean {
  const c = readBotCreds();
  if (!c?.accessToken) return false;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = c.accessToken;
  return true;
}

let botRefreshInFlight: Promise<boolean> | null = null;

/** Refresh the BOT-PRIVATE token (rotates only the bot's own refresh-token
 *  lineage; never touches the shared file). Updates the injected env token. */
export async function refreshBotToken(): Promise<boolean> {
  if (botRefreshInFlight) return botRefreshInFlight;
  botRefreshInFlight = (async () => {
    const c = readBotCreds();
    if (!c?.refreshToken) return false;
    try {
      const resp = await fetch(OAUTH_CONFIG.TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: c.refreshToken,
          client_id: OAUTH_CONFIG.CLIENT_ID,
        }),
      });
      if (!resp.ok) {
        // Our refresh token was likely already rotated by another consumer of
        // the shared lineage. Recover by re-copying the shared file's current
        // (valid) token instead of dying.
        console.error("[botAuth] Refresh failed:", resp.status, await resp.text());
        const recovered = seedBotCredsFromShared(true);
        const rc = recovered ? readBotCreds() : null;
        if (rc && rc.expiresAt - Date.now() > 0) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = rc.accessToken;
          console.log("[botAuth] Recovered token from shared file after refresh failure.");
          return true;
        }
        return false;
      }
      const t = await resp.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
      const updated: BotOAuthCreds = {
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? c.refreshToken,
        expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : Date.now() + 8 * 60 * 60 * 1000,
        scopes: t.scope ? t.scope.split(" ") : c.scopes,
        subscriptionType: c.subscriptionType,
        rateLimitTier: c.rateLimitTier,
      };
      writeBotCreds(updated);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = updated.accessToken;
      console.log("[botAuth] Bot token refreshed, new expiry:", new Date(updated.expiresAt).toISOString());
      return true;
    } catch (err) {
      console.error("[botAuth] Refresh error:", err);
      return false;
    }
  })().finally(() => { botRefreshInFlight = null; });
  return botRefreshInFlight;
}

let botRefreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the bot-private token manager.
 * Returns true if the bot is now authenticating via its own isolated token,
 * false if seeding failed (caller should fall back to shared-file refresh).
 */
export function startBotTokenManager(): boolean {
  if (botRefreshTimer) return true;

  // If an external long-lived token was provided (e.g. `claude setup-token`)
  // and there is no bot-private store, trust it verbatim and don't manage refresh.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN && !readBotCreds()) {
    console.log("[botAuth] External CLAUDE_CODE_OAUTH_TOKEN provided; using as-is (no managed refresh).");
    return true;
  }

  if (!seedBotCredsFromShared()) return false;
  applyBotTokenToEnv();

  const CHECK_INTERVAL_MS = 5 * 60 * 1000;          // 5 min
  const REFRESH_THRESHOLD_MS = 2 * 60 * 60 * 1000;  // refresh when <2h left

  const tick = async () => {
    try {
      const c = readBotCreds();
      if (!c) return;
      const left = c.expiresAt - Date.now();
      if (left <= REFRESH_THRESHOLD_MS) {
        console.log(`[botAuth] Bot token ${Math.round(left / 60000)}m left, refreshing proactively...`);
        const ok = await refreshBotToken();
        if (!ok) console.warn("[botAuth] Bot token refresh failed — will retry next cycle.");
      } else {
        applyBotTokenToEnv();
      }
    } catch (err) {
      console.error("[botAuth] tick error:", err);
    }
  };

  tick();
  botRefreshTimer = setInterval(tick, CHECK_INTERVAL_MS);
  console.log("[botAuth] Bot token manager started — isolated private creds, 5m check, refresh <2h. Shared credential file will NOT be touched.");
  return true;
}

export function stopBotTokenManager(): void {
  if (botRefreshTimer) {
    clearInterval(botRefreshTimer);
    botRefreshTimer = null;
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function writeJsonFile(path: string, data: Record<string, unknown>, mode?: number): void {
  // Atomic write: write to a temp file then rename, so concurrently-spawned
  // claude cli.js processes never read a half-written credentials file.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Fetch user profile from Anthropic OAuth API.
 */
async function fetchProfile(accessToken: string): Promise<{
  subscriptionType: string | null;
  rateLimitTier: string | null;
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  displayName?: string;
  hasExtraUsageEnabled?: boolean;
  billingType?: string;
  accountCreatedAt?: string;
  subscriptionCreatedAt?: string;
} | null> {
  try {
    const resp = await fetch(OAUTH_CONFIG.PROFILE_URL, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) return null;

    const data = await resp.json() as {
      account?: { uuid?: string; email?: string; display_name?: string; created_at?: string };
      organization?: {
        uuid?: string;
        organization_type?: string;
        rate_limit_tier?: string;
        has_extra_usage_enabled?: boolean;
        billing_type?: string;
        subscription_created_at?: string;
      };
    };

    let subscriptionType: string | null = null;
    switch (data.organization?.organization_type) {
      case "claude_max": subscriptionType = "max"; break;
      case "claude_pro": subscriptionType = "pro"; break;
      case "claude_enterprise": subscriptionType = "enterprise"; break;
      case "claude_team": subscriptionType = "team"; break;
    }

    return {
      subscriptionType,
      rateLimitTier: data.organization?.rate_limit_tier ?? null,
      accountUuid: data.account?.uuid,
      emailAddress: data.account?.email,
      organizationUuid: data.organization?.uuid,
      displayName: data.account?.display_name,
      hasExtraUsageEnabled: data.organization?.has_extra_usage_enabled,
      billingType: data.organization?.billing_type,
      accountCreatedAt: data.account?.created_at,
      subscriptionCreatedAt: data.organization?.subscription_created_at,
    };
  } catch (err) {
    console.error("[claudeAuth] Profile fetch failed:", err);
    return null;
  }
}

/**
 * Start the OAuth login flow directly (no Ink UI dependency).
 * Returns a LoginSession with the OAuth URL and a submitCode function.
 */
export function startLogin(): LoginSession {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = base64url(randomBytes(32));

  const params = new URLSearchParams({
    code: "true",
    client_id: OAUTH_CONFIG.CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_CONFIG.REDIRECT_URI,
    scope: OAUTH_CONFIG.SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  const url = `${OAUTH_CONFIG.AUTHORIZE_URL}?${params.toString()}`;
  let cancelled = false;

  return {
    url,
    submitCode: async (rawInput: string): Promise<string | null> => {
      if (cancelled) return "Login cancelled";

      try {
        // Extract authorization code - handle URL or plain code input
        let code = rawInput.trim();

        // If user pasted the full callback URL, extract the code parameter
        if (code.includes("code=")) {
          try {
            const url = new URL(code);
            code = url.searchParams.get("code") ?? code;
          } catch {
            const match = code.match(/code=([^&\s]+)/);
            if (match) code = match[1];
          }
        }

        // Strip any Discord formatting or whitespace
        code = code.replace(/[`*_~\n\r]/g, "").trim();

        // The callback page displays "authorizationCode#state" as a single string.
        // Split on '#' - first part is the actual OAuth code.
        if (code.includes("#")) {
          const [authCode] = code.split("#");
          if (!authCode) {
            return "Invalid code format. Please make sure the full code was copied.";
          }
          console.log("[claudeAuth] Split code on '#': auth code length:", authCode.length);
          code = authCode;
        }

        // Step 1: Exchange authorization code for OAuth tokens
        console.log("[claudeAuth] Exchanging code for token, code length:", code.length);
        const tokenResponse = await fetch(OAUTH_CONFIG.TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: OAUTH_CONFIG.REDIRECT_URI,
            client_id: OAUTH_CONFIG.CLIENT_ID,
            code_verifier: codeVerifier,
            state,
          }),
        });

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          console.error("[claudeAuth] Token exchange failed:", tokenResponse.status, errText);
          return `Token exchange failed (${tokenResponse.status}): ${errText}`;
        }

        const tokenData = await tokenResponse.json() as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
          account_uuid?: string;
        };

        console.log("[claudeAuth] Token exchange successful");

        // Step 2: Fetch user profile to get subscription type
        console.log("[claudeAuth] Fetching user profile...");
        const profile = await fetchProfile(tokenData.access_token);
        console.log("[claudeAuth] Profile:", profile?.subscriptionType, profile?.displayName);

        // Step 3: Save OAuth tokens to ~/.claude/.credentials.json (same as CLI)
        if (!existsSync(CLAUDE_DIR)) {
          mkdirSync(CLAUDE_DIR, { recursive: true });
        }

        const scopes = tokenData.scope?.split(" ") ?? [];
        const expiresAt = tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : undefined;

        const credentials = readJsonFile(CREDENTIALS_PATH);
        credentials.claudeAiOauth = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt,
          scopes,
          subscriptionType: profile?.subscriptionType ?? null,
          rateLimitTier: profile?.rateLimitTier ?? null,
        };
        writeJsonFile(CREDENTIALS_PATH, credentials, 0o600);
        console.log("[claudeAuth] Credentials saved to", CREDENTIALS_PATH);

        // Step 4: Save account info to ~/.claude.json (same as CLI)
        const config = readJsonFile(CONFIG_PATH);
        if (profile) {
          config.oauthAccount = {
            accountUuid: profile.accountUuid,
            emailAddress: profile.emailAddress,
            organizationUuid: profile.organizationUuid,
            displayName: profile.displayName,
            hasExtraUsageEnabled: profile.hasExtraUsageEnabled ?? false,
            billingType: profile.billingType,
            accountCreatedAt: profile.accountCreatedAt,
            subscriptionCreatedAt: profile.subscriptionCreatedAt,
          };
        }
        config.hasCompletedOnboarding = true;
        writeJsonFile(CONFIG_PATH, config);
        console.log("[claudeAuth] Config saved to", CONFIG_PATH);

        return null; // success
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[claudeAuth] Login error:", err);
        return `Unexpected error: ${errMsg}`;
      }
    },
    cancel: () => { cancelled = true; },
  };
}
