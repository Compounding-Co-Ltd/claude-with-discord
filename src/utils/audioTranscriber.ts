import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config.js";
import type { AudioTranscription } from "../types.js";

const SUPPORTED_AUDIO_TYPES = [
  "audio/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  "audio/webm",
  "audio/flac",
  "video/webm", // Discord voice messages come as video/webm
];

const AUDIO_EXTENSIONS = [".ogg", ".mp3", ".mp4", ".m4a", ".wav", ".webm", ".flac", ".mpeg"];

export function isAudioFile(contentType: string | null, filename: string): boolean {
  if (contentType && SUPPORTED_AUDIO_TYPES.includes(contentType.split(";")[0].trim())) {
    return true;
  }
  const ext = filename.toLowerCase().slice(filename.lastIndexOf("."));
  return AUDIO_EXTENSIONS.includes(ext);
}

export async function transcribeAudio(
  url: string,
  filename: string
): Promise<AudioTranscription | null> {
  const config = getConfig();
  const mode = config.whisper_mode ?? "local"; // Default to local (free)

  if (mode === "api") {
    return transcribeWithAPI(url, filename);
  } else {
    return transcribeWithLocalWhisper(url, filename);
  }
}

async function transcribeWithAPI(
  url: string,
  filename: string
): Promise<AudioTranscription | null> {
  const config = getConfig();
  const apiKey = config.openai_api_key;

  if (!apiKey) {
    console.warn("OpenAI API key not configured, falling back to local whisper");
    return transcribeWithLocalWhisper(url, filename);
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch audio: ${response.status}`);
      return null;
    }

    const audioBuffer = await response.arrayBuffer();

    let ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (!ext || ext === filename) {
      ext = ".ogg";
    }

    const blob = new Blob([audioBuffer], { type: getMimeType(ext) });
    const formData = new FormData();
    formData.append("file", blob, `audio${ext}`);
    formData.append("model", "whisper-1");

    const whisperResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const errorText = await whisperResponse.text();
      console.error(`Whisper API error: ${whisperResponse.status} - ${errorText}`);
      return null;
    }

    const result = await whisperResponse.json() as { text: string; duration?: number };

    return {
      filename,
      text: result.text,
      duration: result.duration,
    };
  } catch (error) {
    console.error("Whisper API transcription error:", error);
    return null;
  }
}

async function transcribeWithLocalWhisper(
  url: string,
  filename: string
): Promise<AudioTranscription | null> {
  const config = getConfig();
  const model = config.whisper_model ?? "base"; // Default to base model

  let tempDir: string | null = null;
  let audioPath: string | null = null;

  try {
    // Check if whisper is installed
    let whisperPath = "whisper";
    try {
      execSync("which whisper", { stdio: "pipe" });
    } catch {
      // Try common installation paths
      const homedir = process.env.HOME || "";
      const localPath = `${homedir}/.local/bin/whisper`;
      try {
        execSync(`test -f "${localPath}"`, { stdio: "pipe" });
        whisperPath = localPath;
      } catch {
        console.error("Local whisper not installed. Install with: pipx install openai-whisper");
        console.error("Or set whisper_mode to 'api' and provide openai_api_key");
        return null;
      }
    }

    // Fetch audio file
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch audio: ${response.status}`);
      return null;
    }

    const audioBuffer = await response.arrayBuffer();

    // Save to temp file
    tempDir = mkdtempSync(join(tmpdir(), "whisper-"));
    let ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (!ext || ext === filename) {
      ext = ".ogg";
    }
    audioPath = join(tempDir, `audio${ext}`);
    writeFileSync(audioPath, Buffer.from(audioBuffer));

    // Run whisper CLI
    const outputPath = join(tempDir, "audio");
    const cmd = `"${whisperPath}" "${audioPath}" --model ${model} --output_format txt --output_dir "${tempDir}" 2>/dev/null`;

    execSync(cmd, {
      stdio: "pipe",
      timeout: 120000, // 2 minute timeout
    });

    // Read the output
    const { readFileSync } = await import("node:fs");
    const txtPath = `${outputPath}.txt`;
    const text = readFileSync(txtPath, "utf-8").trim();

    return {
      filename,
      text,
    };
  } catch (error) {
    console.error("Local whisper transcription error:", error);
    return null;
  } finally {
    // Cleanup temp files
    if (audioPath) {
      try { unlinkSync(audioPath); } catch { /* ignore */ }
    }
    if (tempDir) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }
}

function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".mp4": "audio/mp4",
    ".m4a": "audio/m4a",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".flac": "audio/flac",
    ".mpeg": "audio/mpeg",
  };
  return mimeMap[ext] || "audio/ogg";
}
