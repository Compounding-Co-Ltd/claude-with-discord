import { tts, type options as TTSOptions } from "edge-tts";
import { getConfig } from "../config.js";

export interface TTSConfig {
  tts_enabled?: boolean;
  tts_voice?: string;  // Korean voices: ko-KR-SunHiNeural (female), ko-KR-InJoonNeural (male)
}

// Korean voice options
export const KOREAN_VOICES = {
  "ko-KR-SunHiNeural": "Korean Female (SunHi)",
  "ko-KR-InJoonNeural": "Korean Male (InJoon)",
};

// English voice options (for reference)
export const ENGLISH_VOICES = {
  "en-US-JennyNeural": "English Female (Jenny)",
  "en-US-GuyNeural": "English Male (Guy)",
};

/**
 * Generate audio from text using Microsoft Edge TTS (free).
 * Returns a Buffer containing the MP3 audio data.
 */
export async function generateAudio(
  text: string,
  voice?: string
): Promise<Buffer | null> {
  const config = getConfig() as TTSConfig;

  // Check if TTS is enabled
  if (config.tts_enabled === false) {
    return null;
  }

  // Use configured voice or default to Korean female
  const selectedVoice = voice ?? config.tts_voice ?? "ko-KR-SunHiNeural";

  // Skip if text is too short or empty
  const cleanText = text.trim();
  if (!cleanText || cleanText.length < 2) {
    return null;
  }

  // Limit text length to avoid very long audio files
  const maxLength = 4000;
  const truncatedText = cleanText.length > maxLength
    ? cleanText.slice(0, maxLength) + "... (truncated)"
    : cleanText;

  try {
    const options: TTSOptions = {
      voice: selectedVoice,
    };

    const audioBuffer = await tts(truncatedText, options);
    return audioBuffer;
  } catch (error) {
    console.error("TTS generation error:", error);
    return null;
  }
}

/**
 * Extract plain text from markdown for TTS.
 * Removes code blocks, URLs, and other markdown syntax.
 */
export function extractTextForTTS(markdown: string): string {
  let text = markdown;

  // Remove code blocks (```...```)
  text = text.replace(/```[\s\S]*?```/g, " (code block omitted) ");

  // Remove inline code (`...`)
  text = text.replace(/`[^`]+`/g, "");

  // Remove URLs
  text = text.replace(/https?:\/\/[^\s]+/g, "");

  // Remove markdown links but keep text [text](url)
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove markdown emphasis but keep text
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");  // bold
  text = text.replace(/\*([^*]+)\*/g, "$1");      // italic
  text = text.replace(/__([^_]+)__/g, "$1");      // bold
  text = text.replace(/_([^_]+)_/g, "$1");        // italic

  // Remove headers
  text = text.replace(/^#{1,6}\s+/gm, "");

  // Remove list markers
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");

  // Remove blockquotes
  text = text.replace(/^>\s+/gm, "");

  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, "");

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/\s{2,}/g, " ");

  return text.trim();
}
