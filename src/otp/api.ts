/**
 * The CLI's way in: HTTP on a 0600 Unix socket in the broker's 0700 state
 * directory, never a TCP port. Everything runs as one uid, so the socket's
 * mode is what keeps other users out; binding a claim to its requester's
 * session only routes each code to the session that asked for it.
 *
 * Both directions are parsed, never cast: a request field of the wrong type is
 * a 400 naming the field, and the CLI reads each answer through the parser for
 * its endpoint.
 */

import { chmodSync, existsSync, lstatSync, rmSync } from "fs"
import { dirname } from "path"
import {
  BrokerError,
  CLAIM_STATUSES,
  EVENT_STATES,
  REQUEST_STATES,
  VERDICTS,
  type Broker,
  type ClaimOutcome,
  type CreateOutcome,
  type Receipt,
  type RequestInput,
  type RequestState,
  type RequestStatus,
} from "./broker"
import { flag, int, isRecord, list, nullable, oneOf, optional, record, ShapeError, strings, text } from "./guards"
import { ensurePrivateDir } from "./private-files"

/**
 * Under Bun.serve()'s 10 s idle timeout on a Unix socket, which the socket form
 * of its options cannot raise (measured for the relay, `src/relay/relay.ts`).
 * The CLI waits longer by asking again.
 */
export const MAX_WAIT_MS = 8_000
const MAX_BODY_BYTES = 16 * 1024

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) throw new BrokerError("body too large", "invalid")
  const value: unknown = raw ? JSON.parse(raw) : {}
  if (!isRecord(value)) throw new BrokerError("body must be an object", "invalid")
  return value
}

function requestInput(body: Record<string, unknown>): RequestInput {
  return {
    session: text(body.session, "session"),
    service: text(body.service, "service"),
    account: text(body.account, "account"),
    challenge: optional(body.challenge, text, "challenge"),
    windowMs: optional(body.windowMs, int, "windowMs"),
    senders: optional(body.senders, strings, "senders"),
    bodyPattern: optional(body.bodyPattern, text, "bodyPattern"),
    packages: optional(body.packages, strings, "packages"),
    codePattern: optional(body.codePattern, text, "codePattern"),
    test: optional(body.test, flag, "test") ?? false,
    supersede: optional(body.supersede, flag, "supersede") ?? false,
  }
}

const STATUS_BY_KIND = { invalid: 400, forbidden: 403, not_found: 404, closed: 409 } as const

export async function handleApiRequest(broker: Broker, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const route = `${request.method} ${url.pathname}`
  try {
    if (route === "GET /v1/health") return json({ ok: true, ...broker.health() })
    if (route === "GET /v1/requests") return json({ requests: broker.status(url.searchParams.get("id") ?? undefined) })
    if (route === "GET /v1/receipts") {
      // A duration rather than a time, so it is measured on the broker's clock.
      const within = Number(url.searchParams.get("withinMs") ?? "3600000")
      return json({ receipts: broker.receiptsWithin(Number.isFinite(within) && within >= 0 ? within : 3_600_000) })
    }
    if (route === "POST /v1/requests") {
      const outcome = broker.createRequest(requestInput(await readBody(request)))
      return json(outcome, outcome.status === "busy" ? 409 : 200)
    }
    const action = /^POST \/v1\/requests\/(otp_[0-9a-f]{20})\/(resend|cancel|claim)$/.exec(route)
    if (action) {
      const [, id, verb] = action
      const body = await readBody(request)
      const session = text(body.session, "session")
      if (verb === "resend") return json(broker.resend(id, session))
      if (verb === "cancel") return json(broker.cancel(id, session))
      const waitMs = Math.max(0, Math.min(optional(body.waitMs, int, "waitMs") ?? 0, MAX_WAIT_MS))
      return json(await broker.claimWait(id, session, waitMs))
    }
    return json({ error: "not found" }, 404)
  } catch (error) {
    if (error instanceof BrokerError) return json({ error: error.message, kind: error.kind }, STATUS_BY_KIND[error.kind])
    if (error instanceof ShapeError) return json({ error: error.message, kind: "invalid" }, 400)
    if (error instanceof SyntaxError) return json({ error: "malformed JSON" }, 400)
    console.error(`[OTP] ${route} failed:`, error instanceof Error ? error.message : error)
    return json({ error: "internal error" }, 500)
  }
}

export function startApiServer(broker: Broker, socketPath: string) {
  ensurePrivateDir(dirname(socketPath))
  // The database lock already refused a second broker, so a socket here is a dead one's.
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new Error(`refusing to replace a non-socket at ${socketPath}`)
    rmSync(socketPath)
  }
  const server = Bun.serve({ unix: socketPath, fetch: (request) => handleApiRequest(broker, request) })
  chmodSync(socketPath, 0o600)
  return server
}

export interface ApiResponse {
  status: number
  body: unknown
}

