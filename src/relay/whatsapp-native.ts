/**
 * The relay's WhatsApp route, over the desktop app's own local controls
 * (whatsapp-nativefier, `control/PROTOCOL.txt`). The relay speaks no WhatsApp
 * protocol and holds no WhatsApp credential: it reads the app's private event
 * journal through the app's own client module (`control/client.cjs`, which
 * reads the endpoint record and its secret itself) and asks the app to reply.
 *
 * Reading starts at the app's live-head cursor, so nothing the app saw before
 * that head is ever a prompt, and it never asks for a new head: that would
 * demote a message already observed. A message becomes a prompt only when
 * every guard in `promptFromEvent` holds. They mirror the app's own reply gate
 * (`control/replies.cjs`, `parent()`), which stays authoritative: it checks
 * again when the reply is sent, and its refusal is final.
 *
 * In hold mode a qualifying message is written to a private record for review
 * instead, and only an operator release (`whatsapp-release.ts`) hands it on.
 * Each owner message gets at most one `messages.reply`, whose exact request is
 * written down before the first attempt and only ever replayed unchanged.
 */

import { randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { AckRequest, InboundRequest, InboundResponse, NackRequest, OutboxItem, OutboxResponse } from "./types"

export type NativeCall = (operation: string, payload: Record<string, unknown>) => Promise<any>

export class NativeError extends Error {
  constructor(readonly code: string) {
    super(`whatsapp controls: ${code}`)
    this.name = "NativeError"
  }
}

/** The app's own client, loaded from where the app is installed. */
export function nativeClient(modulePath: string): NativeCall {
  const call = (createRequire(import.meta.url)(modulePath) as { call?: unknown }).call
  if (typeof call !== "function") throw new Error(`${modulePath} exports no call()`)
  return async (operation, payload) => {
    try {
      return await (call as (operation: string, payload: unknown) => Promise<unknown>)(operation, payload)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      throw new NativeError(typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "OPERATION_FAILED")
    }
  }
}

// -----------------------------------------------------------------------------
// Which message is a prompt
// -----------------------------------------------------------------------------

export interface Gate {
  /** The designated group's provider id (`...@g.us`). */
  groupJid: string
  /** The app's id for that group, as the reply capability names it. */
  conversationId: string
  trigger: string
  /** How long after a post the app accepts its answer (`replies.cjs`: 10 minutes). */
  windowMs: number
  /** The app generation being followed; a message from any other is never answered. */
  generation: string
  /** No message at or below this journal sequence: the live head, or a later gap or reset. */
  floorSequence: number
  /** No message posted or observed at or before this moment: the live head's. */
  notBefore: number
}

export interface Prompt {
  /** The provider's message id; the reply is bound to it. */
  eventId: string
  text: string
  postedAt: number
  observedAt: number
  sequence: number
}

export type PromptDecision = ({ ok: true } & Prompt) | { ok: false; reason: string }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * How far ahead of this host's clock a post's timestamp may be. The phone
 * stamps it, so a slightly fast phone is not a future message; the app checks
 * the timestamp again when the reply is sent, which is minutes later.
 */
const PHONE_CLOCK_SKEW_MS = 60_000

export function promptFromEvent(event: any, gate: Gate, now: number): PromptDecision {
  const no = (reason: string): PromptDecision => ({ ok: false, reason })
  if (event?.kind !== "message") return no(`kind ${String(event?.kind)}`)
  const m = event.message
  if (!m || typeof m !== "object") return no("no message")
  if (event.conversation_id !== gate.conversationId || m.chat_id !== gate.groupJid) return no("another chat")
  if (m.from_me !== true) return no("not the account's own message")
  if (m.trusted_self !== true) return no("sender not trusted as the account")
  if (m.send_request_id !== null) return no(m.send_request_id === undefined ? "echo marker not reported" : "echo of a relay reply")
  if (event.origin !== "live") return no(`origin ${String(event.origin)}`)
  if (event.generation !== gate.generation) return no("another generation")
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= gate.floorSequence) return no("not after the live head and every discontinuity")
  if (m.forwarded !== false) return no(m.forwarded === true ? "forwarded" : "forwarding not reported")
  if (m.quoted !== false || m.quoted_message_id !== null) return no("quotes a message")
  if (m.type !== "chat" || typeof m.text !== "string") return no(`type ${String(m.type)}`)
  if (m.text_truncated !== false) return no("text truncated")
  if (m.deleted !== false || m.revision !== "original") return no("edited or deleted")
  if (m.attachment !== null) return no("carries an attachment")
  const postedAt = m.timestamp
  const observedAt = event.observed_at
  if (!Number.isSafeInteger(postedAt) || !Number.isSafeInteger(observedAt)) return no("no timestamp")
  if (postedAt <= gate.notBefore || observedAt <= gate.notBefore) return no("posted or observed before the live head")
  if (postedAt > now + PHONE_CLOCK_SKEW_MS || observedAt > now) return no("timestamp in the future")
  if (Math.min(postedAt, observedAt) + gate.windowMs <= now) return no("older than the reply window")
  if (typeof m.id !== "string" || !m.id) return no("no message id")
  const trigger = new RegExp(`^${escapeRegExp(gate.trigger)}(?:\\s|$)`, "u").exec(m.text)
  if (!trigger) return no("no trigger")
  const text = m.text.slice(trigger[0].length).trim()
  if (!text) return no("nothing after the trigger")
  return { ok: true, eventId: m.id, text, postedAt, observedAt, sequence: event.sequence }
}

