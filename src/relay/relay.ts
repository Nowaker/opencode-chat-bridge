/**
 * The relay: chat messages in, Vibeterm coordinator turns out.
 *
 * One host process serves every route. A connector hands it an authenticated
 * chat message; the relay journals it, dedupes it on the platform's event id,
 * and delivers it to the route's coordinator session with a keyed
 * `prompt_async`. A watcher reads the coordinator's transcript, and every turn
 * that ends normally is queued for the connector to post back: in the thread
 * of the message it answers, or top-level when it answers none.
 *
 * Nothing here is resent blindly. A delivery that may have landed is retried
 * only with the same idempotency key, which vibeterm-api reconciles against its
 * own ledger. A post the connector took but never confirmed is offered again
 * only with the same platform transaction id, and only inside the window the
 * platform deduplicates in; after that it is recorded as uncertain and left.
 */

import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { isTerminalDispatch, Journal, threadKey, type OutboxRecord, type RelayRecord } from "./journal"
import { buildRelayPrompt, parseRelayId } from "./prompt"
import { findFinalTurns, messageText, parseReplyDirectives, type ApiMessage, type FinalTurn } from "./turns"
import type { PromptOutcome } from "./vibeterm-api"
import type {
  AckRequest,
  InboundRequest,
  InboundResponse,
  NackRequest,
  OutboxItem,
  OutboxResponse,
  RelayRoute,
} from "./types"

export interface RelayApi {
  promptAsync(sessionID: string, key: string, text: string): Promise<PromptOutcome>
  messages(sessionID: string, limit: number): Promise<ApiMessage[]>
  message(sessionID: string, messageID: string): Promise<ApiMessage | null>
}

export interface RouteConfig {
  enabled: boolean
  sessionID: string
  allowedUsers: string[]
  allowedRooms: string[]
  /** Where a turn that answers no relayed message is posted; "" drops such turns. */
  defaultRoom: string
  /** Post only answers to a relayed message. */
  repliesOnly: boolean
  /** Whether platform ids may appear in the prompt and the logs. */
  idsInPrompt: boolean
  chatLabel?: string
  /** The platform takes the answer as one message of at most this many characters. */
  replyMaxChars?: number
}

export interface RelayOptions {
  stateDir: string
  routes: Partial<Record<RelayRoute, RouteConfig>>
  pollIntervalMs?: number
  fullReadIntervalMs?: number
  messageWindow?: number
  now?: () => number
  log?: (line: string) => void
  /** Delays before each further delivery attempt; its length is the retry budget. */
  retryDelaysMs?: number[]
  /** vibeterm-api waits this long before it will reconcile an uncertain key. */
  uncertainSettleMs?: number
  claimLeaseMs?: number
  /** How long a post may be offered again under the same transaction id. */
  resendWindowMs?: number
  nackBackoffMs?: number
  typingWindowMs?: number
  maxReplyChars?: number
  /** fsync every journal record (default). Tests turn it off. */
  syncJournal?: boolean
}

/** A message posted this long before the route was registered predates the relay. */
const PREDATE_GRACE_MS = 60_000
const MAX_OUTBOX_BATCH = 10
/**
 * Under Bun.serve()'s 10s idle timeout. The Unix-socket form of its options
 * takes no `idleTimeout`, and `server.timeout()` was measured not to extend it.
 */
export const MAX_WAIT_MS = 8_000

interface PendingPrompt {
  sessionID: string
  key: string
  text: string
}

type Correlation = { relay: RelayRecord; via: "reply-to" | "receipt" | "parent-text" } | null

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function messageChangeKey(message: ApiMessage | undefined): string {
  const info = message?.info
  const error: unknown = info?.["error"]
  return JSON.stringify([
    info?.["id"],
    info?.["role"],
    info?.["time"]?.["completed"],
    info?.["finish"],
    error !== undefined && error !== null,
    typeof error === "object" && error !== null && "name" in error ? error.name : undefined,
  ])
}

