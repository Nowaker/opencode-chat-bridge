/**
 * The relay's memory: an append-only JSONL journal, fsynced per record, and the
 * state rebuilt from it on every start.
 *
 * It records identifiers, hashes and lengths, never a message body. Text the
 * relay must keep in order to retry a delivery lives in a separate 0600 file
 * that is deleted once delivery is settled (see `Relay`), and a reply is read
 * again from vibeterm-api by message id when it has to be resent.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, existsSync, chmodSync } from "fs"
import { dirname } from "path"
import type { RelayRoute } from "./types"

export type DispatchOutcome =
  | "delivered"
  | "uncertain"
  | "retry"
  | "failed"
  | "needs_attention"
  | "abandoned"

export type TurnDisposition =
  | "outbox"
  | "no_reply"
  | "suppressed"
  | "empty"
  | "compaction"

export type JournalRecord =
  | { kind: "register"; at: number; route: RelayRoute; sessionID: string; watermarkMs: number }
  | {
      kind: "inbound"
      at: number
      route: RelayRoute
      relayId: string
      eventId: string
      roomId: string
      threadRootId: string
      replyThreadRootId: string
      sender: string
      postedAt: number
      textSha256: string
      textLength: number
    }
  | {
      kind: "dispatch"
      at: number
      relayId: string
      attempt: number
      outcome: DispatchOutcome
      messageId?: string
      status?: number
      error?: string
      /** "receipt" from the API's answer, "observed" when the watcher saw the row first. */
      source?: "receipt" | "observed"
    }
  | {
      kind: "turn"
      at: number
      route: RelayRoute
      sessionID: string
      messageID: string
      parentID: string
      relayId: string | null
      disposition: TurnDisposition
      outboxId?: string
    }
  | {
      kind: "outbox"
      at: number
      outboxId: string
      route: RelayRoute
      relayId: string | null
      sessionID: string
      /** The assistant message whose text is posted; null for a relay notice. */
      messageID: string | null
      itemKind: "reply" | "notice"
      roomId: string
      threadRootId: string
      replyToEventId: string
      textSha256: string
      textLength: number
      /** Relay-authored notices only: they carry no chat or model content. */
      noticeText?: string
    }
  /** An operator redelivering a definite refusal; see `Relay.processRequeues`. */
  | { kind: "requeue"; at: number; relayId: string }
  | { kind: "claim"; at: number; outboxId: string }
  | { kind: "sent"; at: number; outboxId: string; chatEventId: string }
  | { kind: "send_failed"; at: number; outboxId: string; error: string; definite: boolean }
  | { kind: "send_uncertain"; at: number; outboxId: string; reason: string }

export type DispatchState = "pending" | "delivered" | "uncertain" | "failed" | "needs_attention" | "abandoned"

export interface RelayRecord {
  relayId: string
  route: RelayRoute
  eventId: string
  roomId: string
  threadRootId: string
  replyThreadRootId: string
  sender: string
  postedAt: number
  receivedAt: number
  textSha256: string
  dispatch: DispatchState
  attempts: number
  lastAttemptAt?: number
  messageId?: string
  answeredBy?: string
}

export type OutboxStateName = "pending" | "claimed" | "sent" | "failed" | "uncertain"

export interface OutboxRecord {
  outboxId: string
  route: RelayRoute
  relayId: string | null
  sessionID: string
  messageID: string | null
  itemKind: "reply" | "notice"
  roomId: string
  threadRootId: string
  replyToEventId: string
  textSha256: string
  textLength: number
  noticeText?: string
  createdAt: number
  state: OutboxStateName
  firstClaimAt?: number
  lastClaimAt?: number
  chatEventId?: string
}

export interface RouteRegistration {
  sessionID: string
  watermarkMs: number
  registeredAt: number
}

const TERMINAL_DISPATCH = new Set<DispatchState>(["delivered", "failed", "needs_attention", "abandoned"])

export function isTerminalDispatch(state: DispatchState): boolean {
  return TERMINAL_DISPATCH.has(state)
}

function eventKey(route: string, eventId: string): string {
  return `${route}\u0000${eventId}`
}

export function threadKey(route: string, roomId: string, threadRootId: string): string {
  return `${route}\u0000${roomId}\u0000${threadRootId}`
}

/** Everything the relay knows, as folded from the journal. */
export class RelayState {
  readonly routes = new Map<RelayRoute, RouteRegistration>()
  readonly relays = new Map<string, RelayRecord>()
  readonly byEvent = new Map<string, string>()
  readonly byUserMessage = new Map<string, string>()
  readonly processedTurns = new Set<string>()
  readonly outbox = new Map<string, OutboxRecord>()
  readonly outboxByMessage = new Map<string, string>()
  readonly threads = new Set<string>()

  relayForEvent(route: RelayRoute, eventId: string): RelayRecord | undefined {
    const id = this.byEvent.get(eventKey(route, eventId))
    return id === undefined ? undefined : this.relays.get(id)
  }

