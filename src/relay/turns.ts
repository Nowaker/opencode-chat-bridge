/**
 * Which assistant messages end a coordinator turn, and what they say.
 *
 * opencode runs a turn as a chain of assistant messages that all point at the
 * user message they answer (`parentID`). Every step that called a tool ends
 * with finish "tool-calls" and the chain continues; the step that ends the
 * turn has any other finish, or an error. Only that last step's text is the
 * answer - the earlier steps' text is narration between tool calls.
 */

import { isRelayId } from "./prompt"

export interface ApiMessage {
  info: Record<string, any>
  parts: Array<Record<string, any>>
}

export interface FinalTurn {
  messageID: string
  parentID: string
  createdAt: number
  kind: "text" | "empty" | "error" | "compaction"
  /** The answer with any REPLY_TO line removed. */
  text: string
  noReply: boolean
  /** The relay id a REPLY_TO line named, unvalidated. */
  replyTo: string | null
  errorName?: string
}

export const NO_REPLY = "NO_REPLY"

export function messageText(parts: ReadonlyArray<Record<string, any>>): string {
  return parts
    .filter((part) => part["type"] === "text" && !part["synthetic"] && !part["ignored"] && typeof part["text"] === "string")
    .map((part) => part["text"] as string)
    .join("\n")
    .trim()
}

export function isCompaction(info: Record<string, any>): boolean {
  return info["summary"] === true || info["mode"] === "compaction" || info["agent"] === "compaction"
}

export function parseReplyDirectives(raw: string): { text: string; noReply: boolean; replyTo: string | null } {
  let text = raw.trim()
  let replyTo: string | null = null
  const firstBreak = text.indexOf("\n")
  const firstLine = firstBreak === -1 ? text : text.slice(0, firstBreak)
  const match = /^REPLY_TO:\s*(\S+)\s*$/.exec(firstLine.trim())
  if (match && isRelayId(match[1])) {
    replyTo = match[1]
    text = firstBreak === -1 ? "" : text.slice(firstBreak + 1).trim()
  }
  return { text, noReply: text.toUpperCase() === NO_REPLY, replyTo }
}

/**
 * Assistant messages that ended a turn, oldest first, created after the
 * watermark and not processed yet. A message still streaming, or one that
 * only called tools, is left for a later poll.
 */
export function findFinalTurns(
  messages: readonly ApiMessage[],
  watermarkMs: number,
  processed: ReadonlySet<string>,
): FinalTurn[] {
  const turns: FinalTurn[] = []
  for (const message of messages) {
    const info = message.info ?? {}
    if (info["role"] !== "assistant") continue
    const id = String(info["id"] ?? "")
    if (!id || processed.has(id)) continue
    const createdAt = Number(info["time"]?.["created"] ?? 0)
    if (!(createdAt > watermarkMs)) continue
    if (!info["time"]?.["completed"]) continue

    const error = info["error"]
    const finish = info["finish"]
    const ended = error !== undefined && error !== null ? true : typeof finish === "string" && finish !== "tool-calls"
    if (!ended) continue

    const base = { messageID: id, parentID: String(info["parentID"] ?? ""), createdAt }
    if (isCompaction(info)) {
      turns.push({ ...base, kind: "compaction", text: "", noReply: true, replyTo: null })
      continue
    }
    if (error !== undefined && error !== null) {
      const errorName = typeof error === "object" && typeof error["name"] === "string" ? error["name"] : "Error"
      turns.push({ ...base, kind: "error", text: "", noReply: false, replyTo: null, errorName })
      continue
    }
    const directives = parseReplyDirectives(messageText(message.parts ?? []))
    turns.push({
      ...base,
      kind: directives.text ? "text" : "empty",
      text: directives.text,
      noReply: directives.noReply,
      replyTo: directives.replyTo,
    })
  }
  turns.sort((a, b) => a.createdAt - b.createdAt || (a.messageID < b.messageID ? -1 : 1))
  return turns
}
