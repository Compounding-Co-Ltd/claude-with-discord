import { promises as fs } from "node:fs";
import path from "node:path";
import type { PendingImage } from "../types.js";

export interface SaveImageResult {
  success: boolean;
  savedPath?: string;
  error?: string;
}

/**
 * Save a Discord image to the project directory.
 * @param image - The pending image data
 * @param projectPath - The project root path
 * @param targetPath - The relative path where to save the image (can include filename)
 * @returns The result with the saved path or error
 */
export async function saveDiscordImage(
  image: PendingImage,
  projectPath: string,
  targetPath: string
): Promise<SaveImageResult> {
  try {
    // Determine the full save path
    let savePath: string;

    if (targetPath.includes(".")) {
      // targetPath includes filename
      savePath = path.resolve(projectPath, targetPath);
    } else {
      // targetPath is a directory, use original filename
      savePath = path.resolve(projectPath, targetPath, image.filename);
    }

    // Ensure the directory exists
    const dirPath = path.dirname(savePath);
    await fs.mkdir(dirPath, { recursive: true });

    // Decode base64 and save
    const buffer = Buffer.from(image.data, "base64");
    await fs.writeFile(savePath, buffer);

    // Return relative path from project root
    const relativePath = path.relative(projectPath, savePath);
    return {
      success: true,
      savedPath: relativePath,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * List available pending images for saving.
 */
export function formatPendingImagesList(images: PendingImage[]): string {
  if (images.length === 0) {
    return "No images available to save.";
  }

  const lines = images.map((img, i) =>
    `[${i}] ${img.filename} (${img.mediaType})`
  );

  return `Available images:\n${lines.join("\n")}`;
}
