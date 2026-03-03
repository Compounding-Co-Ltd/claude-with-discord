import { ChannelType, type Message, type Attachment } from "discord.js";
import { exec } from "child_process";
import type { AppConfig, ImageContent, PendingImage, AudioTranscription } from "../../types.js";
import { getConfig } from "../../config.js";
import type { SessionManager } from "../../claude/sessionManager.js";
import { isAudioFile, transcribeAudio } from "../../utils/audioTranscriber.js";

const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

async function fetchImageAsBase64(url: string): Promise<{ data: string; mediaType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    const mediaType = contentType.split(";")[0].trim();

    if (!SUPPORTED_IMAGE_TYPES.includes(mediaType)) return null;

    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer).toString("base64");

    return { data, mediaType };
  } catch {
    return null;
  }
}

interface ExtractedMedia {
  images: ImageContent[];
  pendingImages: PendingImage[];
  audioTranscriptions: AudioTranscription[];
}

async function extractMedia(message: Message): Promise<ExtractedMedia> {
  const images: ImageContent[] = [];
  const pendingImages: PendingImage[] = [];
  const audioTranscriptions: AudioTranscription[] = [];
  let imageIndex = 0;

  // Extract from attachments
  for (const attachment of message.attachments.values()) {
    const contentType = attachment.contentType || "";
    const filename = attachment.name || "unknown";

    // Debug logging for attachments
    console.log(`[Attachment] name: ${filename}, contentType: ${contentType}, waveform: ${!!attachment.waveform}, duration: ${attachment.duration}, flags: ${message.flags.bitfield}`);

    // Check for audio files (including Discord voice messages which have waveform)
    const isVoiceMessage = !!attachment.waveform || !!attachment.duration;
    if (isAudioFile(contentType, filename) || isVoiceMessage) {
      console.log(`[Audio] Processing audio file: ${filename}, isVoiceMessage: ${isVoiceMessage}`);
      const transcription = await transcribeAudio(attachment.url, filename);
      if (transcription) {
        console.log(`[Audio] Transcription successful: "${transcription.text.substring(0, 50)}..."`);
        audioTranscriptions.push(transcription);
      } else {
        console.log(`[Audio] Transcription failed for ${filename}`);
      }
      continue;
    }

    // Check for image files
    if (SUPPORTED_IMAGE_TYPES.includes(contentType)) {
      const result = await fetchImageAsBase64(attachment.url);
      if (result) {
        images.push({ type: "image", data: result.data, mediaType: result.mediaType });
        pendingImages.push({
          index: imageIndex,
          url: attachment.url,
          filename: filename || `image_${imageIndex}.${result.mediaType.split("/")[1]}`,
          data: result.data,
          mediaType: result.mediaType,
        });
        imageIndex++;
      }
    }
  }

  // Extract image URLs from message content
  const urlRegex = /(https?:\/\/[^\s]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s]*)?)/gi;
  const urls = message.content.match(urlRegex) || [];

  for (const url of urls) {
    const result = await fetchImageAsBase64(url);
    if (result) {
      images.push({ type: "image", data: result.data, mediaType: result.mediaType });
      // Extract filename from URL
      const urlPath = new URL(url).pathname;
      const filename = urlPath.split("/").pop() || `image_${imageIndex}.${result.mediaType.split("/")[1]}`;
      pendingImages.push({
        index: imageIndex,
        url,
        filename,
        data: result.data,
        mediaType: result.mediaType,
      });
      imageIndex++;
    }
  }

  return { images, pendingImages, audioTranscriptions };
}

export function handleMessageCreate(_config: AppConfig, sessionManager: SessionManager) {
  return async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Only handle messages in threads
    if (
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread
    ) {
      return;
    }

    const thread = message.channel;
    const parentId = thread.parentId ?? "";

    // Get fresh config for hot-reload support
    const config = getConfig();

    // Only handle threads in mapped channels
    const projectPath = config.channel_project_map[parentId];
    if (!projectPath) return;

    // Check user whitelist
    if (config.allowed_users.length > 0 && !config.allowed_users.includes(message.author.id)) {
      return;
    }

    const content = message.content.trim();
    const { images, pendingImages, audioTranscriptions } = await extractMedia(message);

    // Need either text, images, or audio
    if (!content && images.length === 0 && audioTranscriptions.length === 0) return;

    // Handle special commands
    if (content === "!stop") {
      await sessionManager.stopSession(thread.id, thread);
      return;
    }

    if (content === "!cost") {
      await sessionManager.getCost(thread.id, thread);
      return;
    }

    // Handle image save command: !save [index] [path]
    const saveMatch = content.match(/^!save\s+(\d+)\s+(.+)$/i);
    if (saveMatch) {
      const imageIndex = parseInt(saveMatch[1], 10);
      const targetPath = saveMatch[2].trim();
      await sessionManager.saveImage(thread.id, imageIndex, targetPath, thread);
      return;
    }

    // Handle image list command
    if (content === "!images") {
      const list = sessionManager.listPendingImages(thread.id);
      await thread.send(`*${list}*`);
      return;
    }

    // Handle deploy/restart commands (only for claude-with-discord project)
    const reloadCommands = ["!reload", "!restart", "!deploy", "재시작", "리로드"];
    if (reloadCommands.includes(content.toLowerCase()) && projectPath.includes("claude-with-discord")) {
      await message.reply("🔄 Deploying...");
      exec("/Volumes/T7/projects/claude-with-discord/scripts/deploy.sh", (error, stdout, stderr) => {
        if (error) {
          thread.send(`❌ Deploy failed:\n\`\`\`\n${stderr || error.message}\n\`\`\``);
        } else {
          thread.send(`✅ Deploy successful:\n\`\`\`\n${stdout}\n\`\`\``);
        }
      });
      return;
    }

    // Forward to Claude Code
    await sessionManager.sendMessage(
      thread.id,
      parentId,
      projectPath,
      content,
      thread,
      images,
      pendingImages,
      audioTranscriptions,
    );
  };
}
