/**
 * The OTP broker: login requests from sessions, signed events from the phone,
 * and the rule that hands a code to exactly one requester or to none
 * (contract section 2).
 *
 * An event is decided once, when it arrives. Its capture time on the desktop
 * clock is never later than its arrival, and a request's window starts at its
 * registration, so only requests already open at arrival can ever take it, and
 * later changes only narrow a window (a resend, a close). Its content (sender,
 * name, body, label, package) is therefore read once and never written down:
 * per delivery the database keeps ids, the content hash, the times and the
 * decision, and for a matched event the code, deleted an hour after its
 * request is claimed or closed.
 */

import type { Database } from "bun:sqlite"
import { randomBytes } from "crypto"
import { captureTime, contentHash, type CaptureTime, type WebhookEvent } from "./event"
import { nullable, record, strings, text } from "./guards"
import { checkPattern, DEFAULT_CODE_PATTERN, extractCode, hasHints, hintFailures, leaseKeys, normalizeSender, type Hints } from "./match"

export const DEFAULT_WINDOW_MS = 10 * 60_000
export const MIN_WINDOW_MS = 10_000
export const MAX_WINDOW_MS = 30 * 60_000
export const CODE_RETENTION_MS = 60 * 60_000
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000

export const REQUEST_STATES = ["open", "claimed", "expired", "cancelled"] as const
export const EVENT_STATES = ["matched", "claimed", "ambiguous", "stale", "unmatched"] as const
export const VERDICTS = ["pending", "matched", "ambiguous"] as const
export const CLAIM_STATUSES = ["matched", "pending", "ambiguous", "expired", "cancelled"] as const

export type RequestState = (typeof REQUEST_STATES)[number]
export type EventState = (typeof EVENT_STATES)[number]

export interface Profile {
  senders?: string[]
  bodyPattern?: string
  packages?: string[]
  codePattern?: string
}

export interface RequestInput {
  session: string
  service: string
  account: string
  challenge?: string | null
  windowMs?: number
  senders?: string[]
  bodyPattern?: string
  packages?: string[]
  codePattern?: string
  test?: boolean
  supersede?: boolean
}

export interface Holder {
  requestId: string
  session: string
  expiresAt: number
}

export type CreateOutcome =
  | { status: "created"; requestId: string; expiresAt: number; superseded: string[] }
  | { status: "busy"; holders: Holder[] }

export type ClaimOutcome =
  | { status: "matched"; code: string; receiptId: string }
  | { status: Exclude<(typeof CLAIM_STATUSES)[number], "matched"> }

type Verdict = Extract<ClaimOutcome, { status: "matched" }> | { status: Exclude<(typeof VERDICTS)[number], "matched"> }

export type IngestOutcome =
  | { status: "stored"; receiptId: string; state: EventState }
  | { status: "duplicate"; receiptId: string }
  | { status: "conflict" }

export interface RequestStatus {
  requestId: string
  session: string
  service: string
  test: boolean
  state: RequestState
  /** For an open request: what a claim would answer now. */
  verdict: (typeof VERDICTS)[number] | null
  createdAt: number
  notBefore: number
  expiresAt: number
  resends: number
  closedAt: number | null
  closeReason: string | null
  rejectedAt: number | null
  events: { matched: number; ambiguous: number; stale: number }
}

export interface Receipt {
  receiptId: string
  deliveryId: string
  arrivalMs: number
  tsMs: number
  capturedAtMs: number
  ageMs: number
  ageSource: string
  captureDesktopMs: number
  kind: string
  timeBasis: string | null
  test: boolean
  state: EventState
  reason: string | null
  duplicates: number
  lastDuplicateMs: number | null
  requests: { requestId: string; role: string; notBefore: number }[]
}

export class BrokerError extends Error {
  constructor(message: string, readonly kind: "invalid" | "not_found" | "forbidden" | "closed") {
    super(message)
    this.name = "BrokerError"
  }
}

