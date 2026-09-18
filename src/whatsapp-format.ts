/**
 * WhatsApp outbound text formatting.
 *
 * Every byte of text this bridge puts into WhatsApp passes through here so the
 * `[AI] ` marker cannot be forgotten at a new call site.
 */

export const AI_PREFIX = "[AI] "

/** Conservative ceiling for a single WhatsApp text message. */
export const WHATSAPP_MAX_MESSAGE_LENGTH = 4000

export function applyAiPrefix(text: string): string {
  return `${AI_PREFIX}${text}`
}

/**
 * Split text so that every chunk carries the prefix and still fits in maxLen.
 *
 * The prefix is subtracted from the per-chunk budget rather than added
 * afterwards, so prefixing can never push a chunk over the platform limit.
 * Returns an empty array for blank input: there is nothing to send, and a
 * bare marker with no content would just be noise in the chat.
 */
export function buildAiMessageChunks(
  text: string,
  maxLen: number = WHATSAPP_MAX_MESSAGE_LENGTH,
): string[] {
  const body = text.trim()
  if (!body) return []

  const budget = Math.max(1, maxLen - AI_PREFIX.length)
  const chunks: string[] = []
  let remaining = body

  while (remaining.length > 0) {
    if (remaining.length <= budget) {
      chunks.push(applyAiPrefix(remaining))
      break
    }
    // Prefer a line boundary so code blocks and lists survive the split.
    let splitAt = remaining.lastIndexOf("\n", budget)
    if (splitAt <= 0) splitAt = budget
    chunks.push(applyAiPrefix(remaining.slice(0, splitAt).trimEnd()))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

/**
 * Whether inbound text looks like this bridge's own output.
 *
 * This is a fallback for echoes whose message ID the connector no longer
 * holds, such as after a restart. Identity checks (`fromMe` plus the tracked
 * sent-message IDs) remain the primary guard; a human's own messages that do
 * not carry the marker are still processed normally.
 */
export function looksLikeBridgeEcho(text: string): boolean {
  return text.startsWith(AI_PREFIX)
}