  apply(record: JournalRecord): void {
    switch (record.kind) {
      case "register":
        this.routes.set(record.route, {
          sessionID: record.sessionID,
          watermarkMs: record.watermarkMs,
          registeredAt: record.at,
        })
        return
      case "inbound":
        this.relays.set(record.relayId, {
          relayId: record.relayId,
          route: record.route,
          eventId: record.eventId,
          roomId: record.roomId,
          threadRootId: record.threadRootId,
          replyThreadRootId: record.replyThreadRootId,
          sender: record.sender,
          postedAt: record.postedAt,
          receivedAt: record.at,
          textSha256: record.textSha256,
          dispatch: "pending",
          attempts: 0,
        })
        this.byEvent.set(eventKey(record.route, record.eventId), record.relayId)
        this.threads.add(threadKey(record.route, record.roomId, record.replyThreadRootId))
        return
      case "dispatch": {
        const relay = this.relays.get(record.relayId)
        if (!relay) return
        relay.attempts = Math.max(relay.attempts, record.attempt)
        relay.lastAttemptAt = record.at
        // A delivery observed in the transcript settles it, whatever an
        // in-flight attempt reports afterwards.
        if (relay.dispatch === "delivered") return
        switch (record.outcome) {
          case "delivered":
            relay.dispatch = "delivered"
            if (record.messageId) {
              relay.messageId = record.messageId
              this.byUserMessage.set(record.messageId, record.relayId)
            }
            return
          case "retry":
            // Definitely not delivered: still pending, unless it was already uncertain.
            if (relay.dispatch !== "uncertain") relay.dispatch = "pending"
            return
          default:
            relay.dispatch = record.outcome
        }
        return
      }
      case "requeue": {
        const relay = this.relays.get(record.relayId)
        if (relay?.dispatch === "failed") relay.dispatch = "pending"
        return
      }
      case "turn": {
        this.processedTurns.add(record.messageID)
        if (record.relayId) {
          const relay = this.relays.get(record.relayId)
          if (relay && !relay.answeredBy) relay.answeredBy = record.messageID
        }
        return
      }
      case "outbox":
        this.outbox.set(record.outboxId, {
          outboxId: record.outboxId,
          route: record.route,
          relayId: record.relayId,
          sessionID: record.sessionID,
          messageID: record.messageID,
          itemKind: record.itemKind,
          roomId: record.roomId,
          threadRootId: record.threadRootId,
          replyToEventId: record.replyToEventId,
          textSha256: record.textSha256,
          textLength: record.textLength,
          ...(record.noticeText === undefined ? {} : { noticeText: record.noticeText }),
          createdAt: record.at,
          state: "pending",
        })
        if (record.messageID) this.outboxByMessage.set(record.messageID, record.outboxId)
        if (record.threadRootId) this.threads.add(threadKey(record.route, record.roomId, record.threadRootId))
        return
      case "claim": {
        const item = this.outbox.get(record.outboxId)
        if (!item || (item.state !== "pending" && item.state !== "claimed")) return
        item.state = "claimed"
        item.firstClaimAt ??= record.at
        item.lastClaimAt = record.at
        return
      }
      case "sent": {
        const item = this.outbox.get(record.outboxId)
        if (!item) return
        item.state = "sent"
        item.chatEventId = record.chatEventId
        // A top-level post becomes a thread the owner can answer in without the trigger.
        if (!item.threadRootId) this.threads.add(threadKey(item.route, item.roomId, record.chatEventId))
        return
      }
      case "send_failed": {
        const item = this.outbox.get(record.outboxId)
        if (!item || item.state === "sent") return
        item.state = record.definite ? "failed" : "pending"
        return
      }
      case "send_uncertain": {
        const item = this.outbox.get(record.outboxId)
        if (!item || item.state === "sent") return
        item.state = "uncertain"
        return
      }
    }
  }
}

export interface JournalLoad {
  state: RelayState
  records: number
  /** Lines that did not parse; a torn final line after a crash is the expected case. */
  skipped: number
}

/** Rebuild state from a journal file without opening it for writing. */
export function replayJournal(path: string): JournalLoad {
  const state = new RelayState()
  if (!existsSync(path)) return { state, records: 0, skipped: 0 }
  let records = 0
  let skipped = 0
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    let record: JournalRecord
    try {
      record = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    if (!record || typeof record !== "object" || typeof (record as { kind?: unknown }).kind !== "string") {
      skipped++
      continue
    }
    state.apply(record)
    records++
  }
  return { state, records, skipped }
}

export class Journal {
  readonly state: RelayState
  readonly loaded: JournalLoad
  private fd: number | null
  private readonly sync: boolean

  /** `sync: false` skips the per-record fsync; only tests turn it off. */
  constructor(readonly path: string, options: { sync?: boolean } = {}) {
    this.sync = options.sync !== false
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.loaded = replayJournal(path)
    this.state = this.loaded.state
    this.fd = openSync(path, "a", 0o600)
    chmodSync(path, 0o600)
  }

  /** Durable before the state changes, so a crash never acts on something unrecorded. */
  append(record: JournalRecord): void {
    if (this.fd === null) throw new Error("journal is closed")
    writeSync(this.fd, JSON.stringify(record) + "\n")
    if (this.sync) fsyncSync(this.fd)
    this.state.apply(record)
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd)
    this.fd = null
  }
}
