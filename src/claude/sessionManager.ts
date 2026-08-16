import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import type { PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AttachmentBuilder, type Client, type Message, type ThreadChannel } from "discord.js";
import type {
  AppConfig,
  SessionInfo,
  MainSessionInfo,
  SubsessionSessionInfo,
  SessionMode,
  PendingPermission,
  ImageContent,
  PendingImage,
  QueuedMessage,
  AudioTranscription,
  SubsessionState,
  SubsessionContext,
} from "../types.js";
import { isSubsession, isMainSession, SUBSESSION_LIMITS } from "../types.js";
import { getConfig } from "../config.js";
import { interSessionBus } from "./interSessionBus.js";
import { initThreadCreationQueue } from "../discord/threadCreationQueue.js";
import { initMcpServerConfig, createMcpServerForSession } from "../mcp/subsessionMcpServer.js";
import { formatAssistantMessage, formatResultMessage, generateThreadTitle } from "./messageFormatter.js";
import { splitMessage, truncateMessage } from "../discord/utils/messageSplitter.js";
import { createEndSessionButton } from "../discord/components/endSessionButton.js";
import { getMessageStore } from "../db/messageStore.js";
import { createModeSelect, getModeDescription } from "../discord/components/modeButtons.js";
import { createPermissionButtons, formatPermissionRequest, isAskUserQuestion } from "../discord/components/permissionButtons.js";
import { createQuestionComponents, formatQuestionMessage, type Question } from "../discord/components/questionButtons.js";
import { saveDiscordImage, formatPendingImagesList } from "../utils/imageSaver.js";
import { generateAudio, extractTextForTTS } from "../utils/audioGenerator.js";
import { isAuthenticated, refreshToken, refreshBotToken, startLogin, type LoginSession } from "../services/claudeAuth.js";

