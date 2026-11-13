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
import type { TypingRequest, TypingWatermark } from "../src/relay/types"

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

  /** Forget one room: its next set is a new baseline. */
  forget(roomId: string): void {
    this.typing.delete(roomId)
  }
}

export interface TypingForwarding {
  /** This connector run: every transition names it, so the relay can tell runs apart. */
  stream: string
  /** The bot's own user id: its typing never counts. */
  botUserId: string
  rooms: readonly string[]
  users: readonly string[]
  /** The allowlists: whether `sender` in `roomId` may be observed. */
  allowed(roomId: string, sender: string): boolean
  /** Delivers one transition; it is not called again until this settles. */
  send(request: TypingRequest): Promise<void>
  /** A send failed. The next transition still goes out; the relay sees the skipped `seq` as a break. */
  failed(error: unknown): void
  now(): number
}

/**
 * Forwards received typing to the relay, in order. Each transition is
 * numbered per room and sender within this run (`reset` is 0, then 1, 2, ...)
 * and sent only after the previous one settled, so the relay sees them as
 * they happened and can tell one lost or late from the gap in `seq`.
 *
 * A message is forwarded with the watermark `fence` returns: the last
 * transition handed out for its room and sender. `fence` waits, at most
 * `timeoutMs`, for the transitions handed out so far to be sent, so in the
 * usual case the relay has them all; when a send is slow or lost the message
 * goes on anyway and the relay, missing a transition the watermark names,
 * leaves that input unmeasured. Typing never holds a message back for longer.
 */
export class TypingForwarder {
  private readonly transitions: TypingTransitions
  private readonly seqs = new Map<string, number>()
  /** Rooms whose observation began: each got a `reset` for every user. */
  private readonly observed = new Set<string>()
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: TypingForwarding) {
    this.transitions = new TypingTransitions((roomId, sender) => sender !== options.botUserId && options.allowed(roomId, sender))
  }

  /** Observation (re)starts now: a `reset` for every room and sender. */
  start(): void {
    for (const roomId of this.options.rooms) this.watch(roomId)
  }

  /**
   * Observation of a room that became allowed after `start` (a room of the
   * relay's registry) begins now: a `reset` for every sender it allows there,
   * once, as `start` gives a configured room. Without it this run's first
   * transition there would follow the previous run's numbering, and the relay
   * would count the next input in that room as a break.
   */
  watch(roomId: string): void {
    if (this.observed.has(roomId)) return
    const senders = this.options.users.filter((sender) => this.options.allowed(roomId, sender))
    if (senders.length === 0) return
    this.observed.add(roomId)
    this.transitions.forget(roomId)
    const observedAt = this.options.now()
    for (const sender of senders) this.enqueue({ roomId, sender, state: "reset" }, observedAt)
  }

  /** One room's current typist set, from the sync about to be processed. */
  observe(roomId: string, userIds: readonly string[]): void {
    // A room allowed since start whose typing arrives before the room sync names it.
    this.watch(roomId)
    const at = this.options.now()
    for (const transition of this.transitions.apply(roomId, userIds)) this.enqueue(transition, at)
  }

  /** The watermark for a message from `sender` in `roomId`, once the transitions before it were sent or `timeoutMs` passed. */
  async fence(roomId: string, sender: string, timeoutMs: number): Promise<TypingWatermark | undefined> {
    const seq = this.seqs.get(key(roomId, sender))
    const pending = this.tail
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })
    try {
      await Promise.race([pending, timeout])
    } finally {
      clearTimeout(timer)
    }
    return seq === undefined ? undefined : { stream: this.options.stream, seq }
  }

  private enqueue(transition: { roomId: string; sender: string; state: TypingRequest["state"]; partial?: true }, observedAt: number): void {
    const id = key(transition.roomId, transition.sender)
    const seq = transition.state === "reset" ? 0 : (this.seqs.get(id) ?? 0) + 1
    this.seqs.set(id, seq)
    const request: TypingRequest = { route: "matrix", ...transition, observedAt, stream: this.options.stream, seq }
    this.tail = this.tail.then(() => this.options.send(request)).catch((error: unknown) => this.options.failed(error))
  }
}

function key(roomId: string, sender: string): string {
  return `${roomId}\u0000${sender}`
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
