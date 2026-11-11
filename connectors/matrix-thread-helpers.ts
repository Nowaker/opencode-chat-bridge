/**
 * Matrix thread context helpers (pure functions, no SDK dependency)
 *
 * Extracted so tests can import them without needing matrix-bot-sdk installed.
 */
import type { InboundRequest } from "../src/relay/types"

/**
 * Normalized context extracted from a Matrix room event.
 */
export interface MatrixEventContext {
  roomId: string
  sender: string
  text: string
  eventId: string
  /** Non-empty when this event is inside a m.thread relation */
  threadRootEventId: string
  /** The event ID to use as the thread root when replying */
  replyThreadRootId: string
  /** Session key: room:threadRootEventId (thread isolation) or room (per-room) */
  sessionId: string
  /** Idempotency key */
  dedupeId: string
}

/**
 * Extract the m.thread root event ID from event content, if present.
 * Returns empty string for non-threaded events.
 */
export function extractThreadRootId(event: any): string {
  const relatesTo = event?.content?.["m.relates_to"]
  if (relatesTo?.rel_type === "m.thread" && relatesTo?.event_id) {
    return relatesTo.event_id
  }
  return ""
}

/**
 * Extract a query prefixed by the configured bot name.
 * Accepts "name: query", "name query", and optional leading "@" forms.
 */
export function extractBotNameQuery(text: string, botName: string): string | null {
  const name = botName.trim()
  if (!name) return null

  const prefixes = [`@${name}`, name]

  for (const prefix of prefixes) {
    if (text.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) continue
    const separator = text.charAt(prefix.length)
    if (separator !== ":" && !/\s/.test(separator)) continue
    return text.slice(prefix.length).replace(/^[:\s]+/, "").trim()
  }

  return null
}

/**
 * Resolve the thread root event ID.
 * If the event is in a thread, use the thread root. Otherwise use the event itself.
 */
export function resolveThreadRoot(threadRootEventId: string, eventId: string): string {
  return threadRootEventId || eventId
}

/**
 * Build the session key.
 * When threadIsolation is true: room:threadRootEventId (per-thread)
 * When false: room (per-room, old behavior)
 */
export function buildMatrixSessionId(
  roomId: string,
  replyThreadRootId: string,
  threadIsolation: boolean
): string {
  if (threadIsolation) {
    return `${roomId}:${replyThreadRootId}`
  }
  return roomId
}

/**
 * Normalize raw Matrix event fields into a consistent MatrixEventContext.
 */
export function normalizeMatrixEventContext(
  input: {
    roomId: string
    sender?: string
    text?: string
    eventId: string
    threadRootEventId?: string
  },
  threadIsolation: boolean
): MatrixEventContext {
  const roomId = input.roomId
  const eventId = input.eventId
  const threadRootEventId = input.threadRootEventId || ""
  const replyThreadRootId = resolveThreadRoot(threadRootEventId, eventId)

  return {
    roomId,
    sender: input.sender || "unknown",
    text: input.text || "",
    eventId,
    threadRootEventId,
    replyThreadRootId,
    sessionId: buildMatrixSessionId(roomId, replyThreadRootId, threadIsolation),
    dedupeId: eventId,
  }
}

/**
 * Build the m.relates_to content for a thread reply.
 * Includes m.in_reply_to fallback for clients that don't support threads.
 */
export function buildThreadRelation(threadRootEventId: string, lastEventId: string): object {
  return {
    rel_type: "m.thread",
    event_id: threadRootEventId,
    is_falling_back: true,
    "m.in_reply_to": {
      event_id: lastEventId,
    },
  }
}

/**
 * Returns true if a plain thread reply (no trigger, no mention) should be
 * considered for forwarding to the bot.
 */
export function shouldHandleThreadReply(input: {
  enabled?: boolean
  text: string
  threadRootEventId: string
  trigger: string
  botUserId: string
}): boolean {
  if (input.enabled === false) return false
  const text = input.text.trim()
  if (!text) return false
  if (!input.threadRootEventId) return false
  if (text.toLowerCase().startsWith(`${input.trigger.toLowerCase()} `)) return false
  if (text.toLowerCase().startsWith(`${input.trigger.toLowerCase()}`)) return false
  if (text.includes(input.botUserId)) return false
  return true
}

