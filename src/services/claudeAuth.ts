import { execSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
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
 * Check if Claude Code CLI is authenticated.
 */
export function isAuthenticated(): boolean {
  try {
    const output = execSync("claude auth status", {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const status: AuthStatus = JSON.parse(output);
    return status.loggedIn;
  } catch {
    return false;
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
  writeFileSync(path, JSON.stringify(data, null, 2));
  if (mode) chmodSync(path, mode);
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