// -----------------------------------------------------------------------------
// The reply
// -----------------------------------------------------------------------------

export const WHATSAPP_TEXT_LIMIT = 4_096
export const TRUNCATION_NOTE = "\n… (cut to fit one WhatsApp message; the whole answer is in the coordinator's session)"

/**
 * One message: the marker, then the body cut to fit. JavaScript string length
 * counts UTF-16 units, which is what the app's limit is in.
 */
export function fitReply(body: string, prefix: string, limit = WHATSAPP_TEXT_LIMIT): string {
  const text = body.trim()
  if (prefix.length + text.length <= limit) return prefix + text
  let cut = limit - prefix.length - TRUNCATION_NOTE.length
  if (cut < 1) throw new Error("the marker leaves no room for text")
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut--
  return prefix + text.slice(0, cut).trimEnd() + TRUNCATION_NOTE
}

/** The exact five fields of `messages.reply`. */
export interface ReplyRequest {
  capability_id: string
  conversation_id: string
  parent_message_id: string
  text: string
  request_id: string
}

export type ReplyOutcome =
  /** The app reports it sent; `messageId` is the provider's id. */
  | { kind: "sent"; messageId: string; state: string }
  /** It may have been sent. Terminal: never attempted again. */
  | { kind: "unknown"; error: string }
  /** Refused before anything was reserved, for good. */
  | { kind: "refused"; error: string }
  /** Refused before anything was reserved, for now: the same request may go again. */
  | { kind: "rate_limited"; error: string }
  /** Nothing settles it. Only replaying the same request can read the app's ledger. */
  | { kind: "unresolved"; error: string }

export interface ReplySender {
  reply(request: ReplyRequest): Promise<ReplyOutcome>
}

const SENT_STATES = new Set(["submitted", "server_ack", "delivered"])
/** Refusals the app raises before it reserves a reply: final for that request. */
const TERMINAL_CODES = new Set([
  "INVALID_REQUEST",
  "INVALID_CURSOR",
  "INVALID_JOURNAL",
  "CAPABILITY_REQUIRED",
  "CAPABILITY_MISMATCH",
  "UNTRUSTED_PARENT",
  "OWNER_MISMATCH",
  "DESIGNATED_GROUP_REQUIRED",
  "PARENT_CONSUMED",
  "REQUEST_CONFLICT",
  "REPLY_ROUTING_REQUIRED",
  "STALE_IDENTITY",
])

