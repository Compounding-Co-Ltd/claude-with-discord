import "dotenv/config";
import { loadConfig, getConfig, destroyConfigManager } from "./config.js";
import { createDiscordClient } from "./discord/client.js";
import {
  setupGlobalErrorHandlers,
  setupDiscordErrorHandlers,
  setErrorNotifierClient,
} from "./errorNotifier.js";
import { VisualizationServer } from "./web/server.js";
import { closeMessageStore } from "./db/messageStore.js";
import { startTokenAutoRefresh, stopTokenAutoRefresh, startBotTokenManager, stopBotTokenManager } from "./services/claudeAuth.js";

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

// Initialize visualization server if enabled
let visualizationServer: VisualizationServer | null = null;

// 인증 전략:
// (A) CLAUDE_CODE_OAUTH_TOKEN 이 설정된 경우 — 권장/안정 경로.
//     SDK가 띄우는 cli.js가 이 환경변수의 장수명 토큰을 직접 사용하고,
//     공유 파일 ~/.claude/.credentials.json 을 읽지도 쓰지도 갱신하지도 않는다.
//     → 인터랙티브 Claude Code 세션 등 다른 소비자와의 토큰 회전 충돌이 원천 차단됨.
//     이 경우 봇이 공유 파일을 회전시키면 오히려 다른 세션을 깨뜨리므로 자동갱신을 끈다.
// (B) 토큰이 없는 경우 — 폴백. 봇을 "유일한 갱신자"로 만들어 공유 파일을 만료
//     2시간 전(>> cli.js의 5분 임계값)에 미리 갱신, on-disk 토큰을 항상 신선하게
//     유지해 cli.js들끼리의 회전 경쟁을 줄인다. (단, 인터랙티브 세션과는 여전히
//     같은 파일을 공유하므로 (A) 만큼 완전하지는 않다.)
// 봇 전용 격리 토큰 매니저를 우선 사용한다.
// 봇은 자신만의 ~/.claude-discord/oauth.json 을 갱신하고, 그 access token 을
// CLAUDE_CODE_OAUTH_TOKEN 으로 cli.js 에 주입한다. → cli.js 는 공유 파일
// ~/.claude/.credentials.json 을 건드리지 않으므로 인터랙티브 세션과의 회전 충돌 0.
// 시드(공유 파일 복사)에 실패한 경우에만 기존 공유 파일 선제 갱신으로 폴백한다.
if (startBotTokenManager()) {
  console.log("[auth] Bot-isolated token auth active (shared credential file untouched).");
} else {
  console.warn("[auth] Bot token seed failed — falling back to shared-file proactive refresh.");
  startTokenAutoRefresh();
}

client.once("ready", () => {
  const config = getConfig();
  if (config.visualization_enabled && config.visualization_password) {
    visualizationServer = new VisualizationServer(sessionManager, client);

    // Connect message events to visualization
    sessionManager.onMessage((threadId, role, content, cost) => {
      visualizationServer?.getWsHandler().addToConversation(threadId, {
        id: Date.now().toString(),
        timestamp: Date.now(),
        role,
        content,
        cost,
      });
    });

    visualizationServer.start();
  } else if (config.visualization_enabled && !config.visualization_password) {
    console.warn("Visualization is enabled but no password is set. Skipping visualization server.");
  }
});

// Graceful shutdown
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("\nShutting down gracefully...");

  // Shutdown visualization server
  if (visualizationServer) {
    visualizationServer.destroy();
  }

  try {
    await sessionManager.gracefulShutdown();
  } catch (err) {
    console.error("Error during graceful shutdown:", err);
  }

  stopTokenAutoRefresh();
  stopBotTokenManager();
  destroyConfigManager();
  closeMessageStore();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(token);