/**
 * Relations of encrypted events, kept between the encrypted event and its
 * decrypted form.
 *
 * In an encrypted room `m.relates_to` travels in the CLEARTEXT content of the
 * `m.room.encrypted` event, not inside the ciphertext, and matrix-bot-sdk's
 * `CryptoClient.decryptRoomEvent` replaces the content with the decrypted one,
 * dropping it. Without this a thread reply in an encrypted room reaches
 * `room.message` with no thread at all, and is handled as a top-level message.
 * `remember` runs on `room.encrypted_event`, which the SDK emits before it
 * decrypts the same event; `restore` puts the relation back.
 */
export class EncryptedRelations {
  private readonly relations = new Map<string, unknown>()

  constructor(private readonly limit = 1_000) {}

  remember(event: any): void {
    const relation = event?.content?.["m.relates_to"]
    const id = event?.event_id
    if (typeof id !== "string" || relation === null || typeof relation !== "object") return
    this.relations.delete(id)
    this.relations.set(id, relation)
    while (this.relations.size > this.limit) {
      const oldest = this.relations.keys().next().value
      if (oldest === undefined) break
      this.relations.delete(oldest)
    }
  }

  /** The event with its cleartext relation back, when decryption dropped it. */
  restore<T>(event: T): T {
    const raw = event as any
    const id = raw?.event_id
    if (typeof id !== "string" || !this.relations.has(id)) return event
    const relation = this.relations.get(id)
    this.relations.delete(id)
    if (raw.content?.["m.relates_to"]) return event
    return { ...raw, content: { ...(raw.content ?? {}), "m.relates_to": relation } }
  }
}

/**
 * The event a rich reply (Element's "Reply") answers, or "". A thread reply's
 * `m.in_reply_to` is only the fallback for clients without threads
 * (`is_falling_back`), so it names nothing here.
 */
export function extractReplyToEventId(event: any): string {
  const relation = event?.content?.["m.relates_to"]
  const target = relation?.["m.in_reply_to"]?.event_id
  if (typeof target !== "string" || !target) return ""
  if (relation?.rel_type === "m.thread" && relation?.is_falling_back === true) return ""
  return target
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** The event an edit (`m.replace`) replaces, or "" for anything else. */
export function extractReplacedEventId(event: unknown): string {
  const relation = field(field(event, "content"), "m.relates_to")
  if (field(relation, "rel_type") !== "m.replace") return ""
  const target = field(relation, "event_id")
  return typeof target === "string" ? target : ""
}

/**
 * What the connector sends the relay for one accepted Matrix event: `query`
 * is the prompt with the trigger removed. A rich reply names the event it
 * answers, and an edit the event it edits.
 */
export function relayInboundRequest(context: MatrixEventContext, event: unknown, query: string, implicit: boolean, now: number): InboundRequest {
  const postedAt = field(event, "origin_server_ts")
  const request: InboundRequest = {
    route: "matrix",
    eventId: context.eventId,
    roomId: context.roomId,
    threadRootId: context.threadRootEventId,
    sender: context.sender,
    postedAt: typeof postedAt === "number" ? postedAt : now,
    text: query,
    implicit,
  }
  const replyToEventId = extractReplyToEventId(event)
  if (replyToEventId) request.replyToEventId = replyToEventId
  const originalEventId = extractReplacedEventId(event)
  if (originalEventId) request.originalEventId = originalEventId
  return request
}

/** A reply's body without the quoted fallback older clients prepend: `> ` lines, then a blank line. */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith("> ")) return body
  const lines = body.split("\n")
  let index = 0
  while (index < lines.length && (lines[index] ?? "").startsWith(">")) index++
  return lines.slice(index).join("\n").trim()
}

/** An emoji reaction (`m.reaction`): the event it was put on and its key, or null. */
export function extractReaction(event: any): { targetEventId: string; key: string } | null {
  if (event?.type !== "m.reaction") return null
  const relation = event?.content?.["m.relates_to"]
  const target = relation?.event_id
  const key = relation?.key
  if (relation?.rel_type !== "m.annotation" || typeof target !== "string" || !target) return null
  if (typeof key !== "string" || !key.trim() || key.length > 64) return null
  return { targetEventId: target, key: key.trim() }
}

/**
 * A message that answers a relay post by its short number, `Q5 2`. The relay
 * answers it only while that number is open, and says so when it is not.
 */
export function isShortIdAnswer(text: string): boolean {
  return /^\s*q\d{1,3}(?=$|[\s:.,)-])/i.test(text)
}