export function nativeReplySender(call: NativeCall): ReplySender {
  return {
    async reply(request) {
      let result: any
      try {
        result = await call("messages.reply", { ...request })
      } catch (error) {
        const code = error instanceof NativeError ? error.code : "OPERATION_FAILED"
        if (TERMINAL_CODES.has(code)) return { kind: "refused", error: code }
        if (code === "REPLY_RATE_LIMIT") return { kind: "rate_limited", error: code }
        // A transport failure, OPERATION_FAILED or a code this does not know
        // says nothing about whether a reply was reserved.
        return { kind: "unresolved", error: code }
      }
      if (
        SENT_STATES.has(result?.state) &&
        typeof result?.provider_message_id === "string" &&
        result.provider_message_id &&
        result?.send_request_id === request.request_id
      ) {
        return { kind: "sent", messageId: result.provider_message_id, state: result.state }
      }
      return { kind: "unknown", error: `reply state ${String(result?.state)}` }
    },
  }
}

// -----------------------------------------------------------------------------
// Private files
// -----------------------------------------------------------------------------

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error(`${path} is not a private directory`)
}

/** Written whole and flushed, then renamed into place: a crash leaves the old file or the new one. */
function writePrivate(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  const dir = openSync(dirname(path), constants.O_RDONLY)
  try {
    fsyncSync(dir)
  } finally {
    closeSync(dir)
  }
}

/** A private regular file of this user, never read through a symlink. */
function readPrivate<T>(path: string): T {
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error(`${path} is not a private file`)
  return JSON.parse(readFileSync(path, "utf8")) as T
}

// -----------------------------------------------------------------------------
// The driver
// -----------------------------------------------------------------------------

export interface RelayPort {
  handleInbound(request: InboundRequest): Promise<InboundResponse>
  takeOutbox(route: "whatsapp", waitMs: number): Promise<OutboxResponse>
  ack(request: AckRequest): boolean
  nack(request: NackRequest): boolean
  markUncertain(outboxId: string, reason: string): boolean
}

interface DriverState {
  version: 2
  account: string
  generation: string
  conversationId: string
  cursor: string
  headSequence: number
  notBefore: number
  /** The latest gap or reset seen in the followed generation. */
  discontinuity: number
}

export interface HeldRecord {
  version: 1
  name: string
  heldAt: string
  verdict: "prompt" | "not-a-prompt"
  reason: string | null
  sequence: number
  generation: string | null
  origin: string | null
  observedAt: number | null
  conversationId: string | null
  message: Record<string, unknown>
  replyBy: number | null
  prompt: Prompt | null
  invalidated: { at: string; reason: string } | null
  released?: { at: string; outcome: string }
}

interface FrozenReply {
  version: 1
  outboxId: string
  request: ReplyRequest
  replyBy: number
  frozenAt: string
  attempts: number
  unresolved: number
  last: ReplyOutcome["kind"] | null
  outcome: ReplyOutcome | null
}

export interface WhatsAppNativeOptions {
  relay: RelayPort
  call: NativeCall
  sender: ReplySender
  /** Private directory for the cursor, held records and frozen replies. */
  stateDir: string
  /** The app's live-head record; read once, to seed the first cursor. */
  headFile: string
  groupJid: string
  conversationId: string
  capabilityId: string
  capabilityExpiresAt: number
  /** The sender id the relay's allowlist knows the account by. */
  ownerSender: string
  aiPrefix: string
  hold: boolean
  trigger?: string
  windowMs?: number
  /** Taken off every reply deadline, for the transport and the app's own checks. */
  safetyMarginMs?: number
  /** A release with less than this left before the deadline is refused. */
  minReleaseWindowMs?: number
  /** Told, by path only, about every own message held for review. */
  notifySessions?: string[]
  /** Woken without the message when a prompt is held, so its tab is up if it is released. */
  coordinatorSession?: string
  notify?: (sessionID: string, key: string, text: string) => Promise<{ kind: string }>
  releaseCommand?: string
  pollIntervalMs?: number
  pageLimit?: number
  /** Replays of one exact request that settle nothing before it is recorded as unknown. */
  maxUnresolved?: number
  now?: () => number
  log?: (line: string) => void
}

const PLAINTEXT_MEMORY = 1_000

