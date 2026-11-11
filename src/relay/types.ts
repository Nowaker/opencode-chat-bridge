/**
 * Wire types between the relay (a host process) and the connectors that hand
 * it chat messages. The relay listens on a Unix socket only, and every field
 * here crosses that socket.
 *
 * The connector authenticates the sender (allowlists, its own bot echo, the
 * platform's encryption) and forwards; the relay owns everything after that:
 * dedupe, the Vibeterm prompt, the reply and where it goes.
 *
 * The relay itself now runs in opencode-tools as vibeterm-channels
 * (`_lib/vibeterm-channels/types.ts`), which keeps the same types; change both
 * together.
 */

export const RELAY_ROUTES = ["matrix", "whatsapp", "slack"] as const
export type RelayRoute = (typeof RELAY_ROUTES)[number]

export function isRelayRoute(value: unknown): value is RelayRoute {
  return typeof value === "string" && (RELAY_ROUTES as readonly string[]).includes(value)
}

export interface InboundRequest {
  route: RelayRoute
  /** The platform's id for the message. The dedupe key, unique within a route. */
  eventId: string
  roomId: string
  /** The thread the message was posted in, or "" when it is top-level. */
  threadRootId: string
  sender: string
  /** When the platform says it was posted, ms since the epoch. */
  postedAt: number
  /** The prompt, trigger already removed. */
  text: string
  /**
   * A reply inside a thread that carried no trigger. The relay accepts one
   * only in a thread it already serves, so a stray reply in some other thread
   * never becomes a prompt.
   */
  implicit: boolean
  /**
   * The last moment the platform accepts an answer, ms since the epoch, when
   * it has one. The coordinator is told, and the reply carries it.
   */
  replyBy?: number
  /**
   * The event a rich reply (Matrix "Reply") answers. A reply to a question or
   * permission the relay posted answers it, as a reply in its thread does.
   */
  replyToEventId?: string
  /**
   * An emoji reaction, not a message: `text` is the reaction key and
   * `replyToEventId` the message it was put on. The relay takes one only on
   * a question or permission it posted, as an answer to it.
   */
  reaction?: boolean
  /**
   * The message this one edits (Matrix `m.replace`). The edit is relayed as
   * typed, under its own event id; activity time counts it as the original.
   */
  originalEventId?: string
}

/**
 * A received typing transition (`POST /v1/typing`), Matrix only: the owner
 * started or stopped typing in a room, or `reset`, sent when the connector
 * (re)starts observing that room, after which earlier state is unknown.
 */
export interface TypingRequest {
  route: RelayRoute
  roomId: string
  sender: string
  state: "start" | "stop" | "reset"
  /** When the connector saw it, ms since the epoch. */
  observedAt: number
  /** A start already under way when the connector began observing the room: its real start is unknown. */
  partial?: true
}

export type InboundState = "accepted" | "duplicate" | "ignored" | "rejected"

export interface InboundResponse {
  state: InboundState
  relayId?: string
  reason?: string
}

export interface OutboxItem {
  outboxId: string
  /**
   * Stable across re-offers, so sending an item again after a lost
   * acknowledgement is the SAME platform transaction rather than a second
   * message. Matrix deduplicates a repeated transaction id per access token.
   */
  txnId: string
  roomId: string
  /** "" posts top-level. */
  threadRootId: string
  /** The event a threaded post names as its in-reply-to fallback; with no thread, the message a top-level post replies to. */
  replyToEventId: string
  text: string
  /** `attention` is an item of the attention inbox; a reply in its thread answers it. */
  kind: "reply" | "notice" | "attention"
  /** The `replyBy` of the message this answers, when it had one. */
  replyBy?: number
}

export interface OutboxResponse {
  items: OutboxItem[]
  /** Rooms with a relayed prompt still being worked on. */
  typingRooms: string[]
}

export interface AckRequest {
  outboxId: string
  chatEventId: string
}

export interface NackRequest {
  outboxId: string
  error: string
  /** True when the platform refused the message; false when it may yet go through. */
  definite: boolean
}