interface RequestRow {
  request_id: string
  session_id: string
  service: string
  account: string
  test: number
  hints: string | null
  lease_keys: string
  created_at: number
  not_before: number
  expires_at: number
  resends: number
  state: RequestState
  closed_at: number | null
  close_reason: string | null
  claimed_receipt: string | null
  rejected_at: number | null
}

interface ReceiptRow {
  receipt_id: string
  delivery_id: string
  arrival_ms: number
  ts_ms: number
  captured_at_ms: number
  age_ms: number
  age_source: string
  capture_desktop_ms: number
  kind: string
  time_basis: string | null
  test: number
  state: EventState
  reason: string | null
  duplicates: number
  last_duplicate_ms: number | null
}

interface Decision {
  state: EventState
  reason: string | null
  requestId: string | null
  code: string | null
  links: { requestId: string; role: "eligible" | "stale"; notBefore: number }[]
}

const SESSION = /^ses_[A-Za-z0-9]{1,64}$/
const SERVICE = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const PACKAGE = /^[A-Za-z0-9_.]{1,200}$/
const CONTROL = /[\u0000-\u001f\u007f]/

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`
}

function label(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === "") return null
  if (value.length > 200 || CONTROL.test(value)) throw new BrokerError(`${field} is not a valid label`, "invalid")
  return value
}

function stringList(value: string[] | undefined, field: string, check: (item: string) => boolean): string[] | undefined {
  if (value === undefined) return undefined
  if (value.length > 20 || !value.every(check)) throw new BrokerError(`${field} must be a list of valid values`, "invalid")
  return [...new Set(value)]
}

function pattern(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  if (value.length === 0 || value.length > 500) throw new BrokerError(`${field} is not a pattern`, "invalid")
  try {
    checkPattern(value, field)
  } catch (error) {
    throw new BrokerError(error instanceof Error ? error.message : String(error), "invalid")
  }
  return value
}

/** JSON this broker wrote into a request row. One that does not parse is its own fault, never the caller's: a 500. */
function stored<T>(what: string, read: () => T): T {
  try {
    return read()
  } catch (error) {
    throw new Error(`stored ${what} do not parse: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function storedHints(row: RequestRow): Hints {
  return stored(`hints of ${row.request_id}`, () => {
    const hints = record(JSON.parse(row.hints ?? "null"), "hints")
    return {
      senders: strings(hints.senders, "hints.senders"),
      bodyPattern: nullable(hints.bodyPattern, text, "hints.bodyPattern"),
      packages: strings(hints.packages, "hints.packages"),
      codePattern: text(hints.codePattern, "hints.codePattern"),
    }
  })
}

function storedLeaseKeys(row: { request_id: string; lease_keys: string }): string[] {
  return stored(`lease keys of ${row.request_id}`, () => strings(JSON.parse(row.lease_keys), "lease_keys"))
}

export class Broker {
  private readonly now: () => number
  private readonly profiles: () => Record<string, Profile>
  private readonly waiters = new Set<() => void>()
  private stopped = false

  constructor(
    readonly db: Database,
    options: { now?: () => number; profiles?: () => Record<string, Profile> } = {},
  ) {
    this.now = options.now ?? Date.now
    this.profiles = options.profiles ?? (() => ({}))
  }

  // ---------------------------------------------------------------------------
  // Events from the phone
  // ---------------------------------------------------------------------------

