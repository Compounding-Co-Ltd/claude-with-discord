const MAX_LENGTH = 2000;

/**
 * Truncate a message to fit Discord's 2000-char limit.
 * Use this for messages that cannot be split (e.g., messages with buttons).
 */
export function truncateMessage(text: string, maxLength: number = 1900): string {
  if (text.length <= maxLength) return text;

  // Try to truncate at a newline for cleaner output
  const truncateAt = text.lastIndexOf("\n", maxLength - 20);
  const cutPoint = truncateAt > maxLength * 0.5 ? truncateAt : maxLength - 20;

  return text.slice(0, cutPoint) + "\n... *(truncated)*";
}

/**
 * Split a message into chunks that fit Discord's 2000-char limit.
 * Preserves code block boundaries so they don't get broken across chunks.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = MAX_LENGTH;

    // Check if we're inside a code block at the split point
    const beforeSplit = remaining.slice(0, splitAt);
    const codeBlockCount = (beforeSplit.match(/```/g) || []).length;
    const insideCodeBlock = codeBlockCount % 2 !== 0;

    // Try to find a good split point (newline)
    const lastNewline = remaining.lastIndexOf("\n", splitAt);
    if (lastNewline > MAX_LENGTH * 0.5) {
      splitAt = lastNewline + 1;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // If we split inside a code block, close it in this chunk and reopen in next
    if (insideCodeBlock) {
      // Find the language tag from the opening ```
      const lastOpen = chunk.lastIndexOf("```");
      const afterOpen = chunk.slice(lastOpen + 3);
      const langMatch = afterOpen.match(/^(\w*)\n/);
      const lang = langMatch ? langMatch[1] : "";

      chunk += "\n```";
      remaining = "```" + lang + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}