export class Relay {
  readonly journal: Journal
  private readonly pendingDir: string
  readonly requeueDir: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly pollIntervalMs: number
  private readonly fullReadIntervalMs: number
  private readonly messageWindow: number
  private readonly retryDelaysMs: number[]
  private readonly uncertainSettleMs: number
  private readonly claimLeaseMs: number
  private readonly resendWindowMs: number
  private readonly nackBackoffMs: number
  private readonly typingWindowMs: number
  private readonly maxReplyChars: number
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private watchTimer: ReturnType<typeof setInterval> | null = null
  private readonly dispatching = new Set<string>()
  private readonly watching = new Set<RelayRoute>()
  private readonly fullReads = new Map<RelayRoute, { readonly key: string; readonly at: number }>()
  private readonly waiters = new Map<RelayRoute, Set<() => void>>()
  private readonly replyText = new Map<string, string>()
  readonly lastWatch = new Map<RelayRoute, { at: number; ok: boolean; error?: string }>()
  /** Extra sections for `health()`, such as a route driver's own state. */
  readonly healthExtras = new Map<string, () => unknown>()
  private stopped = false

  constructor(private readonly api: RelayApi, private readonly options: RelayOptions) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
    this.journal = new Journal(join(options.stateDir, "journal.jsonl"), { sync: options.syncJournal !== false })
    this.pendingDir = join(options.stateDir, "pending")
    mkdirSync(this.pendingDir, { recursive: true, mode: 0o700 })
    this.requeueDir = join(options.stateDir, "requeue")
    mkdirSync(this.requeueDir, { recursive: true, mode: 0o700 })
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(`[RELAY] ${line}`))
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000
    this.fullReadIntervalMs = options.fullReadIntervalMs ?? 60_000
    this.messageWindow = options.messageWindow ?? 40
    this.retryDelaysMs = options.retryDelaysMs ?? [5_000, 15_000, 60_000, 120_000, 300_000, 600_000]
    this.uncertainSettleMs = options.uncertainSettleMs ?? 65_000
    this.claimLeaseMs = options.claimLeaseMs ?? 90_000
    // Synapse caches a transaction id for 30 minutes; stay well inside it.
    this.resendWindowMs = options.resendWindowMs ?? 20 * 60_000
    this.nackBackoffMs = options.nackBackoffMs ?? 10_000
    this.typingWindowMs = options.typingWindowMs ?? 30 * 60_000
    this.maxReplyChars = options.maxReplyChars ?? 12_000
  }

  get state() {
    return this.journal.state
  }

  private route(route: RelayRoute): RouteConfig | undefined {
    const config = this.options.routes[route]
    return config?.enabled ? config : undefined
  }

  private enabledRoutes(): RelayRoute[] {
    return (Object.keys(this.options.routes) as RelayRoute[]).filter((route) => this.route(route))
  }

  async start(): Promise<void> {
    for (const route of this.enabledRoutes()) {
      const config = this.route(route)!
      const existing = this.state.routes.get(route)
      if (existing?.sessionID === config.sessionID) continue
      // Only turns that start after this moment are relayed, so registering a
      // coordinator never posts the history it already has.
      this.journal.append({ kind: "register", at: this.now(), route, sessionID: config.sessionID, watermarkMs: this.now() })
      this.log(`registered ${route} -> ${config.sessionID}`)
    }
    for (const relay of this.state.relays.values()) {
      if (!isTerminalDispatch(relay.dispatch) && this.route(relay.route)) {
        this.scheduleDispatch(relay.relayId, relay.dispatch === "uncertain" ? this.uncertainSettleMs : 0)
      }
    }
    for (const route of this.enabledRoutes()) this.expireClaims(route)
    const loaded = this.journal.loaded
    this.log(`journal: ${loaded.records} records${loaded.skipped ? `, ${loaded.skipped} unreadable lines skipped` : ""}`)
    this.processRequeues()
    this.watchTimer = setInterval(() => {
      this.processRequeues()
      void this.watchAll()
    }, this.pollIntervalMs)
    await this.watchAll()
  }

  stop(): void {
    this.stopped = true
    if (this.watchTimer) clearInterval(this.watchTimer)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const set of this.waiters.values()) for (const wake of set) wake()
    this.journal.close()
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  /**
   * Everything from the dedupe check to the journal append is synchronous, so
   * a connector retrying the same event while the first call is still here
   * cannot make two relays of it.
   */
  async handleInbound(request: InboundRequest): Promise<InboundResponse> {
    if (this.stopped) return { state: "rejected", reason: "relay is stopping" }
    const config = this.route(request.route)
    if (!config) return { state: "rejected", reason: "route disabled" }
    if (!config.allowedRooms.includes(request.roomId)) return { state: "rejected", reason: "chat not allowlisted" }
    if (!config.allowedUsers.includes(request.sender)) return { state: "rejected", reason: "sender not allowlisted" }

    const existing = this.state.relayForEvent(request.route, request.eventId)
    if (existing) return { state: "duplicate", relayId: existing.relayId }

    const registration = this.state.routes.get(request.route)
    if (!registration) return { state: "rejected", reason: "route not registered" }
    if (request.postedAt < registration.registeredAt - PREDATE_GRACE_MS) {
      return { state: "ignored", reason: "posted before the relay served this chat" }
    }
    if (request.implicit) {
      const known = request.threadRootId && this.state.threads.has(threadKey(request.route, request.roomId, request.threadRootId))
      if (!known) return { state: "ignored", reason: "reply in a thread the relay does not serve" }
    }

    const relayId = newId("rly")
    const replyThreadRootId = request.threadRootId || request.eventId
    const text = this.promptFor(config, request, relayId, request.text)
    this.writePending(relayId, { sessionID: config.sessionID, key: `ai-bridge-relay:${relayId}`, text })
    this.journal.append({
      kind: "inbound",
      at: this.now(),
      route: request.route,
      relayId,
      eventId: request.eventId,
      roomId: request.roomId,
      threadRootId: request.threadRootId,
      replyThreadRootId,
      sender: request.sender,
      postedAt: request.postedAt,
      textSha256: sha256(request.text),
      textLength: request.text.length,
      ...(request.replyBy === undefined ? {} : { replyBy: request.replyBy }),
    })
    this.log(`inbound ${relayId} ${request.route} ${this.showId(config, request.eventId)} ${request.implicit ? "thread-reply " : ""}len=${request.text.length}`)
    this.scheduleDispatch(relayId, 0)
    this.wake(request.route)
    return { state: "accepted", relayId }
  }

  private promptFor(
    config: RouteConfig,
    message: Pick<RelayRecord, "route" | "roomId" | "sender" | "eventId" | "threadRootId" | "postedAt" | "replyBy">,
    relayId: string,
    text: string,
  ): string {
    const where = config.repliesOnly ? "your answer is posted back to this chat" : "your answer is posted in this message's thread"
    const once = config.replyMaxChars ? ` as one message of at most ${config.replyMaxChars} characters` : ""
    const until = message.replyBy === undefined ? "" : ", and only until reply_by"
    return buildRelayPrompt(
      {
        route: message.route,
        chat: config.idsInPrompt
          ? `${message.roomId}${config.chatLabel ? ` ("${config.chatLabel}")` : ""}`
          : (config.chatLabel ?? message.route),
        sender: config.idsInPrompt ? message.sender : "owner (own account)",
        event: config.idsInPrompt ? message.eventId : `sha256:${sha256(message.eventId).slice(0, 16)}`,
        thread: message.threadRootId
          ? (config.idsInPrompt ? message.threadRootId : `sha256:${sha256(message.threadRootId).slice(0, 16)}`)
          : "",
        relayId,
        postedAt: message.postedAt,
        trust: "operator",
        replyHint: `${where}${once}${until}; reply exactly NO_REPLY to post nothing`,
        ...(message.replyBy === undefined ? {} : { replyBy: message.replyBy }),
      },
      text,
    )
  }

  /**
   * Redeliver the relays an operator requeued: `<stateDir>/requeue/<relayId>.json`
   * holding `{"text": ...}`, the message as the connector handed it over. Only a
   * definite refusal (`failed`) qualifies, only with the text whose hash the
   * journal recorded, and only under the original key, so vibeterm-api's ledger
   * still makes it one delivery at most. An uncertain relay is never requeued.
   */
  processRequeues(): void {
    let names: string[]
    try {
      names = readdirSync(this.requeueDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const path = join(this.requeueDir, name)
      const verdict = this.requeue(name.slice(0, -".json".length), path)
      rmSync(path, { force: true })
      this.log(verdict)
    }
  }

  private requeue(relayId: string, path: string): string {
    const relay = this.state.relays.get(relayId)
    if (!relay) return `requeue of ${relayId} refused: no such relay`
    if (relay.dispatch !== "failed") return `requeue of ${relayId} refused: its delivery is ${relay.dispatch}, and only a definite refusal is redelivered`
    const config = this.route(relay.route)
    if (!config) return `requeue of ${relayId} refused: route ${relay.route} is disabled`
    let text: unknown
    try {
      text = JSON.parse(readFileSync(path, "utf8"))?.text
    } catch {
      return `requeue of ${relayId} refused: unreadable request`
    }
    if (typeof text !== "string" || sha256(text) !== relay.textSha256) {
      return `requeue of ${relayId} refused: the text does not match the one the journal recorded`
    }
    this.writePending(relayId, { sessionID: config.sessionID, key: `ai-bridge-relay:${relayId}`, text: this.promptFor(config, relay, relayId, text) })
    this.journal.append({ kind: "requeue", at: this.now(), relayId })
    this.scheduleDispatch(relayId, 0)
    this.wake(relay.route)
    return `requeued ${relayId} under its original key`
  }

  // ---------------------------------------------------------------------------
  // Delivery to the coordinator
  // ---------------------------------------------------------------------------

  private scheduleDispatch(relayId: string, delayMs: number): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void this.dispatchOnce(relayId)
    }, delayMs)
    this.timers.add(timer)
  }

  private async dispatchOnce(relayId: string): Promise<void> {
    if (this.stopped || this.dispatching.has(relayId)) return
    const relay = this.state.relays.get(relayId)
    if (!relay || isTerminalDispatch(relay.dispatch)) return
    const pending = this.readPending(relayId)
    if (!pending) {
      this.journal.append({ kind: "dispatch", at: this.now(), relayId, attempt: relay.attempts, outcome: "abandoned", error: "prompt text missing" })
      this.notice(relay, "⚠ The relay lost this message before the coordinator confirmed it. Check the coordinator's tab before resending.")
      return
    }

    this.dispatching.add(relayId)
    const attempt = relay.attempts + 1
    let outcome: PromptOutcome
    try {
      outcome = await this.api.promptAsync(pending.sessionID, pending.key, pending.text)
    } catch (error) {
      outcome = { kind: "uncertain", error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.dispatching.delete(relayId)
    }
    if (this.stopped) return

    const current = this.state.relays.get(relayId)!
    if (current.dispatch === "delivered") {
      this.deletePending(relayId)
      return
    }
    const wasUncertain = current.dispatch === "uncertain"
    switch (outcome.kind) {
      case "delivered":
        this.journal.append({ kind: "dispatch", at: this.now(), relayId, attempt, outcome: "delivered", messageId: outcome.messageId, source: "receipt" })
        this.deletePending(relayId)
        this.log(`delivered ${relayId} as ${outcome.messageId} (attempt ${attempt})`)
        return
      case "failed":
        this.journal.append({ kind: "dispatch", at: this.now(), relayId, attempt, outcome: "failed", status: outcome.status, error: outcome.error })
        this.deletePending(relayId)
        this.log(`delivery of ${relayId} refused: HTTP ${outcome.status}`)
        this.notice(current, `⚠ The coordinator refused this message (HTTP ${outcome.status}). It was not delivered.`)
        return
      case "needs_attention":
        this.journal.append({ kind: "dispatch", at: this.now(), relayId, attempt, outcome: "needs_attention", status: outcome.status, error: outcome.error })
        this.deletePending(relayId)
        this.log(`delivery of ${relayId} needs attention: HTTP ${outcome.status}`)
        this.notice(current, "⚠ Delivery is blocked: the coordinator's tab holds unsent text. Clear its composer, then resend this message.")
        return
      case "retry":
      case "uncertain": {
        this.journal.append({
          kind: "dispatch",
          at: this.now(),
          relayId,
          attempt,
          outcome: outcome.kind,
          ...(outcome.status === undefined ? {} : { status: outcome.status }),
          error: outcome.error,
        })
        if (attempt > this.retryDelaysMs.length) {
          this.journal.append({ kind: "dispatch", at: this.now(), relayId, attempt, outcome: "abandoned", error: "retry budget spent" })
          this.deletePending(relayId)
          const uncertain = wasUncertain || outcome.kind === "uncertain"
          this.log(`gave up on ${relayId} after ${attempt} attempts (${uncertain ? "uncertain" : "not delivered"})`)
          this.notice(
            current,
            uncertain
              ? "⚠ The relay could not confirm this message reached the coordinator. Check the coordinator's tab before resending."
              : "⚠ The relay could not reach the coordinator, so this message was not delivered. Resend it later.",
          )
          return
        }
        const base = this.retryDelaysMs[attempt - 1] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1]
        const delay = outcome.kind === "uncertain" || wasUncertain ? Math.max(base, this.uncertainSettleMs) : base
        this.log(`delivery of ${relayId} ${outcome.kind} (attempt ${attempt}); retrying in ${Math.round(delay / 1000)}s with the same key`)
        this.scheduleDispatch(relayId, delay)
        return
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Coordinator turns
  // ---------------------------------------------------------------------------

  async watchAll(): Promise<void> {
    await Promise.all(this.enabledRoutes().map((route) => this.watchRoute(route)))
  }

  async watchRoute(route: RelayRoute): Promise<void> {
    if (this.stopped || this.watching.has(route)) return
    const config = this.route(route)
    const registration = this.state.routes.get(route)
    if (!config || !registration) return
    this.watching.add(route)
    try {
      const probe = await this.api.messages(registration.sessionID, 1)
      if (this.stopped) return
      const previous = this.lastWatch.get(route)
      const fullRead = this.fullReads.get(route)
      if (!fullRead || !previous?.ok || messageChangeKey(probe.at(-1)) !== fullRead.key || this.now() - fullRead.at >= this.fullReadIntervalMs) {
        const messages = await this.api.messages(registration.sessionID, this.messageWindow)
        if (this.stopped) return
        const turns = findFinalTurns(messages, registration.watermarkMs, this.state.processedTurns)
        for (const turn of turns) {
          if (this.stopped) return
          await this.handleTurn(route, config, registration.sessionID, turn, messages)
        }
        if (this.stopped) return
        this.fullReads.set(route, { key: messageChangeKey(messages.at(-1)), at: this.now() })
      }
      if (previous && !previous.ok) this.log(`${route} transcript readable again`)
      this.lastWatch.set(route, { at: this.now(), ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const previous = this.lastWatch.get(route)
      if (!previous || previous.ok || previous.error !== message) this.log(`${route} transcript read failed: ${message}`)
      this.lastWatch.set(route, { at: this.now(), ok: false, error: message })
    } finally {
      this.watching.delete(route)
    }
  }

  private async correlate(route: RelayRoute, sessionID: string, turn: FinalTurn, messages: readonly ApiMessage[]): Promise<Correlation> {
    if (turn.replyTo) {
      const relay = this.state.relays.get(turn.replyTo)
      if (relay && relay.route === route) return { relay, via: "reply-to" }
    }
    if (!turn.parentID) return null
    const byReceipt = this.state.byUserMessage.get(turn.parentID)
    if (byReceipt) {
      const relay = this.state.relays.get(byReceipt)
      if (relay) return { relay, via: "receipt" }
    }
    // The parent row names its relay id, which also settles a delivery whose
    // receipt was lost: the turn answering it is proof it landed.
    const parent = messages.find((m) => m.info?.["id"] === turn.parentID) ?? (await this.api.message(sessionID, turn.parentID))
    if (!parent || parent.info?.["role"] !== "user") return null
    const relayId = parseRelayId(messageText(parent.parts ?? []))
    if (!relayId) return null
    const relay = this.state.relays.get(relayId)
    return relay && relay.route === route ? { relay, via: "parent-text" } : null
  }

  private async handleTurn(route: RelayRoute, config: RouteConfig, sessionID: string, turn: FinalTurn, messages: readonly ApiMessage[]): Promise<void> {
    const correlation = await this.correlate(route, sessionID, turn, messages)
    if (this.stopped) return
    const relay = correlation?.relay ?? null

    if (relay && correlation?.via === "parent-text" && relay.dispatch !== "delivered") {
      this.journal.append({ kind: "dispatch", at: this.now(), relayId: relay.relayId, attempt: relay.attempts, outcome: "delivered", messageId: turn.parentID, source: "observed" })
      this.deletePending(relay.relayId)
      this.log(`delivery of ${relay.relayId} observed as ${turn.parentID}`)
    }

    const record = (disposition: "outbox" | "no_reply" | "suppressed" | "empty" | "compaction", outboxId?: string) => {
      this.journal.append({
        kind: "turn",
        at: this.now(),
        route,
        sessionID,
        messageID: turn.messageID,
        parentID: turn.parentID,
        relayId: relay?.relayId ?? null,
        disposition,
        ...(outboxId === undefined ? {} : { outboxId }),
      })
    }

    // A crash between queueing a post and recording the turn must not queue it twice.
    const queued = this.state.outbox.get(this.state.outboxByMessage.get(turn.messageID) ?? "")
    if (queued) {
      record("outbox", queued.outboxId)
      return
    }

    switch (turn.kind) {
      case "compaction":
        record("compaction")
        return
      case "error":
        if (relay) {
          record("outbox", this.notice(relay, `⚠ The coordinator's turn ended with ${turn.errorName ?? "an error"}.`, turn.messageID))
        } else {
          record("suppressed")
        }
        return
      case "empty":
        if (relay) record("outbox", this.notice(relay, "The coordinator finished without a text reply.", turn.messageID))
        else record("empty")
        return
      case "text": {
        if (turn.noReply) {
          record("no_reply")
          this.log(`turn ${turn.messageID} replied NO_REPLY`)
          return
        }
        if (!relay && (config.repliesOnly || !config.defaultRoom)) {
          record("suppressed")
          this.log(`turn ${turn.messageID} answers no relayed message; not posted on ${route}`)
          return
        }
        record("outbox", this.enqueueReply(route, sessionID, turn, relay, config))
        return
      }
    }
  }

  private truncate(text: string): string {
    if (text.length <= this.maxReplyChars) return text
    return text.slice(0, this.maxReplyChars) + "\n… (truncated; the full reply is in the coordinator's session)"
  }

  private enqueueReply(route: RelayRoute, sessionID: string, turn: FinalTurn, relay: RelayRecord | null, config: RouteConfig): string {
    const text = this.truncate(turn.text)
    const outboxId = newId("obx")
    const target = relay
      ? { roomId: relay.roomId, threadRootId: relay.replyThreadRootId, replyToEventId: relay.eventId }
      : { roomId: config.defaultRoom, threadRootId: "", replyToEventId: "" }
    this.journal.append({
      kind: "outbox",
      at: this.now(),
      outboxId,
      route,
      relayId: relay?.relayId ?? null,
      sessionID,
      messageID: turn.messageID,
      itemKind: "reply",
      ...target,
      textSha256: sha256(text),
      textLength: text.length,
    })
    this.replyText.set(outboxId, text)
    this.log(`queued ${outboxId} for ${route} ${relay ? `in the thread of ${relay.relayId}` : "top-level"} (turn ${turn.messageID}, len=${text.length})`)
    this.wake(route)
    return outboxId
  }

  /** A relay-authored line in the thread of `relay`. It never carries chat or model text. */
  private notice(relay: RelayRecord, text: string, messageID: string | null = null): string {
    const registration = this.state.routes.get(relay.route)
    const outboxId = newId("obx")
    this.journal.append({
      kind: "outbox",
      at: this.now(),
      outboxId,
      route: relay.route,
      relayId: relay.relayId,
      sessionID: registration?.sessionID ?? "",
      messageID,
      itemKind: "notice",
      roomId: relay.roomId,
      threadRootId: relay.replyThreadRootId,
      replyToEventId: relay.eventId,
      textSha256: sha256(text),
      textLength: text.length,
      noticeText: text,
    })
    this.wake(relay.route)
    return outboxId
  }

  // ---------------------------------------------------------------------------
  // Outbox, drained by the connector
  // ---------------------------------------------------------------------------

  private wake(route: RelayRoute): void {
    const set = this.waiters.get(route)
    if (!set) return
    this.waiters.delete(route)
    for (const wake of set) wake()
  }

  private waitFor(route: RelayRoute, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(route)
      if (!set) this.waiters.set(route, (set = new Set()))
      const done = () => {
        clearTimeout(timer)
        set!.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      set.add(done)
    })
  }

  /**
   * Once an item has been handed to the connector it may have reached the
   * platform, even after a failure report. Past the window in which the
   * platform deduplicates its transaction id, offering it again could post it
   * twice, so it is recorded as uncertain instead.
   */
  private expireClaims(route: RelayRoute): void {
    const now = this.now()
    for (const item of this.state.outbox.values()) {
      if (item.route !== route || item.firstClaimAt === undefined) continue
      if (item.state !== "claimed" && item.state !== "pending") continue
      if (now - item.firstClaimAt < this.resendWindowMs) continue
      this.journal.append({ kind: "send_uncertain", at: now, outboxId: item.outboxId, reason: "taken by the connector and never confirmed" })
      this.log(`post ${item.outboxId} unconfirmed past the resend window; not offered again`)
    }
  }

  private claimable(route: RelayRoute): OutboxRecord[] {
    const now = this.now()
    return [...this.state.outbox.values()]
      .filter((item) => {
        if (item.route !== route) return false
        if (item.state === "pending") return item.lastClaimAt === undefined || now - item.lastClaimAt >= this.nackBackoffMs
        if (item.state === "claimed") return item.lastClaimAt !== undefined && now - item.lastClaimAt >= this.claimLeaseMs
        return false
      })
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  private async itemText(item: OutboxRecord): Promise<string | null> {
    if (item.itemKind === "notice") return item.noticeText ?? null
    const cached = this.replyText.get(item.outboxId)
    if (cached !== undefined) return cached
    if (!item.messageID) return null
    const message = await this.api.message(item.sessionID, item.messageID)
    if (!message) return null
    const text = this.truncate(parseReplyDirectives(messageText(message.parts ?? [])).text)
    this.replyText.set(item.outboxId, text)
    return text
  }

  async takeOutbox(route: RelayRoute, waitMs: number): Promise<OutboxResponse> {
    if (!this.route(route)) return { items: [], typingRooms: [] }
    this.expireClaims(route)
    let candidates = this.claimable(route)
    if (candidates.length === 0 && waitMs > 0 && !this.stopped) {
      await this.waitFor(route, Math.min(waitMs, MAX_WAIT_MS))
      if (this.stopped) return { items: [], typingRooms: [] }
      this.expireClaims(route)
      candidates = this.claimable(route)
    }
    const items: OutboxItem[] = []
    for (const item of candidates.slice(0, MAX_OUTBOX_BATCH)) {
      let text: string | null
      try {
        text = await this.itemText(item)
      } catch (error) {
        this.log(`text of ${item.outboxId} unreadable for now: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (this.stopped) break
      if (text === null) {
        this.journal.append({ kind: "send_failed", at: this.now(), outboxId: item.outboxId, error: "reply text no longer readable", definite: true })
        continue
      }
      this.journal.append({ kind: "claim", at: this.now(), outboxId: item.outboxId })
      const replyBy = item.relayId ? this.state.relays.get(item.relayId)?.replyBy : undefined
      items.push({
        outboxId: item.outboxId,
        txnId: `aibr-${item.outboxId}`,
        roomId: item.roomId,
        threadRootId: item.threadRootId,
        replyToEventId: item.replyToEventId,
        text,
        kind: item.itemKind,
        ...(replyBy === undefined ? {} : { replyBy }),
      })
    }
    return { items, typingRooms: this.typingRooms(route) }
  }

  typingRooms(route: RelayRoute): string[] {
    const now = this.now()
    const rooms = new Set<string>()
    for (const relay of this.state.relays.values()) {
      if (relay.route !== route || relay.answeredBy) continue
      if (relay.dispatch !== "pending" && relay.dispatch !== "uncertain" && relay.dispatch !== "delivered") continue
      if (now - relay.receivedAt > this.typingWindowMs) continue
      rooms.add(relay.roomId)
    }
    return [...rooms]
  }

  ack(request: AckRequest): boolean {
    const item = this.state.outbox.get(request.outboxId)
    if (!item) return false
    if (item.state === "sent") return true
    this.journal.append({ kind: "sent", at: this.now(), outboxId: item.outboxId, chatEventId: request.chatEventId })
    this.replyText.delete(item.outboxId)
    this.log(`posted ${item.outboxId} on ${item.route}`)
    return true
  }

  /** The connector cannot tell whether a post went out. Recorded, and never offered again. */
  markUncertain(outboxId: string, reason: string): boolean {
    const item = this.state.outbox.get(outboxId)
    if (!item) return false
    if (item.state === "sent") return true
    this.journal.append({ kind: "send_uncertain", at: this.now(), outboxId, reason: reason.slice(0, 300) })
    this.log(`post ${outboxId} may have been sent; not offered again`)
    return true
  }

  nack(request: NackRequest): boolean {
    const item = this.state.outbox.get(request.outboxId)
    if (!item) return false
    if (item.state === "sent") return true
    this.journal.append({ kind: "send_failed", at: this.now(), outboxId: item.outboxId, error: request.error.slice(0, 300), definite: request.definite })
    this.log(`post ${item.outboxId} ${request.definite ? "refused by the platform" : "failed; will offer again"}`)
    return true
  }

  // ---------------------------------------------------------------------------
  // State on disk and health
  // ---------------------------------------------------------------------------

  private showId(config: RouteConfig, id: string): string {
    return config.idsInPrompt ? id : `sha256:${sha256(id).slice(0, 16)}`
  }

  private pendingPath(relayId: string): string {
    return join(this.pendingDir, `${relayId}.json`)
  }

  private writePending(relayId: string, prompt: PendingPrompt): void {
    const path = this.pendingPath(relayId)
    writeFileSync(`${path}.tmp`, JSON.stringify(prompt), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }

  private readPending(relayId: string): PendingPrompt | null {
    const path = this.pendingPath(relayId)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8")) as PendingPrompt
    } catch {
      return null
    }
  }

  private deletePending(relayId: string): void {
    rmSync(this.pendingPath(relayId), { force: true })
  }

  health(): Record<string, unknown> {
    const count = <T extends string>(values: Iterable<T>) => {
      const out: Record<string, number> = {}
      for (const value of values) out[value] = (out[value] ?? 0) + 1
      return out
    }
    const routes: Record<string, unknown> = {}
    for (const [route, config] of Object.entries(this.options.routes) as Array<[RelayRoute, RouteConfig]>) {
      const registration = this.state.routes.get(route)
      routes[route] = {
        enabled: config.enabled,
        sessionID: config.sessionID,
        ...(registration ? { registeredAt: new Date(registration.registeredAt).toISOString() } : {}),
        lastWatch: this.lastWatch.get(route) ?? null,
      }
    }
    return {
      ok: !this.stopped,
      routes,
      relays: count([...this.state.relays.values()].map((r) => r.dispatch)),
      outbox: count([...this.state.outbox.values()].map((o) => o.state)),
      journal: { records: this.journal.loaded.records, skipped: this.journal.loaded.skipped },
      ...Object.fromEntries([...this.healthExtras].map(([name, read]) => [name, read()])),
    }
  }
}
