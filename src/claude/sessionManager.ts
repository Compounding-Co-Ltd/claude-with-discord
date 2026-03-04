import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import type { PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AttachmentBuilder, type Client, type ThreadChannel } from "discord.js";
import type { AppConfig, SessionInfo, SessionMode, PendingPermission, ImageContent, PendingImage, QueuedMessage, AudioTranscription } from "../types.js";
import { getConfig } from "../config.js";
import { formatAssistantMessage, formatResultMessage, generateThreadTitle } from "./messageFormatter.js";
import { splitMessage, truncateMessage } from "../discord/utils/messageSplitter.js";
import { createEndSessionButton } from "../discord/components/endSessionButton.js";
import { createModeButtons, getModeDescription } from "../discord/components/modeButtons.js";
import { createPermissionButtons, formatPermissionRequest, isAskUserQuestion } from "../discord/components/permissionButtons.js";
import { createQuestionComponents, formatQuestionMessage, type Question } from "../discord/components/questionButtons.js";
import { saveDiscordImage, formatPendingImagesList } from "../utils/imageSaver.js";
import { generateAudio, extractTextForTTS } from "../utils/audioGenerator.js";
import { isAuthenticated, startLogin, type LoginSession } from "../services/claudeAuth.js";

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private client: Client | null = null;
  private pendingLoginSession: LoginSession | null = null;
  private pendingLoginResolve: ((token: string) => void) | null = null;

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
  }

  getSession(threadId: string): SessionInfo | undefined {
    return this.sessions.get(threadId);
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
      components: [createModeButtons(mode), createEndSessionButton()],
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
        };
        session.messageQueue.push(queuedMessage);
        const queuePosition = session.messageQueue.length;
        await thread.send(`*Message queued (position: ${queuePosition}). Will be processed after current task completes.*`);
        return;
      }
      session.isProcessing = true;
      session.lastActivityAt = Date.now();
    }

    try {
      await thread.sendTyping();

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
          | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
        > = [];

        // Add images first
        for (const img of images) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType,
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

      const response = query({
        prompt: finalPrompt,
        options: {
          cwd: projectPath,
          permissionMode: this.config.permission_mode,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["project"],
          maxTurns: this.config.max_turns,
          maxBudgetUsd: this.config.max_budget_usd,
          abortController,
          canUseTool,
                    ...(session?.sessionId ? { resume: session.sessionId } : {}),
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
            const sessionInfo: SessionInfo = {
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
              pendingImages: pendingImages.length > 0 ? pendingImages : undefined,
              messageQueue: [],
            };
            this.sessions.set(threadId, sessionInfo);
            session = sessionInfo;

            // Rename thread based on user's first message
            const title = generateThreadTitle(userMessage);
            if (title) {
              thread.setName(title).catch((err) => {
                console.error(`Failed to rename thread ${threadId}:`, err);
              });
            }
          }

          if (message.type === "assistant") {
            const text = formatAssistantMessage(message);
            if (text && text !== lastTextMessage) {
              lastTextMessage = text;
              const chunks = splitMessage(text);

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
            await thread.send({
              content: resultText,
              components: [createModeButtons(session?.mode ?? "action"), createEndSessionButton()],
            });

            // Task completed successfully, process next queued message
            if (session && session.messageQueue.length > 0) {
              session.isProcessing = false;
              session.query = null;
              this.processNextQueuedMessage(threadId, thread);
            }
          }
        }
      } finally {
        clearInterval(typingInterval);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes("aborted")) {
        console.error(`Session error for thread ${threadId}:`, err);
        // Truncate error message to fit Discord's 2000 char limit
        const truncatedErr = errMsg.length > 1900 ? errMsg.slice(0, 1900) + "..." : errMsg;
        await thread.send(`*Session error: ${truncatedErr}*`).catch(() => {});
      }
    } finally {
      if (session) {
        session.isProcessing = false;
        session.query = null;

        // Process next queued message if any (in case result event didn't trigger it)
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
}
