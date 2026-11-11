/**
 * Received typing: when the owner starts and stops typing in an allowlisted
 * room, as Matrix reports it in the same /sync the client already runs.
 *
 * The homeserver puts `m.typing` in each joined room's `ephemeral` events: the
 * room's whole current typist set (`content.user_ids`), sent only when that set
 * changes. matrix-bot-sdk's `processSync` ignores `ephemeral`, so
 * `TypingAwareClient` reads it before handing the same response on. There is
 * no second /sync and no change to the SDK. Typing is live only: the server
 * keeps no history of it, and the owner's client sends it only while their
 * "Send typing notifications" setting is on.
 */
import { MatrixClient } from "matrix-bot-sdk"
import type { TypingRequest } from "../src/relay/types"

export type TypingState = "start" | "stop"

export interface TypingTransition {
  roomId: string
  sender: string
  state: TypingState
  /** A start already under way when observation began: its real start is unknown. */
  partial?: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== "string") return null
    strings.push(item)
  }
  return strings
}

/** Each joined room's typist set in a raw /sync response; a malformed entry is skipped, never thrown on. */
export function typingSets(raw: unknown): Map<string, string[]> {
  const sets = new Map<string, string[]>()
  const rooms = isRecord(raw) ? raw.rooms : undefined
  const join = isRecord(rooms) ? rooms.join : undefined
  if (!isRecord(join)) return sets
  for (const [roomId, room] of Object.entries(join)) {
    const ephemeral = isRecord(room) ? room.ephemeral : undefined
    const events = isRecord(ephemeral) ? ephemeral.events : undefined
    if (!Array.isArray(events)) continue
    for (const event of events) {
      if (!isRecord(event) || event.type !== "m.typing") continue
      const content = event.content
      const ids = isRecord(content) ? stringList(content.user_ids) : null
      if (ids === null) continue
      // Several in one response: the last is the room's current set.
      sets.set(roomId, [...new Set(ids)])
    }
  }
  return sets
}

/**
 * Turns typist sets into start/stop transitions for the senders `watched`
 * accepts. The first set seen for a room after `reset` is a baseline: someone
 * already typing then was not seen starting, so they get a `partial` start,
 * which the relay never counts as a complete measurement.
 */
export class TypingTransitions {
  private readonly typing = new Map<string, Set<string>>()

  constructor(private readonly watched: (roomId: string, sender: string) => boolean) {}

  apply(roomId: string, userIds: readonly string[]): TypingTransition[] {
    const now = new Set(userIds.filter((sender) => this.watched(roomId, sender)))
    const before = this.typing.get(roomId)
    this.typing.set(roomId, now)
    if (before === undefined) return [...now].map((sender) => ({ roomId, sender, state: "start", partial: true }))
    const transitions: TypingTransition[] = []
    for (const sender of now) if (!before.has(sender)) transitions.push({ roomId, sender, state: "start" })
    for (const sender of before) if (!now.has(sender)) transitions.push({ roomId, sender, state: "stop" })
    return transitions
  }

  /** Forget every room: what follows is a new baseline. */
  reset(): void {
    this.typing.clear()
  }
}

export interface TypingForwarding {
  /** The bot's own user id: its typing never counts. */
  botUserId: string
  rooms: readonly string[]
  users: readonly string[]
  /** The allowlists: whether `sender` in `roomId` may be observed. */
  allowed(roomId: string, sender: string): boolean
  send(request: TypingRequest): void
  now(): number
}

/**
 * Starts forwarding received typing to the relay: a `reset` for every room
 * and sender first, since observation (re)starts now, then returns the
 * listener that turns each room's typist set into the owner's transitions.
 */
export function forwardTyping(options: TypingForwarding): (roomId: string, userIds: string[]) => void {
  const transitions = new TypingTransitions((roomId, sender) => sender !== options.botUserId && options.allowed(roomId, sender))
  const observedAt = options.now()
  for (const roomId of options.rooms) {
    for (const sender of options.users) options.send({ route: "matrix", roomId, sender, state: "reset", observedAt })
  }
  return (roomId, userIds) => {
    const at = options.now()
    for (const transition of transitions.apply(roomId, userIds)) options.send({ route: "matrix", ...transition, observedAt: at })
  }
}

export interface TypingObserver {
  /** One room's current typist set, from the sync about to be processed. */
  typing(roomId: string, userIds: string[]): void
  /** `typing` threw. The sync is processed anyway: typing is a side channel. */
  failed(error: unknown): void
}

/** A MatrixClient that also reports each room's typist set from the sync it already makes. */
export class TypingAwareClient extends MatrixClient {
  typingObserver: TypingObserver | null = null

  protected override async processSync(
    raw: unknown,
    emitFn?: (emitEventType: string, ...payload: unknown[]) => Promise<unknown>,
  ): Promise<unknown> {
    const observer = this.typingObserver
    if (observer) {
      for (const [roomId, userIds] of typingSets(raw)) {
        try {
          observer.typing(roomId, userIds)
        } catch (error) {
          observer.failed(error)
        }
      }
    }
    return super.processSync(raw, emitFn)
  }
}