  /**
   * Store one verified delivery. A repeat of a stored `delivery_id` with the
   * same immutable content is a duplicate and changes nothing but its counter:
   * the first stored attempt's receipt, capture time and decision stand.
   */
  ingest(event: WebhookEvent, arrivalMs = this.now()): IngestOutcome {
    const hash = contentHash(event)
    const outcome = this.db.transaction((): IngestOutcome => {
      const existing = this.db
        .query<{ receipt_id: string; content_hash: string }, [string]>("SELECT receipt_id, content_hash FROM events WHERE delivery_id = ?")
        .get(event.deliveryId)
      if (existing) {
        if (existing.content_hash !== hash) return { status: "conflict" }
        this.db.run("UPDATE events SET duplicates = duplicates + 1, last_duplicate_ms = ? WHERE receipt_id = ?", [arrivalMs, existing.receipt_id])
        return { status: "duplicate", receiptId: existing.receipt_id }
      }
      this.expireDue(arrivalMs)
      const time = captureTime(event, arrivalMs)
      const decision = this.decide(event, time)
      const receiptId = newId("rct")
      this.db.run(
        `INSERT INTO events (receipt_id, delivery_id, content_hash, arrival_ms, ts_ms, captured_at_ms, age_ms, age_source,
           capture_desktop_ms, kind, time_basis, test, state, reason, request_id, code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receiptId, event.deliveryId, hash, arrivalMs, event.tsMs, event.capturedAtMs, time.ageMs, time.ageSource,
          time.captureDesktopMs, event.kind, event.timeBasis, event.test ? 1 : 0, decision.state, decision.reason, decision.requestId, decision.code,
        ],
      )
      for (const link of decision.links) {
        this.db.run("INSERT INTO links (receipt_id, request_id, role, not_before) VALUES (?, ?, ?, ?)", [receiptId, link.requestId, link.role, link.notBefore])
      }
      return { status: "stored", receiptId, state: decision.state }
    })()
    if (outcome.status === "stored") this.notify()
    return outcome
  }

  /** Eligibility (section 2) against the requests open at arrival. */
  private decide(event: WebhookEvent, time: CaptureTime): Decision {
    const none = { requestId: null, code: null, links: [] }
    if (time.clockAnomaly) return { state: "unmatched", reason: "clock_anomaly", ...none }
    const open = this.db
      .query<RequestRow, [number]>("SELECT * FROM requests WHERE state = 'open' AND test = ? ORDER BY created_at")
      .all(event.test ? 1 : 0)
    if (open.length === 0) return { state: "unmatched", reason: "no_request", ...none }

    let closest: string[] | null = null
    let noCode = false
    const eligible: { row: RequestRow; code: string }[] = []
    const stale: RequestRow[] = []
    for (const row of open) {
      const hints = storedHints(row)
      const failures = hintFailures(hints, event)
      if (failures.length > 0) {
        if (closest === null || failures.length < closest.length) closest = failures
        continue
      }
      if (time.captureDesktopMs < row.not_before) {
        stale.push(row)
        continue
      }
      if (time.captureDesktopMs > row.expires_at) continue
      const code = extractCode(hints.codePattern, event.body)
      if (code === null) {
        noCode = true
        continue
      }
      eligible.push({ row, code })
    }

    if (eligible.length >= 2) {
      // Goes to none: nothing tells two open requests apart, so nothing is guessed.
      return {
        state: "ambiguous",
        reason: null,
        requestId: null,
        code: null,
        links: eligible.map(({ row }) => ({ requestId: row.request_id, role: "eligible" as const, notBefore: row.not_before })),
      }
    }
    if (eligible.length === 1) {
      const [{ row, code }] = eligible
      return {
        state: "matched",
        reason: null,
        requestId: row.request_id,
        code,
        links: [{ requestId: row.request_id, role: "eligible", notBefore: row.not_before }],
      }
    }
    if (stale.length > 0) {
      const first = stale[0]
      return {
        state: "stale",
        reason: first.resends > 0 && time.captureDesktopMs >= first.created_at ? "before_resend" : "before_registration",
        requestId: stale.length === 1 ? first.request_id : null,
        code: null,
        links: stale.map((row) => ({ requestId: row.request_id, role: "stale" as const, notBefore: row.not_before })),
      }
    }
    if (noCode) return { state: "unmatched", reason: "no_code", ...none }
    return { state: "unmatched", reason: `hints:${(closest ?? []).join(",")}`, ...none }
  }

  // ---------------------------------------------------------------------------
  // Requests from sessions
  // ---------------------------------------------------------------------------

  createRequest(input: RequestInput): CreateOutcome {
    const now = this.now()
    if (!SESSION.test(input.session)) throw new BrokerError("session is not a session id", "invalid")
    if (!SERVICE.test(input.service)) throw new BrokerError("service must match [a-z0-9][a-z0-9_.-]*", "invalid")
    const account = label(input.account, "account")
    if (account === null) throw new BrokerError("account is required", "invalid")
    const challenge = label(input.challenge, "challenge")
    const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS
    if (!Number.isSafeInteger(windowMs) || windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) {
      throw new BrokerError(`window must be between ${MIN_WINDOW_MS / 1000}s and ${MAX_WINDOW_MS / 60_000}m`, "invalid")
    }
    const senders = stringList(input.senders, "senders", (s) => s.length > 0 && s.length <= 100)
    const packages = stringList(input.packages, "packages", (p) => PACKAGE.test(p))
    const bodyPattern = pattern(input.bodyPattern, "body pattern")
    const codePattern = pattern(input.codePattern, "code pattern")
    const test = input.test === true

    // A flag replaces the profile's value for that hint; the rest comes from the profile.
    const profile = this.profiles()[input.service] ?? {}
    const hints: Hints = {
      senders: [...new Set((senders ?? profile.senders ?? []).map(normalizeSender).filter(Boolean))],
      bodyPattern: bodyPattern ?? profile.bodyPattern ?? null,
      packages: packages ?? profile.packages ?? [],
      codePattern: codePattern ?? profile.codePattern ?? DEFAULT_CODE_PATTERN,
    }
    if (!hasHints(hints)) {
      throw new BrokerError(`service ${input.service} has no profile: give --sender, --body-pattern or --package`, "invalid")
    }
    const keys = leaseKeys({ service: input.service, account, test, hints })

    const outcome = this.db.transaction((): CreateOutcome => {
      this.expireDue(now)
      const open = this.db
        .query<{ request_id: string; session_id: string; expires_at: number; lease_keys: string }, []>(
          "SELECT request_id, session_id, expires_at, lease_keys FROM requests WHERE state = 'open' ORDER BY created_at",
        )
        .all()
      const conflicts = open.filter((row) => storedLeaseKeys(row).some((key) => keys.includes(key)))
      const foreign = conflicts.filter((row) => row.session_id !== input.session)
      if (conflicts.length > 0 && (!input.supersede || foreign.length > 0)) {
        const blocking = input.supersede ? foreign : conflicts
        return {
          status: "busy",
          holders: blocking.map((row) => ({ requestId: row.request_id, session: row.session_id, expiresAt: row.expires_at })),
        }
      }
      for (const row of conflicts) this.close(row.request_id, now, "cancelled", "superseded")
      const requestId = newId("otp")
      this.db.run(
        `INSERT INTO requests (request_id, session_id, service, account, challenge, test, hints, lease_keys, created_at, not_before, expires_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        [requestId, input.session, input.service, account, challenge, test ? 1 : 0, JSON.stringify(hints), JSON.stringify(keys), now, now, now + windowMs],
      )
      return { status: "created", requestId, expiresAt: now + windowMs, superseded: conflicts.map((row) => row.request_id) }
    })()
    if (outcome.status === "created" && outcome.superseded.length > 0) this.notify()
    return outcome
  }

  /** The requester asked the service for a new code: codes captured before now no longer count. */
  resend(requestId: string, session: string): { notBefore: number } {
    const now = this.now()
    const result = this.db.transaction(() => {
      this.expireDue(now)
      const row = this.ownRequest(requestId, session)
      if (row.state !== "open") throw new BrokerError(`request is ${row.state}`, "closed")
      this.db.run("UPDATE requests SET not_before = ?, resends = resends + 1 WHERE request_id = ?", [now, requestId])
      const before = this.db
        .query<{ receipt_id: string }, [string, number]>(
          "SELECT receipt_id FROM events WHERE request_id = ? AND state = 'matched' AND capture_desktop_ms < ?",
        )
        .all(requestId, now)
      for (const { receipt_id } of before) {
        this.db.run("UPDATE events SET state = 'stale', reason = 'before_resend', code = NULL WHERE receipt_id = ?", [receipt_id])
        this.db.run("UPDATE links SET role = 'stale', not_before = ? WHERE receipt_id = ? AND request_id = ?", [now, receipt_id, requestId])
      }
      return { notBefore: now }
    })()
    this.notify()
    return result
  }

  /**
   * Close an open request. After a claim this is how a requester reports that
   * the provider rejected the code: it is recorded and the code deleted.
   */
  cancel(requestId: string, session: string): { state: RequestState; rejected: boolean } {
    const now = this.now()
    const result = this.db.transaction(() => {
      this.expireDue(now)
      const row = this.ownRequest(requestId, session)
      if (row.state === "open") {
        this.close(requestId, now, "cancelled", "cancelled")
        return { state: "cancelled" as const, rejected: false }
      }
      if (row.state === "claimed") {
        if (row.rejected_at === null) this.db.run("UPDATE requests SET rejected_at = ? WHERE request_id = ?", [now, requestId])
        this.db.run("UPDATE events SET code = NULL WHERE request_id = ? AND code IS NOT NULL", [requestId])
        return { state: row.state, rejected: true }
      }
      return { state: row.state, rejected: false }
    })()
    this.notify()
    return result
  }

  /**
   * Hand the request its code (v1.3.3). Events carrying the same code are one
   * code; two distinct codes since the latest resend, or any candidate that was
   * ambiguous between requests, make the request ambiguous.
   */
  claim(requestId: string, session: string): ClaimOutcome {
    const now = this.now()
    const outcome = this.db.transaction((): ClaimOutcome => {
      this.expireDue(now)
      const row = this.ownRequest(requestId, session)
      if (row.state === "claimed") {
        // The same requester reading its code again, until the code is deleted.
        if (row.rejected_at !== null) return { status: "cancelled" }
        const receiptId = row.claimed_receipt
        if (receiptId === null) return { status: "expired" }
        const event = this.db.query<{ code: string | null }, [string]>("SELECT code FROM events WHERE receipt_id = ?").get(receiptId)
        return event?.code ? { status: "matched", code: event.code, receiptId } : { status: "expired" }
      }
      if (row.state !== "open") return { status: row.state }
      const verdict = this.verdict(row)
      if (verdict.status !== "matched") return verdict
      this.db.run("UPDATE events SET state = 'claimed' WHERE request_id = ? AND state = 'matched' AND code = ?", [requestId, verdict.code])
      this.close(requestId, now, "claimed", "claimed", verdict.receiptId)
      return verdict
    })()
    if (outcome.status === "matched") this.notify()
    return outcome
  }

  /** `claim`, waiting up to `waitMs` while the answer is still `pending`. */
  async claimWait(requestId: string, session: string, waitMs: number): Promise<ClaimOutcome> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const outcome = this.claim(requestId, session)
      if (outcome.status !== "pending") return outcome
      const remaining = deadline - Date.now()
      if (remaining <= 0) return outcome
      const row = this.db.query<{ expires_at: number }, [string]>("SELECT expires_at FROM requests WHERE request_id = ?").get(requestId)
      const untilExpiry = (row?.expires_at ?? 0) - this.now() + 1
      await this.changed(Math.max(1, Math.min(remaining, untilExpiry)))
      if (this.stopped) return outcome
    }
  }

  /** Releases every waiting claim, before the database closes under it. */
  stop(): void {
    this.stopped = true
    this.notify()
  }

  private verdict(row: RequestRow): Verdict {
    const candidates = this.db
      .query<{ receipt_id: string; state: EventState; code: string | null }, [string, number]>(
        `SELECT e.receipt_id, e.state, e.code FROM links l JOIN events e ON e.receipt_id = l.receipt_id
         WHERE l.request_id = ? AND l.role = 'eligible' AND e.state IN ('matched', 'ambiguous') AND e.capture_desktop_ms >= ?
         ORDER BY e.capture_desktop_ms DESC, e.arrival_ms DESC`,
      )
      .all(row.request_id, row.not_before)
    if (candidates.some((c) => c.state === "ambiguous")) return { status: "ambiguous" }
    const codes = new Set(candidates.map((c) => c.code))
    if (codes.size === 0) return { status: "pending" }
    const newest = candidates[0]
    if (codes.size > 1 || newest.code === null) return { status: "ambiguous" }
    return { status: "matched", code: newest.code, receiptId: newest.receipt_id }
  }

  private ownRequest(requestId: string, session: string): RequestRow {
    const row = this.db.query<RequestRow, [string]>("SELECT * FROM requests WHERE request_id = ?").get(requestId)
    if (!row) throw new BrokerError("no such request", "not_found")
    if (row.session_id !== session) throw new BrokerError("the request belongs to another session", "forbidden")
    return row
  }

  /** A closed request needs neither its hints nor its leases; both hold private values. */
  private close(requestId: string, now: number, state: "claimed" | "cancelled", reason: string, claimedReceipt: string | null = null): void {
    this.db.run(
      `UPDATE requests SET state = ?, closed_at = ?, close_reason = ?, claimed_receipt = ?, hints = NULL, lease_keys = '[]'
       WHERE request_id = ? AND state = 'open'`,
      [state, now, reason, claimedReceipt, requestId],
    )
  }

  // ---------------------------------------------------------------------------
  // Time, retention and reads
  // ---------------------------------------------------------------------------

  /** An open request is open through its `expires_at`. */
  expireDue(now = this.now()): number {
    const { changes } = this.db.run(
      `UPDATE requests SET state = 'expired', closed_at = expires_at, close_reason = 'expired', hints = NULL, lease_keys = '[]'
       WHERE state = 'open' AND expires_at < ?`,
      [now],
    )
    if (changes > 0) this.notify()
    return changes
  }

  /** Section 4: codes 1 h after their request closes, deliveries and requests after 7 days. */
  purge(now = this.now()): { codes: number; events: number; requests: number } {
    const result = this.db.transaction(() => {
      this.expireDue(now)
      const codes = this.db.run(
        `UPDATE events SET code = NULL WHERE code IS NOT NULL AND (request_id IS NULL OR request_id NOT IN (
           SELECT request_id FROM requests WHERE state = 'open' OR closed_at > ?))`,
        [now - CODE_RETENTION_MS],
      ).changes
      // Links first, so the count below is deliveries only (bun:sqlite counts cascaded rows too).
      this.db.run("DELETE FROM links WHERE receipt_id IN (SELECT receipt_id FROM events WHERE arrival_ms < ?)", [now - EVENT_RETENTION_MS])
      const events = this.db.run("DELETE FROM events WHERE arrival_ms < ?", [now - EVENT_RETENTION_MS]).changes
      const requests = this.db.run("DELETE FROM requests WHERE state != 'open' AND closed_at < ?", [now - EVENT_RETENTION_MS]).changes
      this.db.run("DELETE FROM links WHERE request_id NOT IN (SELECT request_id FROM requests)")
      return { codes, events, requests }
    })()
    // Old WAL frames still hold what was just deleted until they are checkpointed away.
    this.db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    return result
  }

  status(requestId?: string): RequestStatus[] {
    const now = this.now()
    this.expireDue(now)
    const rows = requestId
      ? this.db.query<RequestRow, [string]>("SELECT * FROM requests WHERE request_id = ?").all(requestId)
      : this.db
          .query<RequestRow, [number]>("SELECT * FROM requests WHERE state = 'open' OR closed_at >= ? ORDER BY created_at DESC LIMIT 100")
          .all(now - 24 * 60 * 60_000)
    return rows.map((row) => {
      const counts = this.db
        .query<{ state: EventState; role: string; n: number }, [string]>(
          `SELECT e.state AS state, l.role AS role, COUNT(*) AS n FROM links l JOIN events e ON e.receipt_id = l.receipt_id
           WHERE l.request_id = ? GROUP BY e.state, l.role`,
        )
        .all(row.request_id)
      const count = (match: (c: { state: EventState; role: string }) => boolean) => counts.filter(match).reduce((sum, c) => sum + c.n, 0)
      const verdict = row.state === "open" ? this.verdict(row).status : null
      return {
        requestId: row.request_id,
        session: row.session_id,
        service: row.service,
        test: row.test === 1,
        state: row.state,
        verdict,
        createdAt: row.created_at,
        notBefore: row.not_before,
        expiresAt: row.expires_at,
        resends: row.resends,
        closedAt: row.closed_at,
        closeReason: row.close_reason,
        rejectedAt: row.rejected_at,
        events: {
          matched: count((c) => c.role === "eligible" && (c.state === "matched" || c.state === "claimed")),
          ambiguous: count((c) => c.state === "ambiguous"),
          stale: count((c) => c.role === "stale"),
        },
      }
    })
  }

  receiptsWithin(withinMs: number): Receipt[] {
    return this.receipts(this.now() - withinMs)
  }

  receipts(sinceMs: number): Receipt[] {
    const rows = this.db
      .query<ReceiptRow, [number]>(
        `SELECT receipt_id, delivery_id, arrival_ms, ts_ms, captured_at_ms, age_ms, age_source, capture_desktop_ms, kind, time_basis,
           test, state, reason, duplicates, last_duplicate_ms FROM events WHERE arrival_ms >= ? ORDER BY arrival_ms, receipt_id`,
      )
      .all(sinceMs)
    return rows.map((row) => ({
      receiptId: row.receipt_id,
      deliveryId: row.delivery_id,
      arrivalMs: row.arrival_ms,
      tsMs: row.ts_ms,
      capturedAtMs: row.captured_at_ms,
      ageMs: row.age_ms,
      ageSource: row.age_source,
      captureDesktopMs: row.capture_desktop_ms,
      kind: row.kind,
      timeBasis: row.time_basis,
      test: row.test === 1,
      state: row.state,
      reason: row.reason,
      duplicates: row.duplicates,
      lastDuplicateMs: row.last_duplicate_ms,
      requests: this.db
        .query<{ request_id: string; role: string; not_before: number }, [string]>(
          "SELECT request_id, role, not_before FROM links WHERE receipt_id = ? ORDER BY request_id",
        )
        .all(row.receipt_id)
        .map((link) => ({ requestId: link.request_id, role: link.role, notBefore: link.not_before })),
    }))
  }

  health(): Record<string, number> {
    const now = this.now()
    this.expireDue(now)
    const one = (sql: string, ...params: number[]) => (this.db.query<{ n: number }, number[]>(sql).get(...params)?.n ?? 0)
    return {
      openRequests: one("SELECT COUNT(*) AS n FROM requests WHERE state = 'open'"),
      eventsLastDay: one("SELECT COUNT(*) AS n FROM events WHERE arrival_ms >= ?", now - 24 * 60 * 60_000),
      heldCodes: one("SELECT COUNT(*) AS n FROM events WHERE code IS NOT NULL"),
    }
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  private notify(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiters) wake()
  }

  /** Resolves on the next change, or after `ms`. */
  changed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.waiters.add(done)
    })
  }
}
