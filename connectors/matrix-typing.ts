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

export type TypingState = "start" | "stop"

export interface TypingTransition {
  roomId: string
  sender: string
  state: TypingState
  /** A start already under way when observation began: its real start is unknown. */
  partial?: true
}

/** Each joined room's typist set in a raw /sync response; a malformed entry is skipped, never thrown on. */
export function typingSets(raw: unknown): Map<string, string[]> {
  const sets = new Map<string, string[]>()
  const join = (raw as { rooms?: { join?: unknown } } | null)?.rooms?.join
  if (join === null || typeof join !== "object") return sets
  for (const [roomId, room] of Object.entries(join as Record<string, unknown>)) {
    const events = (room as { ephemeral?: { events?: unknown } } | null)?.ephemeral?.events
    if (!Array.isArray(events)) continue
    for (const event of events) {
      if ((event as { type?: unknown } | null)?.type !== "m.typing") continue
      const ids = (event as { content?: { user_ids?: unknown } }).content?.user_ids
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) continue
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

export type TypingListener = (roomId: string, userIds: string[]) => void

/** A MatrixClient that also reports each room's typist set from the sync it already makes. */
export class TypingAwareClient extends MatrixClient {
  onTyping: TypingListener | null = null

  protected override async processSync(raw: any, emitFn?: (emitEventType: string, ...payload: any[]) => Promise<any>): Promise<any> {
    const listener = this.onTyping
    if (listener) {
      for (const [roomId, userIds] of typingSets(raw)) {
        try {
          listener(roomId, userIds)
        } catch {
          // Typing is a side channel: it must never stop the sync loop.
        }
      }
    }
    return super.processSync(raw, emitFn)
  }
}