export type MessageCallback = (threadId: string, role: 'user' | 'assistant' | 'system', content: string, cost?: number) => void;

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private pendingModels = new Map<string, string>(); // threadId -> modelId (before session creation)
  private cleanupInterval: ReturnType<typeof setInterval>;
  private client: Client | null = null;
  private pendingLoginSession: LoginSession | null = null;
  private pendingLoginResolve: ((token: string) => void) | null = null;
  private messageCallbacks: MessageCallback[] = [];

  /**
   * Get the current config (hot-reloaded).
   */
  private get config(): AppConfig {
    return getConfig();
  }

  constructor() {
    // Periodic cleanup of idle sessions - uses config getter for timeout
    this.cleanupInterval = setInterval(() => {
      const timeoutMs = this.config.session_timeout_minutes * 60 * 1000;
      this.cleanupIdleSessions(timeoutMs);
    }, 60_000);
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  setClient(client: Client): void {
    this.client = client;

    // Initialize thread creation queue
    initThreadCreationQueue(client);

    // Initialize MCP server config
    initMcpServerConfig({
      discordClient: client,
      getSession: (threadId: string) => this.sessions.get(threadId),
      onSubsessionCreated: this.handleSubsessionCreated.bind(this),
      onSubsessionClosed: this.handleSubsessionClosed.bind(this),
    });

    // Set up Discord message callback for InterSessionBus
    interSessionBus.setDiscordMessageCallback(async (threadId, content) => {
      try {
        const channel = await client.channels.fetch(threadId);
        if (channel && 'send' in channel) {
          await (channel as ThreadChannel).send(content);
        }
      } catch (err) {
        console.error(`[InterSessionBus] Failed to send message to thread ${threadId}:`, err);
      }
    });
  }

  getSession(threadId: string): SessionInfo | undefined {
    return this.sessions.get(threadId);
  }

  /**
   * Get the count of sessions (main + subsessions) for a specific channel.
   */
  getSessionCountByChannel(channelId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Close all sessions for a specific channel.
   * Returns the number of sessions closed.
   */
  async closeAllSessionsByChannel(channelId: string): Promise<number> {
    const sessionsToClose: SessionInfo[] = [];

    for (const session of this.sessions.values()) {
      if (session.channelId === channelId) {
        sessionsToClose.push(session);
      }
    }

    let closedCount = 0;
    for (const session of sessionsToClose) {
      try {
        session.abortController.abort();
        this.sessions.delete(session.threadId);

        // Try to archive the thread
        if (this.client) {
          const channel = await this.client.channels.fetch(session.threadId).catch(() => null);
          if (channel && 'setArchived' in channel) {
            await (channel as ThreadChannel).send(`*Session closed. Total cost: $${session.totalCostUsd.toFixed(4)}*`);
            await (channel as ThreadChannel).setArchived(true);
          }
        }

        closedCount++;
      } catch (err) {
        console.error(`Failed to close session ${session.threadId}:`, err);
      }
    }

    return closedCount;
  }

  /**
   * Set the mode for a session.
   */
  async setMode(threadId: string, mode: SessionMode, thread: ThreadChannel): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      session.mode = mode;
    }
    await thread.send({
      content: `*${getModeDescription(mode)}*`,
      components: [createModeSelect(mode), createEndSessionButton()],
    });
  }

  /**
   * Replace the bot's reaction on a user message with a single emoji.
   * Removes any prior bot reactions, then adds the new one. No-op if message is missing.
   */
  private async setReaction(message: Message | undefined, emoji: string): Promise<void> {
    if (!message) return;
    try {
      const me = message.client.user?.id;
      for (const reaction of message.reactions.cache.values()) {
        if (reaction.emoji.name === emoji) continue;
        if (me && reaction.users.cache.has(me)) {
          await reaction.users.remove(me).catch(() => {});
        }
      }
      await message.react(emoji).catch(() => {});
    } catch {
      // Reactions are best-effort; never let them break processing.
    }
  }

  /**
   * Set the model for a session.
   */
  async setModel(threadId: string, model: string, modelLabel: string, thread: ThreadChannel): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      session.model = model;
      // If session is already active, update the model via SDK
      if (session.query) {
        try {
          await session.query.setModel(model);
        } catch (err) {
          console.error(`[SessionManager] Failed to setModel for ${threadId}:`, err);
        }
      }
    } else {
      // Session not yet created - store for when it's created
      this.pendingModels.set(threadId, model);
    }
    await thread.send({
      content: `*Model changed to **${modelLabel}**.*`,
    });
  }

  /**
   * Format a single question for display.
   */
  private formatSingleQuestion(question: Question, index: number, total: number): string {
    let message = "";
    if (total > 1) {
      message += `**Question ${index + 1}/${total}**\n`;
    }
    message += `**${question.header}**: ${question.question}\n`;

    if (question.options.length <= 4) {
      for (const opt of question.options) {
        message += `- **${opt.label}**`;
        if (opt.description) {
          message += `: ${opt.description}`;
        }
        message += "\n";
      }
    }

    return truncateMessage(message);
  }

  /**
   * Send the next question in a multi-question flow.
   */
  private async sendNextQuestion(
    threadId: string,
    thread: ThreadChannel,
    pendingPermission: PendingPermission
  ): Promise<void> {
    const { questions, currentQuestionIndex, toolUseId } = pendingPermission;
    if (!questions || currentQuestionIndex === undefined) return;

    const nextIndex = currentQuestionIndex + 1;
    if (nextIndex >= questions.length) return;

    const nextQuestion = questions[nextIndex];
    const questionMessage = this.formatSingleQuestion(nextQuestion, nextIndex, questions.length);
    const components = createQuestionComponents(toolUseId, nextIndex, nextQuestion);

    await thread.send({
      content: questionMessage,
      components,
    });

    pendingPermission.currentQuestionIndex = nextIndex;
  }

  /**
   * Get mode-specific system prompt addition.
   */
  private getModePrompt(mode: SessionMode): string {
    switch (mode) {
      case "plan":
        return "You are in PLAN mode. Analyze the request and create a detailed plan. Do NOT make any file changes or execute commands. Only explain what you would do.";
      case "ask":
        return "You are in ASK mode. Answer questions and provide information only. Do NOT make any file changes or execute commands.";
      case "action":
        return "";
    }
  }

  /**
   * Send a message to the Claude Code session for this thread.
   * Creates a new session on first message, resumes on subsequent ones.
   */
  async sendMessage(
    threadId: string,
    channelId: string,
    projectPath: string,
    userMessage: string,
    thread: ThreadChannel,
    images: ImageContent[] = [],
    pendingImages: PendingImage[] = [],
    audioTranscriptions: AudioTranscription[] = [],
    userDiscordMessage?: Message,
    authRetried = false,
  ): Promise<void> {
    let session = this.sessions.get(threadId);

    // Check concurrent session limit
    if (!session && this.sessions.size >= this.config.max_concurrent_sessions) {
      await thread.send("*Maximum concurrent sessions reached. Please close an existing session first.*");
      return;
    }

    // If login is pending, treat this message as the authorization code from the browser
    if (this.pendingLoginSession && this.pendingLoginResolve) {
      const code = userMessage.trim();
      this.pendingLoginResolve(code);
      this.pendingLoginResolve = null;
      return;
    }

    // Check Claude Code authentication on new session
    // If token expired, try auto-refresh before prompting for login
    if (!session && !isAuthenticated()) {
      const refreshed = await refreshToken();
      if (refreshed) {
        console.log("[SessionManager] Token auto-refreshed successfully");
      }
    }
    if (!session && !isAuthenticated()) {
      if (this.pendingLoginSession) {
        await thread.send("*Login is already in progress. Please paste the authorization code from the browser.*");
        return;
      }

      try {
        await thread.send("**Claude Code is not logged in.** Starting login flow...");
        const loginSession = startLogin();
        this.pendingLoginSession = loginSession;

        await thread.send(
          `**Please log in via the link below:**\n${loginSession.url}\n\n*After logging in the browser, you will receive an authorization code. **Paste that code here** to complete login.*`
        );

        // Wait for the user to send the code as a Discord message
        const code = await new Promise<string>((resolve) => {
          this.pendingLoginResolve = resolve;
        });

        await thread.send("*Exchanging code for API key...*");

        // Exchange code for API key (direct HTTP calls, no CLI dependency)
        const error = await loginSession.submitCode(code);

        this.pendingLoginSession = null;

        if (!error) {
          await thread.send("**Login successful!** You can now start a new session.");
        } else {
          const truncated = error.length > 500 ? error.substring(0, 500) + "..." : error;
          await thread.send(`*Login failed: ${truncated}*\n\n*Please try again by sending a new message.*`);
        }
        return;
      } catch (err) {
        this.pendingLoginSession = null;
        this.pendingLoginResolve = null;
        const errMsg = err instanceof Error ? err.message : String(err);
        await thread.send(`*Login error: ${errMsg}*`);
        return;
      }
    }

    // Mark as processing or queue message
    if (session) {
      if (session.isProcessing) {
        // Queue the message for later processing
        const queuedMessage: QueuedMessage = {
          userMessage,
          images,
          pendingImages,
          audioTranscriptions,
          userDiscordMessage,
        };
        session.messageQueue.push(queuedMessage);
        const queuePosition = session.messageQueue.length;
        this.setReaction(userDiscordMessage, "⏳");
        await thread.send(`*Message queued (position: ${queuePosition}). Will be processed after current task completes.*`);
        return;
      }
      session.isProcessing = true;
      session.lastActivityAt = Date.now();
    }
    this.setReaction(userDiscordMessage, "🤔");

    try {
      // Fire-and-forget: sendTyping can hang on archived threads / rate-limit queues.
      // The typingInterval below re-issues it every 8s anyway.
      thread.sendTyping().catch(() => {});

      // Emit user message for visualization (include file info if present)
      const fileCount = images.length + pendingImages.length;
      const displayMessage = fileCount > 0
        ? `${userMessage} [+${fileCount} file(s)]`
        : userMessage;
      this.emitMessage(threadId, 'user', displayMessage);

      const abortController = session?.abortController ?? new AbortController();

      const currentMode = session?.mode ?? "action";
      const modePrompt = this.getModePrompt(currentMode);
      const channelSystemPrompt = this.config.channel_system_prompts[channelId] ?? "";
      const globalContext = this.config.global_context ?? "";

      // Build final prompt with channel context (only on first message) and mode
      let textPrompt = userMessage;
      if (!session) {
        const contextParts: string[] = [];
        if (globalContext) {
          contextParts.push(`[Global Context]\n${globalContext}`);
        }
        if (channelSystemPrompt) {
          contextParts.push(`[System Context]\n${channelSystemPrompt}`);
        }
        if (contextParts.length > 0) {
          textPrompt = `${contextParts.join("\n\n")}\n\n[User Message]\n${userMessage}`;
        }
      }
      if (modePrompt) {
        textPrompt = `${modePrompt}\n\n${textPrompt}`;
      }

      // Add audio transcription if present
      if (audioTranscriptions.length > 0) {
        const audioInfo = audioTranscriptions.map((audio) => {
          const durationStr = audio.duration ? ` (${Math.round(audio.duration)}s)` : "";
          return `**${audio.filename}${durationStr}:**\n${audio.text}`;
        }).join("\n\n");
        textPrompt += `\n\n[Voice Message Transcription]\nThe user sent a voice message. Here is the transcribed content:\n${audioInfo}`;
      }

      // Add image save instruction if images are present
      if (pendingImages.length > 0) {
        const imageInfo = pendingImages.map((img, i) =>
          `  [${i}] ${img.filename} (${img.mediaType})`
        ).join("\n");
        textPrompt += `\n\n[Discord Images]\nThe user has attached ${pendingImages.length} image(s). You can save them to the project using the Write tool with base64-decoded content, or ask me to save them by saying "save image [index] to [path]".\n${imageInfo}`;
      }

      // Update existing session's pending images
      if (session && pendingImages.length > 0) {
        session.pendingImages = pendingImages;
      }

      // Build prompt with images if present
      const buildPrompt = (): string | AsyncIterable<SDKUserMessage> => {
        if (images.length === 0) {
          return textPrompt;
        }

        // Create content blocks with images and text
        const contentBlocks: Array<
          | { type: "text"; text: string }
          | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } }
        > = [];

        // Add images first
        for (const img of images) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: img.data,
            },
          });
        }

        // Add text prompt
        if (textPrompt) {
          contentBlocks.push({ type: "text", text: textPrompt });
        }

        // Return as AsyncIterable
        const userMessage: SDKUserMessage = {
          type: "user",
          message: {
            role: "user",
            content: contentBlocks,
          },
          parent_tool_use_id: null,
          session_id: session?.sessionId ?? "",
        };

        return (async function* () {
          yield userMessage;
        })();
      };

      const finalPrompt = buildPrompt();

      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        options: {
          signal: AbortSignal;
          suggestions?: import("@anthropic-ai/claude-agent-sdk").PermissionUpdate[];
          blockedPath?: string;
          decisionReason?: string;
          toolUseID: string;
        }
      ): Promise<PermissionResult> => {
        const currentSession = this.sessions.get(threadId);
        if (!currentSession) {
          return { behavior: "deny", message: "Session not found" };
        }

        // Handle AskUserQuestion specially - show question options instead of permission buttons
        if (isAskUserQuestion(toolName)) {
          const questions = input.questions as Question[] | undefined;
          if (questions && questions.length > 0) {
            // Show first question with its options
            const firstQuestion = questions[0];
            const questionMessage = this.formatSingleQuestion(firstQuestion, 0, questions.length);
            const components = createQuestionComponents(options.toolUseID, 0, firstQuestion);

            await thread.send({
              content: questionMessage,
              components,
            });

            // Create promise that will be resolved by question button interaction
            return new Promise<PermissionResult>((resolve) => {
              currentSession.pendingPermission = {
                toolName,
                input,
                toolUseId: options.toolUseID,
                suggestions: options.suggestions,
                resolve,
                isQuestion: true,
                questions,
                selectedAnswers: {},
                currentQuestionIndex: 0,
              };

              options.signal.addEventListener("abort", () => {
                if (currentSession.pendingPermission?.toolUseId === options.toolUseID) {
                  currentSession.pendingPermission = undefined;
                  resolve({ behavior: "deny", message: "Request was aborted" });
                }
              });
            });
          }
        }

        // Send permission request message with buttons
        const permissionMessage = truncateMessage(formatPermissionRequest(toolName, input, options.decisionReason));
        await thread.send({
          content: permissionMessage,
          components: [createPermissionButtons(options.toolUseID)],
        });

        // Create promise that will be resolved by button interaction
        return new Promise<PermissionResult>((resolve) => {
          currentSession.pendingPermission = {
            toolName,
            input,
            toolUseId: options.toolUseID,
            suggestions: options.suggestions,
            resolve,
          };

          // Handle abort signal
          options.signal.addEventListener("abort", () => {
            if (currentSession.pendingPermission?.toolUseId === options.toolUseID) {
              currentSession.pendingPermission = undefined;
              resolve({ behavior: "deny", message: "Request was aborted" });
            }
          });
        });
      };

      // Build MCP servers config if session exists (for subsession tools)
      const mcpServersConfig = session ? {
        subsession: {
          type: 'sdk' as const,
          name: 'subsession',
          instance: createMcpServerForSession(session),
        },
      } : undefined;

      // 서브세션인 경우 커스텀 시스템 프롬프트 추가
      const systemPromptConfig = session && isSubsession(session) && session.subsessionSystemPrompt
        ? { type: "preset" as const, preset: "claude_code" as const, append: session.subsessionSystemPrompt }
        : { type: "preset" as const, preset: "claude_code" as const };

      const response = query({
        prompt: finalPrompt,
        options: {
          cwd: projectPath,
          permissionMode: this.config.permission_mode,
          systemPrompt: systemPromptConfig,
          settingSources: ["project"],
          maxTurns: this.config.max_turns,
          maxBudgetUsd: this.config.max_budget_usd,
          abortController,
          canUseTool,
          allowedTools: ['mcp__subsession__*'],
          ...(mcpServersConfig ? { mcpServers: mcpServersConfig } : {}),
          ...(session?.sessionId ? { resume: session.sessionId } : {}),
          ...(session?.model || this.pendingModels.get(threadId) ? { model: session?.model ?? this.pendingModels.get(threadId) } : {}),
        },
      });

      // Keep typing indicator alive
      const typingInterval = setInterval(() => {
        thread.sendTyping().catch(() => {});
      }, 8_000);

      let lastTextMessage = "";

      try {
        for await (const message of response) {
          if (message.type === "system" && message.subtype === "init") {
            // First message: capture session ID

            // 서브세션인 경우: 기존 세션 정보 업데이트만
            if (session && isSubsession(session)) {
              session.sessionId = message.session_id;
              session.query = response;
              session.isProcessing = true;

              // 서브세션용 MCP 서버 설정 (child 도구들)
              response.setMcpServers({
                subsession: {
                  type: 'sdk',
                  name: 'subsession',
                  instance: createMcpServerForSession(session),
                },
              }).catch((err) => {
                console.error(`Failed to set MCP servers for subsession ${threadId}:`, err);
              });
            } else {
              // 메인 세션인 경우: 새 세션 생성
              // Apply pending model if set before session creation
              const pendingModel = this.pendingModels.get(threadId);
              if (pendingModel) {
                this.pendingModels.delete(threadId);
              }

              const sessionInfo: MainSessionInfo = {
                sessionId: message.session_id,
                threadId,
                channelId,
                projectPath,
                query: response,
                abortController,
                totalCostUsd: 0,
                lastActivityAt: Date.now(),
                isProcessing: true,
                mode: "action",
                model: pendingModel,
                pendingImages: pendingImages.length > 0 ? pendingImages : undefined,
                messageQueue: [],
                // Main session specific fields
                isSubsession: false,
                childSubsessions: new Map(),
                nextSubsessionId: 1,
              };
              this.sessions.set(threadId, sessionInfo);
              session = sessionInfo;

              // Save thread info to DB
              try {
                const messageStore = getMessageStore();
                messageStore.upsertThread(threadId, channelId, thread.name);
              } catch (err) {
                console.error('[SessionManager] Failed to save thread info to DB:', err);
              }

              // 메인 세션용 MCP 서버 설정 (parent 도구들)
              response.setMcpServers({
                subsession: {
                  type: 'sdk',
                  name: 'subsession',
                  instance: createMcpServerForSession(sessionInfo),
                },
              }).catch((err) => {
                console.error(`Failed to set MCP servers for thread ${threadId}:`, err);
              });

              // Rename thread based on user's first message
              const title = generateThreadTitle(userMessage);
              if (title) {
                thread.setName(title).catch((err) => {
                  console.error(`Failed to rename thread ${threadId}:`, err);
                });
              }
            }
          }

          if (message.type === "assistant") {
            // Update reaction based on what kind of work the model is doing
            const blocks = (message as any).message?.content;
            if (Array.isArray(blocks)) {
              const hasToolUse = blocks.some((b: any) => b?.type === "tool_use");
              const hasText = blocks.some((b: any) => b?.type === "text" && b.text?.trim());
              if (hasToolUse) {
                this.setReaction(userDiscordMessage, "🔍");
              } else if (hasText) {
                this.setReaction(userDiscordMessage, "💭");
              }
            }
            const text = formatAssistantMessage(message);
            if (text && text !== lastTextMessage) {
              lastTextMessage = text;
              const chunks = splitMessage(text);

              // Emit message for visualization
              this.emitMessage(threadId, 'assistant', text);

              // Send all chunks, with TTS on the last chunk if enabled
              for (let i = 0; i < chunks.length; i++) {
                const isLastChunk = i === chunks.length - 1;

                if (isLastChunk && this.config.tts_enabled) {
                  // Generate TTS for the full response
                  const ttsText = extractTextForTTS(text);
                  const audioBuffer = await generateAudio(ttsText);

                  if (audioBuffer) {
                    const attachment = new AttachmentBuilder(audioBuffer, {
                      name: "response.mp3",
                      description: "Claude's response audio",
                    });
                    await thread.send({
                      content: chunks[i],
                      files: [attachment],
                    });
                  } else {
                    await thread.send(chunks[i]);
                  }
                } else {
                  await thread.send(chunks[i]);
                }
              }
            }
          }

          if (message.type === "result") {
            const resultText = formatResultMessage(message);
            if (session) {
              session.totalCostUsd = message.total_cost_usd;
            }

            // Emit result message with cost for visualization
            this.emitMessage(threadId, 'system', resultText, message.total_cost_usd);

            await thread.send({
              content: resultText,
              components: [createModeSelect(session?.mode ?? "action"), createEndSessionButton()],
            });

            const isError = (message as any).subtype && (message as any).subtype !== "success";
            this.setReaction(userDiscordMessage, isError ? "❌" : "✅");
            // Queue processing is handled exclusively by the outer finally block
            // to avoid a race condition where outer finally overwrites isProcessing=true
            // set by the next sendMessage call.
          }
        }
      } finally {
        clearInterval(typingInterval);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAuth401 = errMsg.includes("401") || errMsg.includes("authentication_error") || errMsg.includes("Invalid authentication credentials");

      // Auth 401 safety net: a spawned cli.js token went stale (rare lineage
      // collision). Refresh the bot-private token and retry this message ONCE
      // so the user never sees the error. The refresh updates the env token
      // that the next spawned cli.js inherits.
      if (isAuth401 && !authRetried && !errMsg.includes("aborted")) {
        console.warn(`[SessionManager] 401 on thread ${threadId} — refreshing bot token and retrying once...`);
        if (session) { session.isProcessing = false; session.query = null; }
        const refreshed = await refreshBotToken().catch(() => false);
        if (refreshed) {
          await this.sendMessage(
            threadId, channelId, projectPath, userMessage, thread,
            images, pendingImages, audioTranscriptions, userDiscordMessage, true,
          );
          return;
        }
      }

      if (!errMsg.includes("aborted")) {
        console.error(`Session error for thread ${threadId}:`, err);
        // Truncate error message to fit Discord's 2000 char limit
        const truncatedErr = errMsg.length > 1900 ? errMsg.slice(0, 1900) + "..." : errMsg;
        await thread.send(`*Session error: ${truncatedErr}*`).catch(() => {});
      }
      this.setReaction(userDiscordMessage, "❌");
    } finally {
      if (session) {
        session.isProcessing = false;
        session.query = null;

        // Process next queued message. This is the sole queue processor.
        // processNextQueuedMessage calls sendMessage synchronously (up to the first
        // await), so sendMessage sets session.isProcessing=true before this finally
        // block returns — eliminating the race condition where a concurrent message
        // could see isProcessing=false and bypass the queue.
        if (session.messageQueue.length > 0) {
          this.processNextQueuedMessage(threadId, thread);
        }
      }
    }
  }

  /**
   * Process the next message in the queue for a session.
   */
  private processNextQueuedMessage(threadId: string, thread: ThreadChannel): void {
    const session = this.sessions.get(threadId);
    if (!session || session.messageQueue.length === 0) {
      return;
    }

    const nextMessage = session.messageQueue.shift()!;
    const remainingCount = session.messageQueue.length;

    // Notify user about processing queued message
    thread.send(
      remainingCount > 0
        ? `*Processing queued message... (${remainingCount} more in queue)*`
        : `*Processing queued message...*`
    ).catch(() => {});

    // Process the queued message (don't await to avoid blocking)
    this.sendMessage(
      threadId,
      session.channelId,
      session.projectPath,
      nextMessage.userMessage,
      thread,
      nextMessage.images,
      nextMessage.pendingImages,
      nextMessage.audioTranscriptions ?? [],
      nextMessage.userDiscordMessage,
    ).catch((err) => {
      console.error(`Failed to process queued message for thread ${threadId}:`, err);
    });
  }

  /**
   * Handle permission response from Discord button interaction.
   */
  handlePermissionResponse(
    threadId: string,
    toolUseId: string,
    action: "allow" | "allow_always" | "deny"
  ): boolean {
    const session = this.sessions.get(threadId);
    if (!session?.pendingPermission) {
      return false;
    }

    if (session.pendingPermission.toolUseId !== toolUseId) {
      return false;
    }

    const { resolve, suggestions, input } = session.pendingPermission;
    session.pendingPermission = undefined;

    switch (action) {
      case "allow":
        resolve({
          behavior: "allow",
          updatedInput: input,
        });
        break;
      case "allow_always":
        resolve({
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: suggestions,
        });
        break;
      case "deny":
        resolve({
          behavior: "deny",
          message: "User denied permission",
          interrupt: true,
        });
        break;
    }

    return true;
  }

  /**
   * Handle question response from Discord button/select interaction.
   */
  async handleQuestionResponse(
    threadId: string,
    toolUseId: string,
    questionIndex: number,
    selectedOption: number | string,
    thread: ThreadChannel
  ): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session?.pendingPermission?.isQuestion) {
      return false;
    }

    if (session.pendingPermission.toolUseId !== toolUseId) {
      return false;
    }

    const { resolve, input, questions, currentQuestionIndex } = session.pendingPermission;
    if (!questions || !questions[questionIndex]) {
      return false;
    }

    // Build the answer based on selected option
    let answer: string;
    if (typeof selectedOption === "number") {
      const option = questions[questionIndex].options[selectedOption];
      answer = option?.label ?? String(selectedOption);
    } else {
      // Custom text input
      answer = selectedOption;
    }

    // Store the answer
    const header = questions[questionIndex].header;
    session.pendingPermission.selectedAnswers = session.pendingPermission.selectedAnswers || {};
    session.pendingPermission.selectedAnswers[header] = answer;

    // Check if there are more questions
    const nextIndex = (currentQuestionIndex ?? 0) + 1;
    if (nextIndex < questions.length) {
      // Send next question
      await this.sendNextQuestion(threadId, thread, session.pendingPermission);
      return true;
    }

    // All questions answered, resolve
    const answers = session.pendingPermission.selectedAnswers;
    const updatedInput = {
      ...input,
      answers,
    };

    session.pendingPermission = undefined;

    resolve({
      behavior: "allow",
      updatedInput,
    });

    return true;
  }

  /**
   * Handle question select menu response (for multi-select).
   */
  async handleQuestionSelectResponse(
    threadId: string,
    toolUseId: string,
    questionIndex: number,
    selectedValues: string[],
    thread: ThreadChannel
  ): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session?.pendingPermission?.isQuestion) {
      return false;
    }

    if (session.pendingPermission.toolUseId !== toolUseId) {
      return false;
    }

    const { resolve, input, questions, currentQuestionIndex } = session.pendingPermission;
    if (!questions || !questions[questionIndex]) {
      return false;
    }

    // Build the answer based on selected options
    const selectedLabels = selectedValues.map((v) => {
      const idx = parseInt(v, 10);
      if (isNaN(idx)) return v;
      return questions[questionIndex].options[idx]?.label ?? v;
    });

    const answer = selectedLabels.join(", ");
    const header = questions[questionIndex].header;

    session.pendingPermission.selectedAnswers = session.pendingPermission.selectedAnswers || {};
    session.pendingPermission.selectedAnswers[header] = answer;

    // Check if there are more questions
    const nextIndex = (currentQuestionIndex ?? 0) + 1;
    if (nextIndex < questions.length) {
      // Send next question
      await this.sendNextQuestion(threadId, thread, session.pendingPermission);
      return true;
    }

    // All questions answered, resolve
    const answers = session.pendingPermission.selectedAnswers;
    const updatedInput = {
      ...input,
      answers,
    };

    session.pendingPermission = undefined;

    resolve({
      behavior: "allow",
      updatedInput,
    });

    return true;
  }

  /**
   * Handle question cancel button.
   */
  handleQuestionCancel(threadId: string, toolUseId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session?.pendingPermission) {
      return false;
    }

    if (session.pendingPermission.toolUseId !== toolUseId) {
      return false;
    }

    const { resolve } = session.pendingPermission;
    session.pendingPermission = undefined;

    resolve({
      behavior: "deny",
      message: "User cancelled the question",
      interrupt: true,
    });

    return true;
  }

  /**
   * Stop (abort) the current session for a thread.
   */
  async stopSession(threadId: string, thread: ThreadChannel): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      await thread.send("*No active session in this thread.*");
      return;
    }

    session.abortController.abort();
    this.sessions.delete(threadId);
    await thread.send(`*Session stopped. Total cost: $${session.totalCostUsd.toFixed(4)}*`);
  }

  /**
   * Get cost info for the current session.
   */
  async getCost(threadId: string, thread: ThreadChannel): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      await thread.send("*No active session in this thread.*");
      return;
    }

    await thread.send(`*Current session cost: $${session.totalCostUsd.toFixed(4)}*`);
  }

  /**
   * Save a pending image to the project directory.
   */
  async saveImage(
    threadId: string,
    imageIndex: number,
    targetPath: string,
    thread: ThreadChannel
  ): Promise<string | null> {
    const session = this.sessions.get(threadId);
    if (!session) {
      await thread.send("*No active session in this thread.*");
      return null;
    }

    if (!session.pendingImages || session.pendingImages.length === 0) {
      await thread.send("*No images available to save. Send an image first.*");
      return null;
    }

    const image = session.pendingImages[imageIndex];
    if (!image) {
      await thread.send(`*Invalid image index. Available: 0-${session.pendingImages.length - 1}*`);
      return null;
    }

    const result = await saveDiscordImage(image, session.projectPath, targetPath);
    if (result.success && result.savedPath) {
      await thread.send(`*Image saved to: \`${result.savedPath}\`*`);
      return result.savedPath;
    } else {
      await thread.send(`*Failed to save image: ${result.error}*`);
      return null;
    }
  }

  /**
   * List pending images for the session.
   */
  listPendingImages(threadId: string): string {
    const session = this.sessions.get(threadId);
    if (!session?.pendingImages || session.pendingImages.length === 0) {
      return "No images available.";
    }
    return formatPendingImagesList(session.pendingImages);
  }

  /**
   * End the session and archive the thread.
   */
  async endSession(threadId: string, thread: ThreadChannel): Promise<void> {
    const session = this.sessions.get(threadId);

    if (session) {
      session.abortController.abort();
      await thread.send(`*Session ended. Total cost: $${session.totalCostUsd.toFixed(4)}*`);
      this.sessions.delete(threadId);
    }

    // Archive the thread
    await thread.setArchived(true);
  }

  private cleanupIdleSessions(timeoutMs: number): void {
    const now = Date.now();
    for (const [threadId, session] of this.sessions) {
      if (!session.isProcessing && now - session.lastActivityAt > timeoutMs) {
        console.log(`Cleaning up idle session for thread ${threadId}`);
        session.abortController.abort();
        this.sessions.delete(threadId);

        // Notify thread and archive it
        this.notifyAndArchiveIdleSession(threadId, session).catch((err) => {
          console.error(`Failed to notify/archive idle session ${threadId}:`, err);
        });
      }
    }
  }

  /**
   * Notify the thread about session timeout and archive it.
   */
  private async notifyAndArchiveIdleSession(threadId: string, session: SessionInfo): Promise<void> {
    if (!this.client) return;

    try {
      const channel = await this.client.channels.fetch(threadId).catch(() => null);
      if (!channel || !("send" in channel)) return;

      const thread = channel as ThreadChannel;
      const timeoutMinutes = this.config.session_timeout_minutes;

      await thread.send(
        `*Session automatically ended due to ${timeoutMinutes} minutes of inactivity. Total cost: $${session.totalCostUsd.toFixed(4)}*`
      );
      await thread.setArchived(true);
    } catch (err) {
      console.error(`Failed to notify/archive thread ${threadId}:`, err);
    }
  }

  /**
   * Gracefully shutdown all sessions with summaries.
   */
  async gracefulShutdown(): Promise<void> {
    clearInterval(this.cleanupInterval);

    if (this.sessions.size === 0 || !this.client) {
      this.sessions.clear();
      return;
    }

    console.log(`Gracefully shutting down ${this.sessions.size} active session(s)...`);

    const shutdownPromises = Array.from(this.sessions.entries()).map(
      async ([threadId, session]) => {
        try {
          session.abortController.abort();

          const channel = await this.client!.channels.fetch(threadId).catch(() => null);
          if (!channel || !("send" in channel)) return;

          const thread = channel as ThreadChannel;

          // Request summary from Claude
          const summaryResponse = query({
            prompt:
              "Summarize this conversation briefly in 2-3 sentences for future reference. Focus on what was discussed and any outcomes. Reply in the same language the user used.",
            options: {
              cwd: session.projectPath,
              permissionMode: "default",
              maxTurns: 1,
              maxBudgetUsd: 0.05,
                            resume: session.sessionId,
            },
          });

          let summary = "";
          for await (const message of summaryResponse) {
            if (message.type === "assistant" && message.message.content) {
              for (const block of message.message.content) {
                if (block.type === "text") {
                  summary += block.text;
                }
              }
            }
          }

          const shutdownMessage = [
            "**Session closed due to server shutdown**",
            "",
            `**Summary:** ${summary || "No summary available."}`,
            "",
            `*Total cost: $${session.totalCostUsd.toFixed(4)}*`,
          ].join("\n");

          await thread.send(shutdownMessage);
          await thread.setArchived(true);
        } catch (err) {
          console.error(`Failed to gracefully close session ${threadId}:`, err);
        }
      }
    );

    await Promise.allSettled(shutdownPromises);
    this.sessions.clear();
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const [, session] of this.sessions) {
      session.abortController.abort();
    }
    this.sessions.clear();
  }

  // ============================================
  // Subsession Management
  // ============================================

  /**
   * Build Stateful Agent system prompt
   */
  private buildSubsessionSystemPrompt(
    id: number,
    alias: string,
    description: string,
    parentThreadId: string,
    context?: SubsessionContext
  ): string {
    let prompt = `## 당신의 정체

당신은 **Stateful Agent**입니다. 메인 에이전트와 협업하는 독립 에이전트로, 별도의 Discord 스레드에서 실행됩니다.

**중요**: 메인 에이전트는 당신의 일반 텍스트 응답을 볼 수 없습니다.
모든 결과, 질문, 보고는 **반드시 MCP 도구를 통해** 전달해야 합니다.

## 역할
${description}

## 에이전트 정보
- ID: ${id}
- Alias: ${alias}
- 부모 스레드: ${parentThreadId}
`;

    if (context) {
      prompt += `\n## 컨텍스트\n`;
      if (context.background) {
        prompt += `### 배경\n${context.background}\n`;
      }
      if (context.relevant_files?.length) {
        prompt += `### 관련 파일\n${context.relevant_files.map(f => `- ${f}`).join('\n')}\n`;
      }
      if (context.constraints?.length) {
        prompt += `### 제약 조건\n${context.constraints.map(c => `- ${c}`).join('\n')}\n`;
      }
    }

    prompt += `
## 통신 방식 (필수!)

메인 에이전트와 소통하려면 **반드시 MCP 도구를 사용**해야 합니다:

| 상황 | 사용할 도구 |
|------|------------|
| 결과 보고 | \`notify_parent(type: "info", message: "...")\` |
| 경고/주의 | \`notify_parent(type: "warning", message: "...")\` |
| 질문하기 | \`ask_parent(type: "question", message: "...")\` |
| 승인 요청 | \`ask_parent(type: "approval_request", message: "...")\` |

⚠️ **텍스트만 출력하고 도구를 호출하지 않으면 메인 에이전트는 아무것도 받지 못합니다!**

## 코드 변경 규칙

1. **분석/조사**: 자유롭게 수행
2. **코드 변경 전**: 반드시 메인에 승인 요청
   - \`ask_parent(type: "approval_request", message: "변경 계획...")\`
   - 승인 받은 후 진행
3. **메인이 명확히 지시한 경우**: 바로 수행 가능

## 사용 가능한 도구
- \`notify_parent\`: 메인에게 단방향 알림 (결과 보고, 정보 전달, 경고)
- \`ask_parent\`: 메인에게 질문/승인 요청 (응답 대기)
- \`update_progress\`: 진행 상황 업데이트
- \`list_agents\`: 형제 에이전트 목록 확인 (읽기 전용)

## 작업 흐름 예시

\`\`\`
1. 작업 수행 (분석, 조사, 코드 변경 등)
2. 결과를 MCP 도구로 보고:
   - 성공: notify_parent(type: "info", message: "완료: [결과 요약]")
   - 질문: ask_parent(type: "question", message: "[질문 내용]")
   - 승인 필요: ask_parent(type: "approval_request", message: "[변경 계획]")
\`\`\`

**절대로 MCP 도구 호출 없이 작업을 마치지 마세요.**
`;

    return prompt;
  }

  /**
   * Handle subsession creation callback
   */
  private async handleSubsessionCreated(
    state: SubsessionState,
    description: string,
    parentThreadId: string,
    context?: SubsessionContext
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Discord client not initialized');
    }

    // Find parent session by threadId
    const parentSession = this.sessions.get(parentThreadId);
    if (!parentSession || !isMainSession(parentSession)) {
      throw new Error(`Parent session not found for threadId: ${parentThreadId}`);
    }

    // Register in parent's childSubsessions
    parentSession.childSubsessions.set(state.id, state);

    // Get the subsession thread
    const thread = await this.client.channels.fetch(state.threadId) as ThreadChannel;
    if (!thread) {
      throw new Error('Subsession thread not found');
    }

    // Build system prompt for subsession
    const systemPrompt = this.buildSubsessionSystemPrompt(
      state.id,
      state.alias,
      description,
      parentSession.threadId,
      context
    );

    // Send initial message to agent thread
    await thread.send(`*Stateful Agent \`${state.alias}\` (ID: ${state.id}) 시작됨*\n\n${description}`);

    // Create subsession SessionInfo
    const subsessionInfo: SubsessionSessionInfo = {
      sessionId: '', // Will be set on first message
      threadId: state.threadId,
      channelId: parentSession.channelId,
      projectPath: parentSession.projectPath,
      query: null,
      abortController: new AbortController(),
      totalCostUsd: 0,
      lastActivityAt: Date.now(),
      isProcessing: false,
      mode: 'action',
      messageQueue: [],
      // Subsession specific fields
      isSubsession: true,
      subsessionId: state.id,
      alias: state.alias,
      parentThreadId: parentSession.threadId,
      subsessionSystemPrompt: systemPrompt,  // 시스템 프롬프트 저장
    };

    this.sessions.set(state.threadId, subsessionInfo);

    // Register message handler for subsession (receives tasks from parent)
    interSessionBus.registerHandler(state.threadId, async (message) => {
      if (message.type === 'task') {
        // Received task from parent - send to subsession
        await this.sendMessage(
          state.threadId,
          parentSession!.channelId,
          parentSession!.projectPath,
          message.content,
          thread
        );
      }
    });

    // Register message handler for parent session (receives notify/request from agents)
    // Only register once (check if already registered)
    const parentThread = await this.client.channels.fetch(parentSession.threadId) as ThreadChannel;
    if (parentThread && !interSessionBus.hasHandler(parentSession.threadId)) {
      interSessionBus.registerHandler(parentSession.threadId, async (message) => {
        if (message.type === 'notify' || message.type === 'request') {
          // Format message to inject into main session
          const typeLabel = message.type === 'request'
            ? (message.content.includes('승인') ? '승인 요청' : '질문')
            : '알림';

          const formattedMessage = [
            `[에이전트 메시지: ${message.from.alias || 'unknown'}]`,
            `타입: ${typeLabel}`,
            message.requestId ? `요청 ID: ${message.requestId}` : null,
            `내용: ${message.content}`,
          ].filter(Boolean).join('\n');

          // Get fresh parent session reference
          const currentParentSession = this.sessions.get(parentSession.threadId);

          // If main session is processing AND has an active query, inject directly
          if (currentParentSession?.isProcessing && currentParentSession?.query) {
            try {
              // Use streamInput to inject into ongoing conversation
              // This avoids the queue deadlock when subsessions send ask_parent/notify_parent
              const userMessage: SDKUserMessage = {
                type: 'user',
                message: {
                  role: 'user',
                  content: formattedMessage,
                },
                parent_tool_use_id: null,
                session_id: currentParentSession.sessionId,
                isSynthetic: true,
              };

              // Create async iterable for streamInput
              await currentParentSession.query.streamInput((async function* () {
                yield userMessage;
              })());

              console.log(`[SessionManager] Injected agent message directly into main session: ${message.from.alias}`);
            } catch (err) {
              console.error(`[SessionManager] Failed to inject message, falling back to queue:`, err);
              // Fallback to queue if injection fails
              await this.sendMessage(
                parentSession!.threadId,
                parentSession!.channelId,
                parentSession!.projectPath,
                formattedMessage,
                parentThread
              );
            }
          } else {
            // Main session is idle, send normally
            await this.sendMessage(
              parentSession!.threadId,
              parentSession!.channelId,
              parentSession!.projectPath,
              formattedMessage,
              parentThread
            );
          }
        }
      });
    }
  }

  /**
   * Handle subsession closed callback
   */
  private async handleSubsessionClosed(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Abort the session
    session.abortController.abort();

    // If it's a subsession, remove from parent's childSubsessions
    if (isSubsession(session)) {
      const parentSession = this.sessions.get(session.parentThreadId);
      if (parentSession && isMainSession(parentSession)) {
        parentSession.childSubsessions.delete(session.subsessionId);
      }
    }

    // Remove from sessions
    this.sessions.delete(threadId);

    // Cleanup InterSessionBus
    interSessionBus.cleanup(threadId);
  }

  /**
   * Check if a session is a subsession
   */
  isSessionSubsession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    return session ? isSubsession(session) : false;
  }

  /**
   * Get parent thread ID for a subsession
   */
  getParentThreadId(threadId: string): string | undefined {
    const session = this.sessions.get(threadId);
    if (session && isSubsession(session)) {
      return session.parentThreadId;
    }
    return undefined;
  }

  // ============================================
  // Visualization Support
  // ============================================

  /**
   * Register a callback to receive message events for visualization.
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * Emit a message event to all registered callbacks and save to DB.
   */
  private emitMessage(threadId: string, role: 'user' | 'assistant' | 'system', content: string, cost?: number): void {
    // Save to local DB
    try {
      const messageStore = getMessageStore();
      messageStore.addMessage({
        id: `${threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        threadId,
        timestamp: Date.now(),
        role,
        content,
        cost,
      });
    } catch (err) {
      console.error('[SessionManager] Failed to save message to DB:', err);
    }

    // Notify callbacks
    for (const callback of this.messageCallbacks) {
      try {
        callback(threadId, role, content, cost);
      } catch (err) {
        console.error('[SessionManager] Message callback error:', err);
      }
    }
  }

  /**
   * Get all active sessions (for visualization).
   */
  getAllSessions(): Map<string, SessionInfo> {
    return this.sessions;
  }

  /**
   * Get Discord client reference (for visualization).
   */
  getDiscordClient(): Client | null {
    return this.client;
  }
}