export class WhatsAppNativeDriver {
  private state: DriverState | null = null
  private stopped = false
  private halted: string | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private readonly dirs: { held: string; release: string; done: string; discarded: string; replies: string }
  private readonly statePath: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly held = new Map<string, HeldRecord>()
  /** Provider id -> the sequence of its first plaintext observation. */
  private readonly plaintext = new Map<string, number>()
  private readonly answeredParents = new Set<string>()
  private lastPoll: { at: number; ok: boolean; error?: string } | null = null
  private lastError = ""

  constructor(private readonly options: WhatsAppNativeOptions) {
    const base = options.stateDir
    this.dirs = {
      held: join(base, "held"),
      release: join(base, "release"),
      done: join(base, "done"),
      discarded: join(base, "discarded"),
      replies: join(base, "replies"),
    }
    this.statePath = join(base, "driver.json")
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(`[RELAY] whatsapp: ${line}`))
  }

  private get windowMs(): number {
    return this.options.windowMs ?? 600_000
  }

  async start(): Promise<void> {
    ensurePrivateDir(this.options.stateDir)
    for (const dir of Object.values(this.dirs)) ensurePrivateDir(dir)
    this.state = existsSync(this.statePath) ? this.load() : this.seed()
    for (const dir of [this.dirs.held, this.dirs.release]) {
      for (const file of readdirSync(dir).filter((f) => /^s\d+\.json$/.test(f))) {
        const record = readPrivate<HeldRecord>(join(dir, file))
        this.held.set(record.name, record)
        if (record.verdict === "prompt" && typeof record.message?.["id"] === "string") this.plaintext.set(record.message["id"] as string, record.sequence)
      }
    }
    for (const file of readdirSync(this.dirs.replies).filter((f) => f.endsWith(".json"))) {
      this.answeredParents.add(readPrivate<FrozenReply>(join(this.dirs.replies, file)).request.parent_message_id)
    }
    if (this.options.capabilityExpiresAt <= this.now()) this.log("the reply capability has expired; no reply can be sent until the app grants a new one")
    this.log(`${this.options.hold ? "HOLD: own messages are kept for review, nothing is prompted" : "live"}; ${this.held.size} held`)
    this.schedulePoll(0)
    void this.outboxLoop()
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
  }

  health(): Record<string, unknown> {
    return {
      hold: this.options.hold,
      halted: this.halted,
      lastPoll: this.lastPoll,
      held: [...this.held.values()].filter((r) => !r.invalidated).length,
      capabilityExpiresAt: new Date(this.options.capabilityExpiresAt).toISOString(),
    }
  }

  private load(): DriverState {
    const state = readPrivate<DriverState>(this.statePath)
    if (state?.version !== 2 || typeof state.cursor !== "string" || typeof state.generation !== "string") {
      throw new Error(`unreadable driver state: ${this.statePath}`)
    }
    if (state.conversationId !== this.options.conversationId) {
      throw new Error("the reply capability names another conversation than the cursor follows")
    }
    return state
  }

  private seed(): DriverState {
    const head = JSON.parse(readFileSync(this.options.headFile, "utf8"))
    if (
      head?.live_head !== true ||
      typeof head.cursor !== "string" ||
      typeof head.account !== "string" ||
      typeof head.generation !== "string" ||
      !Number.isSafeInteger(head.high_water) ||
      !Number.isSafeInteger(head.observed_at)
    ) {
      throw new Error("the app's live-head record is not one")
    }
    const state: DriverState = {
      version: 2,
      account: head.account,
      generation: head.generation,
      conversationId: this.options.conversationId,
      cursor: head.cursor,
      headSequence: head.high_water,
      notBefore: head.observed_at,
      discontinuity: 0,
    }
    writePrivate(this.statePath, state)
    this.log(`starting at the app's live head, sequence ${head.high_water}; nothing before it is read`)
    return state
  }

  private gate(): Gate {
    const state = this.state!
    return {
      groupJid: this.options.groupJid,
      conversationId: this.options.conversationId,
      trigger: this.options.trigger ?? "!oc",
      windowMs: this.windowMs,
      generation: state.generation,
      floorSequence: Math.max(state.headSequence, state.discontinuity),
      notBefore: state.notBefore,
    }
  }

  /** The last moment a reply is worth sending: the app's own deadlines, less a margin. */
  replyBy(prompt: Prompt): number {
    const deadline = Math.min(prompt.postedAt + this.windowMs, prompt.observedAt + this.windowMs, this.options.capabilityExpiresAt)
    return deadline - (this.options.safetyMarginMs ?? 30_000)
  }

  // ---------------------------------------------------------------------------
  // Reading the journal
  // ---------------------------------------------------------------------------

  private schedulePoll(delayMs: number): void {
    if (this.stopped || this.halted) return
    this.pollTimer = setTimeout(() => void this.cycle(), delayMs)
  }

  private async cycle(): Promise<void> {
    try {
      while (!this.stopped && !this.halted && (await this.pollOnce())) {}
      if (!this.stopped && !this.halted) await this.processReleases()
      if (this.lastError) this.log("journal readable again")
      this.lastError = ""
      this.lastPoll = { at: this.now(), ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.lastError) {
        this.log(`journal poll failed: ${message}`)
        if (message.includes("INVALID_CURSOR")) this.log(`the cursor is no longer valid; to start again at the app's current live head, remove ${this.statePath}`)
      }
      this.lastError = message
      this.lastPoll = { at: this.now(), ok: false, error: message }
    }
    this.schedulePoll(this.options.pollIntervalMs ?? 3_000)
  }

  /** One page. Everything it causes is on disk before the cursor moves past it. */
  async pollOnce(): Promise<boolean> {
    if (this.halted || !this.state) return false
    const state = this.state
    const limit = this.options.pageLimit ?? 100
    const page = await this.options.call("messages.events", { conversation_id: state.conversationId, cursor: state.cursor, limit })
    if (page?.account !== state.account) {
      this.halt("the app reports a different WhatsApp account")
      return false
    }
    if (typeof page.cursor !== "string") throw new Error("events page without a cursor")
    const events: any[] = Array.isArray(page.events) ? page.events : []
    for (const event of events) await this.handleEvent(event)
    if (typeof page.generation === "string" && page.generation !== state.generation) this.newGeneration(page.generation)
    state.cursor = page.cursor
    writePrivate(this.statePath, state)
    return events.length >= limit
  }

  private async handleEvent(event: any): Promise<void> {
    const sequence = Number.isSafeInteger(event?.sequence) ? (event.sequence as number) : null
    if (event?.kind === "gap" || event?.kind === "reset") {
      this.log(`journal ${event.kind} at s${sequence ?? "?"}: ${String(event.reason ?? "")}`)
      if (typeof event.generation === "string" && event.generation !== this.state!.generation) this.newGeneration(event.generation)
      if (sequence !== null && sequence > this.state!.discontinuity) this.state!.discontinuity = sequence
      this.invalidate((r) => sequence === null || r.sequence < sequence, `a journal ${event.kind} followed it`)
      return
    }
    const m = event?.message
    if (!m || typeof m !== "object" || typeof m.id !== "string") return
    if (event.kind === "edit" || event.kind === "delete") {
      this.invalidate((r) => r.message["id"] === m.id, `the message was ${event.kind === "edit" ? "edited" : "deleted"}`)
      return
    }
    // An acknowledgement changes nothing; other participants are never prompts.
    if (event.kind !== "message" || event.conversation_id !== this.options.conversationId || m.from_me !== true) return
    if (m.send_request_id !== null && m.send_request_id !== undefined) {
      this.log(`s${sequence}: echo of a relay reply`)
      return
    }
    // A ciphertext observation is followed by the plaintext one, which is the message.
    if (m.type === "ciphertext") return
    const first = this.plaintext.get(m.id)
    if (first !== undefined && first !== sequence) {
      this.invalidate((r) => r.message["id"] === m.id, "a second plaintext observation of the same message")
      this.log(`s${sequence}: a second plaintext observation of one message; neither is answered`)
      return
    }
    this.plaintext.set(m.id, sequence ?? -1)
    if (this.plaintext.size > PLAINTEXT_MEMORY) this.plaintext.delete(this.plaintext.keys().next().value!)

    const decision = promptFromEvent(event, this.gate(), this.now())
    if (this.options.hold) {
      this.hold(event, decision)
      return
    }
    if (!decision.ok) {
      this.log(`s${sequence}: own message is not a prompt: ${decision.reason}`)
      return
    }
    await this.handOver(decision, `s${decision.sequence}`, this.replyBy(decision))
  }

  private newGeneration(generation: string): void {
    this.log("the app started a new generation; nothing observed before it can be answered")
    this.state!.generation = generation
    this.invalidate((r) => r.generation !== generation, "the app started a new generation")
  }

  private halt(reason: string): void {
    this.halted = reason
    this.log(`${reason}; the route is stopped until it is verified again`)
  }

  private async handOver(prompt: Prompt, label: string, replyBy: number): Promise<InboundResponse> {
    const result = await this.options.relay.handleInbound({
      route: "whatsapp",
      eventId: prompt.eventId,
      roomId: this.options.groupJid,
      threadRootId: "",
      sender: this.options.ownerSender,
      postedAt: prompt.postedAt,
      text: prompt.text,
      implicit: false,
      replyBy,
    })
    this.log(`${label}: prompt ${result.state}${result.relayId ? ` ${result.relayId}` : ""}${result.reason ? `: ${result.reason}` : ""}`)
    return result
  }

  // ---------------------------------------------------------------------------
  // Hold and release
  // ---------------------------------------------------------------------------

  private reviewed(name: string): boolean {
    return this.held.has(name) || [this.dirs.held, this.dirs.release, this.dirs.done, this.dirs.discarded].some((dir) => existsSync(join(dir, `${name}.json`)))
  }

  private hold(event: any, decision: PromptDecision): void {
    const name = `s${event.sequence}`
    if (!Number.isSafeInteger(event.sequence) || this.reviewed(name)) return
    const m = event.message
    const record: HeldRecord = {
      version: 1,
      name,
      heldAt: new Date(this.now()).toISOString(),
      verdict: decision.ok ? "prompt" : "not-a-prompt",
      reason: decision.ok ? null : decision.reason,
      sequence: event.sequence,
      generation: typeof event.generation === "string" ? event.generation : null,
      origin: typeof event.origin === "string" ? event.origin : null,
      observedAt: Number.isSafeInteger(event.observed_at) ? event.observed_at : null,
      conversationId: typeof event.conversation_id === "string" ? event.conversation_id : null,
      message: Object.fromEntries(
        ["id", "chat_id", "from_me", "trusted_self", "sender_id", "timestamp", "type", "revision", "deleted", "attachment",
          "text_truncated", "forwarded", "quoted", "quoted_message_id", "send_request_id"].map((key) => [key, m[key] ?? null]),
      ),
      replyBy: decision.ok ? this.replyBy(decision) : null,
      prompt: decision.ok ? { eventId: decision.eventId, text: decision.text, postedAt: decision.postedAt, observedAt: decision.observedAt, sequence: decision.sequence } : null,
      invalidated: null,
    }
    writePrivate(join(this.dirs.held, `${name}.json`), record)
    this.held.set(name, record)
    this.log(`held ${name} for review: ${record.verdict}${record.reason ? ` (${record.reason})` : ""}`)
    void this.announce(record)
  }

  private locate(name: string): string | null {
    for (const dir of [this.dirs.held, this.dirs.release]) {
      const path = join(dir, `${name}.json`)
      if (existsSync(path)) return path
    }
    return null
  }

  private invalidate(matches: (record: HeldRecord) => boolean, reason: string): void {
    for (const record of this.held.values()) {
      if (record.invalidated || !matches(record)) continue
      record.invalidated = { at: new Date(this.now()).toISOString(), reason }
      const path = this.locate(record.name)
      if (path) writePrivate(path, record)
      this.log(`${record.name} can no longer be answered: ${reason}`)
    }
  }

  private async announce(record: HeldRecord): Promise<void> {
    if (!this.options.notify) return
    const lines = [
      "[ai-bridge-relay notice: automated, sent by the ai-bridge relay process; not typed by the owner, and not a chat message]",
      `WhatsApp AI group: an own message is HELD for review, journal sequence ${record.sequence}: ${join(this.dirs.held, `${record.name}.json`)} (0600). The relay prompted no session and sent nothing.`,
      `Relay gate verdict: ${record.verdict === "prompt" ? "prompt" : `not a prompt (${record.reason})`}.` +
        (record.replyBy ? ` A reply is possible until ${new Date(record.replyBy).toISOString()}.` : ""),
    ]
    if (record.verdict === "prompt" && this.options.releaseCommand) lines.push(`Release after verification: ${this.options.releaseCommand} ${record.name}`)
    const text = lines.join("\n")
    for (const session of this.options.notifySessions ?? []) void this.notice(session, `ai-bridge-relay:held:${record.name}:${session}`, text)
    if (record.verdict === "prompt" && this.options.coordinatorSession) {
      void this.notice(this.options.coordinatorSession, `ai-bridge-relay:wake:${record.name}`, [
        "[ai-bridge-relay notice: automated, sent by the ai-bridge relay process; not typed by the owner, and not a chat message]",
        "A WhatsApp message for this route is held for operator review. If it is released, it arrives here within minutes as a [chat_relay] prompt with a reply_by deadline.",
        "Nothing to do now: reply exactly NO_REPLY.",
      ].join("\n"))
    }
  }

  /** The same key every time, so vibeterm-api delivers it once however often it is tried. */
  private async notice(session: string, key: string, text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3 && !this.stopped; attempt++) {
      try {
        const outcome = await this.options.notify!(session, key, text)
        this.log(`notice ${key.split(":").slice(1, 3).join(" ")} to ${session}: ${outcome.kind}`)
        if (outcome.kind !== "retry" && outcome.kind !== "uncertain") return
      } catch (error) {
        this.log(`notice to ${session} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await Bun.sleep(20_000)
    }
  }

  private releaseRefusal(record: HeldRecord): string | null {
    if (record.verdict !== "prompt" || !record.prompt || record.replyBy === null) return "the relay's verdict was not a prompt"
    const current = this.held.get(record.name)
    if (!current) return "not held by this relay"
    if (current.invalidated) return `it can no longer be answered: ${current.invalidated.reason}`
    if (current.generation !== this.state!.generation) return "it was observed in an earlier generation"
    if (current.sequence <= this.state!.discontinuity) return "a journal discontinuity followed it"
    const left = current.replyBy! - this.now()
    if (left < (this.options.minReleaseWindowMs ?? 90_000)) return `${Math.max(0, Math.round(left / 1000))}s left before the reply deadline; a new owner message is needed`
    return null
  }

  async processReleases(): Promise<void> {
    for (const file of readdirSync(this.dirs.release).filter((f) => /^s\d+\.json$/.test(f))) {
      const name = file.slice(0, -".json".length)
      const path = join(this.dirs.release, file)
      let record: HeldRecord | null = null
      let outcome: string
      try {
        record = readPrivate<HeldRecord>(path)
        const refusal = record.name === name ? this.releaseRefusal(record) : "the record names another message"
        if (refusal) {
          outcome = `refused: ${refusal}`
        } else {
          const current = this.held.get(name)!
          const result = await this.handOver(current.prompt!, name, current.replyBy!)
          outcome = `${result.state}${result.relayId ? ` ${result.relayId}` : ""}${result.reason ? `: ${result.reason}` : ""}`
        }
      } catch (error) {
        outcome = `refused: unreadable (${error instanceof Error ? error.message : String(error)})`
      }
      const done: HeldRecord | { name: string } = this.held.get(name) ?? record ?? { name }
      writePrivate(join(this.dirs.done, file), { ...done, released: { at: new Date(this.now()).toISOString(), outcome } })
      rmSync(path, { force: true })
      this.held.delete(name)
      this.log(`release of ${name}: ${outcome}`)
    }
    for (const name of [...this.held.keys()]) if (!this.locate(name)) this.held.delete(name)
  }

  // ---------------------------------------------------------------------------
  // Replies
  // ---------------------------------------------------------------------------

  private async outboxLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const batch = await this.options.relay.takeOutbox("whatsapp", 8_000)
        for (const item of batch.items) {
          if (this.stopped) return
          await this.deliver(item)
        }
      } catch (error) {
        this.log(`outbox unavailable: ${error instanceof Error ? error.message : String(error)}`)
        await Bun.sleep(5_000)
      }
    }
  }

  private settle(item: OutboxItem, frozen: FrozenReply, outcome: ReplyOutcome): void {
    const relay = this.options.relay
    switch (outcome.kind) {
      case "sent":
        relay.ack({ outboxId: item.outboxId, chatEventId: outcome.messageId })
        this.log(`replied for ${item.outboxId} (${outcome.state})`)
        return
      case "unknown":
        relay.markUncertain(item.outboxId, outcome.error)
        this.log(`reply for ${item.outboxId} may have been sent (${outcome.error}); never attempted again`)
        return
      case "refused":
        relay.nack({ outboxId: item.outboxId, error: outcome.error, definite: true })
        this.log(`reply for ${item.outboxId} refused: ${outcome.error}`)
        return
      default:
        relay.nack({ outboxId: item.outboxId, error: outcome.error, definite: false })
        this.log(`reply for ${item.outboxId} ${outcome.kind} (${outcome.error}, attempt ${frozen.attempts}); the same request goes again`)
    }
  }

  async deliver(item: OutboxItem): Promise<void> {
    const path = join(this.dirs.replies, `${item.outboxId}.json`)
    let frozen = existsSync(path) ? readPrivate<FrozenReply>(path) : null
    if (!frozen) {
      const refuse = (error: string) => {
        this.options.relay.nack({ outboxId: item.outboxId, error, definite: true })
        this.log(`reply for ${item.outboxId} not sent: ${error}`)
      }
      if (!item.replyToEventId) return refuse("no owner message to reply to")
      if (this.answeredParents.has(item.replyToEventId)) return refuse("that owner message already has its one reply")
      if (item.replyBy === undefined) return refuse("no reply deadline")
      if (!item.text.trim()) return refuse("empty reply")
      frozen = {
        version: 1,
        outboxId: item.outboxId,
        request: {
          capability_id: this.options.capabilityId,
          conversation_id: this.options.conversationId,
          parent_message_id: item.replyToEventId,
          text: fitReply(item.text, this.options.aiPrefix),
          request_id: item.outboxId,
        },
        replyBy: item.replyBy,
        frozenAt: new Date(this.now()).toISOString(),
        attempts: 0,
        unresolved: 0,
        last: null,
        outcome: null,
      }
      // Frozen before the first attempt: every later attempt replays these exact bytes.
      writePrivate(path, frozen)
      this.answeredParents.add(item.replyToEventId)
    }
    if (frozen.outcome) return this.settle(item, frozen, frozen.outcome)

    let outcome: ReplyOutcome
    if (frozen.attempts === 0 && this.now() >= frozen.replyBy) {
      outcome = { kind: "refused", error: "the reply deadline passed before the reply was ready" }
    } else {
      // Counted before the call: after a crash mid-call, the request is treated as possibly reserved.
      frozen.attempts++
      writePrivate(path, frozen)
      try {
        outcome = await this.options.sender.reply(frozen.request)
      } catch (error) {
        outcome = { kind: "unresolved", error: error instanceof Error ? error.message : String(error) }
      }
      if (outcome.kind === "unresolved") frozen.unresolved++
      if (outcome.kind === "unresolved" && frozen.unresolved >= (this.options.maxUnresolved ?? 3)) {
        outcome = { kind: "unknown", error: `unresolved after ${frozen.unresolved} replays of the same request (${outcome.error})` }
      } else if (outcome.kind === "rate_limited" && this.now() >= frozen.replyBy) {
        outcome = frozen.unresolved > 0
          ? { kind: "unknown", error: "rate limited past the deadline after an unresolved attempt" }
          : { kind: "refused", error: "rate limited until past the reply deadline" }
      }
    }
    frozen.last = outcome.kind
    if (outcome.kind === "sent" || outcome.kind === "unknown" || outcome.kind === "refused") frozen.outcome = outcome
    writePrivate(path, frozen)
    this.settle(item, frozen, outcome)
  }
}
