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
  /**
   * The last typing transition the connector had handed out for this room
   * and sender when it forwarded this message. The relay measures this
   * input's typing only when it has taken every transition up to it.
   */
  typingWatermark?: TypingWatermark
}

/**
 * A voice note (`POST /v1/voice`): the fields of an `InboundRequest` that
 * describe where it was posted, sent as the `meta` part of a multipart body
 * whose `audio` part is the audio, already downloaded and, in an encrypted
 * room, decrypted by the connector. The relay transcribes it on the host and
 * relays the transcript as if it had been typed.
 */
export interface VoiceRequest {
  route: RelayRoute
  eventId: string
  roomId: string
  threadRootId: string
  sender: string
  postedAt: number
  implicit: boolean
  replyToEventId?: string
  /** The audio's MIME type as the platform declared it, such as `audio/ogg`. */
  mimeType: string
  /** The duration the platform declared, ms; the relay measures the audio itself and uses this only in logs. */
  declaredDurationMs?: number
}

export interface TypingWatermark {
  stream: string
  seq: number
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
  /** The connector run that sent it; a new run sends `reset` first. */
  stream: string
  /** Its place among this run's transitions for this room and sender: `reset` is 0, then 1, 2, ... */
  seq: number
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
  kind: "reply" | "notice" | "attention" | "reaction"
  /** A reaction only: the bot's earlier reaction in the same place, to redact once this one is sent. */
  redacts?: string
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

/**
 * Rooms beyond the configured ones (Matrix only). The relay owns the registry
 * and the connector learns it from `GET /v1/rooms`: which rooms it may act in,
 * which the relay wants created, and where the owner is. The connector does
 * the Matrix work and reports back; a room's id, never its name, is what the
 * allowlists hold.
 */
export const ROOM_KINDS = ["space", "project", "session", "dm"] as const
export type RoomKind = (typeof ROOM_KINDS)[number]

export const OWNER_MEMBERSHIPS = ["join", "invite", "leave", "ban", "knock"] as const
export type OwnerMembership = (typeof OWNER_MEMBERSHIPS)[number]

export interface RoomEntry {
  roomId: string
  kind: RoomKind
  /** The project's path (auto-created project rooms), the session id, or "". */
  key: string
  /** The project's label, or the session id. */
  label: string
  /** An owner's membership there is `join`. */
  ownerJoined: boolean
}

/** A room the relay wants created. Its `requestId` is stamped into the room, so a crash after creating never creates a second. */
export interface RoomWanted {
  requestId: string
  kind: "space" | "project" | "dm"
  name: string
  topic: string
}

export interface RoomsResponse {
  /** Created rooms invite them; their membership gates posting. */
  owners: string[]
  rooms: RoomEntry[]
  /** The Space's room id once it exists; project rooms are created inside it. */
  space: string | null
  /** Configured rooms listed in the Space too. */
  spaceChildren: string[]
  wanted: RoomWanted[]
  /** Rooms an owner names `vt <project>` or `vt ses_<id>` bind when the bot is invited. */
  named: boolean
}

export interface RoomCreatedRequest {
  route: RelayRoute
  requestId: string
  roomId: string
}

export interface RoomMemberRequest {
  route: RelayRoute
  roomId: string
  user: string
  membership: OwnerMembership
}

/** The bot joined a room an owner created and invited it to. */
export interface RoomClaimRequest {
  route: RelayRoute
  roomId: string
  inviter: string
  /** Read only for this binding, never for authorization. */
  name: string
  encrypted: boolean
}

export type RoomClaimResponse = { state: "bound"; kind: RoomKind; label: string } | { state: "refused"; reason: string }

export interface RoomGoneRequest {
  route: RelayRoute
  roomId: string
}
