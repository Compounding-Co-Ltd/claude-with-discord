import type { Query, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type SessionMode = "action" | "plan" | "ask";

export interface ImageContent {
  type: "image";
  data: string;
  mediaType: string;
}

export interface PendingImage {
  index: number;
  url: string;
  filename: string;
  data: string;
  mediaType: string;
}

export interface AudioTranscription {
  filename: string;
  text: string;
  duration?: number;
}

export interface QueuedMessage {
  userMessage: string;
  images: ImageContent[];
  pendingImages: PendingImage[];
  audioTranscriptions?: AudioTranscription[];
}

export interface AppConfig {
  channel_project_map: Record<string, string>;
  channel_system_prompts: Record<string, string>;
  global_context?: string;
  permission_mode: "default" | "acceptEdits" | "bypassPermissions";
  max_budget_usd: number;
  max_turns: number;
  max_concurrent_sessions: number;
  session_timeout_minutes: number;
  allowed_users: string[];
  openai_api_key?: string;
  whisper_mode?: "api" | "local";  // "api" uses OpenAI API, "local" uses local whisper CLI
  whisper_model?: string;  // For local mode: tiny, base, small, medium, large
  // TTS settings
  tts_enabled?: boolean;  // Enable TTS for Claude responses (default: false)
  tts_voice?: string;  // Voice to use: ko-KR-SunHiNeural (female), ko-KR-InJoonNeural (male)
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
  // For AskUserQuestion
  isQuestion?: boolean;
  questions?: Question[];
  selectedAnswers?: Record<string, string>;
  awaitingCustomInput?: boolean;
  customInputQuestionIndex?: number;
  currentQuestionIndex?: number;
}

export interface SessionInfo {
  sessionId: string;
  threadId: string;
  channelId: string;
  projectPath: string;
  query: Query | null;
  abortController: AbortController;
  totalCostUsd: number;
  lastActivityAt: number;
  isProcessing: boolean;
  mode: SessionMode;
  pendingPermission?: PendingPermission;
  pendingImages?: PendingImage[];
  messageQueue: QueuedMessage[];
}
