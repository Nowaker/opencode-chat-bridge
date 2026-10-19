/**
 * The CLI's way in: HTTP on a 0600 Unix socket in the broker's 0700 state
 * directory, never a TCP port. Everything runs as one uid, so the socket's
 * mode is what keeps other users out; binding a claim to its requester's
 * session only routes each code to the session that asked for it.
 */

import { chmodSync, existsSync, lstatSync, rmSync } from "fs"
import { dirname } from "path"
import { BrokerError, type Broker, type RequestInput } from "./broker"
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
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new BrokerError("body too large", "invalid")
  const value: unknown = text ? JSON.parse(text) : {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BrokerError("body must be an object", "invalid")
  return value as Record<string, unknown>
}

function requestInput(body: Record<string, unknown>): RequestInput {
  return {
    session: body.session as string,
    service: body.service as string,
    account: body.account as string,
    challenge: body.challenge as string | undefined,
    windowMs: body.windowMs as number | undefined,
    senders: body.senders as string[] | undefined,
    bodyPattern: body.bodyPattern as string | undefined,
    packages: body.packages as string[] | undefined,
    codePattern: body.codePattern as string | undefined,
    test: body.test === true,
    supersede: body.supersede === true,
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
      const session = typeof body.session === "string" ? body.session : ""
      if (verb === "resend") return json(broker.resend(id, session))
      if (verb === "cancel") return json(broker.cancel(id, session))
      const waitMs = Math.max(0, Math.min(Number(body.waitMs ?? 0) || 0, MAX_WAIT_MS))
      return json(await broker.claimWait(id, session, waitMs))
    }
    return json({ error: "not found" }, 404)
  } catch (error) {
    if (error instanceof BrokerError) return json({ error: error.message, kind: error.kind }, STATUS_BY_KIND[error.kind])
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
  body: any
}

/** One call to the broker's socket; throws only when the broker was not reached. */
export async function apiCall(socketPath: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15_000): Promise<ApiResponse> {
  const response = await fetch(`http://otp${path}`, {
    method,
    unix: socketPath,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit)
  return { status: response.status, body: await response.json().catch(() => null) }
}