/** One call to the broker's socket; throws only when the broker was not reached. */
export async function apiCall(socketPath: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15_000): Promise<ApiResponse> {
  const init: BunFetchRequestInit = {
    method,
    unix: socketPath,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  }
  const response = await fetch(`http://otp${path}`, init)
  const answer: unknown = await response.json().catch(() => null)
  return { status: response.status, body: answer }
}

/** An error answer's message, or the HTTP status when it has none. */
export function errorMessage(response: ApiResponse): string {
  const body = response.body
  return isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`
}

export function parseCreateAnswer(value: unknown): CreateOutcome {
  const answer = record(value, "answer")
  if (answer.status === "busy") {
    return {
      status: "busy",
      holders: list(answer.holders, "holders").map((item) => {
        const holder = record(item, "holders")
        return {
          requestId: text(holder.requestId, "holders.requestId"),
          session: text(holder.session, "holders.session"),
          expiresAt: int(holder.expiresAt, "holders.expiresAt"),
        }
      }),
    }
  }
  if (answer.status !== "created") throw new ShapeError("status")
  return {
    status: "created",
    requestId: text(answer.requestId, "requestId"),
    expiresAt: int(answer.expiresAt, "expiresAt"),
    superseded: strings(answer.superseded, "superseded"),
  }
}

export function parseClaimAnswer(value: unknown): ClaimOutcome {
  const answer = record(value, "answer")
  const status = oneOf(answer.status, CLAIM_STATUSES, "status")
  if (status === "matched") return { status, code: text(answer.code, "code"), receiptId: text(answer.receiptId, "receiptId") }
  return { status }
}

export function parseResendAnswer(value: unknown): { notBefore: number } {
  return { notBefore: int(record(value, "answer").notBefore, "notBefore") }
}

export function parseCancelAnswer(value: unknown): { state: RequestState; rejected: boolean } {
  const answer = record(value, "answer")
  return { state: oneOf(answer.state, REQUEST_STATES, "state"), rejected: flag(answer.rejected, "rejected") }
}

/** Fields in the broker's own order, so `status --json` prints what the broker sent. */
export function parseRequestList(value: unknown): RequestStatus[] {
  return list(record(value, "answer").requests, "requests").map((item) => {
    const request = record(item, "requests")
    const events = record(request.events, "events")
    return {
      requestId: text(request.requestId, "requestId"),
      session: text(request.session, "session"),
      service: text(request.service, "service"),
      test: flag(request.test, "test"),
      state: oneOf(request.state, REQUEST_STATES, "state"),
      verdict: nullable(request.verdict, (verdict, field) => oneOf(verdict, VERDICTS, field), "verdict"),
      createdAt: int(request.createdAt, "createdAt"),
      notBefore: int(request.notBefore, "notBefore"),
      expiresAt: int(request.expiresAt, "expiresAt"),
      resends: int(request.resends, "resends"),
      closedAt: nullable(request.closedAt, int, "closedAt"),
      closeReason: nullable(request.closeReason, text, "closeReason"),
      rejectedAt: nullable(request.rejectedAt, int, "rejectedAt"),
      events: {
        matched: int(events.matched, "events.matched"),
        ambiguous: int(events.ambiguous, "events.ambiguous"),
        stale: int(events.stale, "events.stale"),
      },
    }
  })
}

/** Fields in the broker's own order, so `receipts --json` prints what the broker sent. */
export function parseReceiptList(value: unknown): Receipt[] {
  return list(record(value, "answer").receipts, "receipts").map((item) => {
    const receipt = record(item, "receipts")
    return {
      receiptId: text(receipt.receiptId, "receiptId"),
      deliveryId: text(receipt.deliveryId, "deliveryId"),
      arrivalMs: int(receipt.arrivalMs, "arrivalMs"),
      tsMs: int(receipt.tsMs, "tsMs"),
      capturedAtMs: int(receipt.capturedAtMs, "capturedAtMs"),
      ageMs: int(receipt.ageMs, "ageMs"),
      ageSource: text(receipt.ageSource, "ageSource"),
      captureDesktopMs: int(receipt.captureDesktopMs, "captureDesktopMs"),
      kind: text(receipt.kind, "kind"),
      timeBasis: nullable(receipt.timeBasis, text, "timeBasis"),
      test: flag(receipt.test, "test"),
      state: oneOf(receipt.state, EVENT_STATES, "state"),
      reason: nullable(receipt.reason, text, "reason"),
      duplicates: int(receipt.duplicates, "duplicates"),
      lastDuplicateMs: nullable(receipt.lastDuplicateMs, int, "lastDuplicateMs"),
      requests: list(receipt.requests, "requests").map((entry) => {
        const link = record(entry, "requests")
        return {
          requestId: text(link.requestId, "requests.requestId"),
          role: text(link.role, "requests.role"),
          notBefore: int(link.notBefore, "requests.notBefore"),
        }
      }),
    }
  })
}
