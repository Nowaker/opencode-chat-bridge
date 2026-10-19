/**
 * The relay's HTTP surface, on a Unix socket only.
 *
 * Reaching this socket means being able to prompt a coordinator with full
 * tools as the owner, so it is never a TCP port: it lives in a 0700 directory
 * and is itself 0600, which leaves the owning user and root. The one container
 * that talks to it gets the directory bind-mounted, nothing else.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "fs"
import { dirname } from "path"
import { MAX_WAIT_MS, type Relay } from "./relay"
import { isRelayRoute, type AckRequest, type InboundRequest, type NackRequest } from "./types"

const MAX_BODY_BYTES = 64 * 1024
const MAX_ID = 512
const MAX_TEXT = 32_000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function bad(message: string): Response {
  return json({ error: message }, 400)
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_BODY_BYTES) throw new Error("body too large")
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Error("body too large")
  return JSON.parse(text)
}

function str(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max
}

export function parseInbound(body: unknown): InboundRequest | string {
  const b = body as Record<string, unknown>
  if (!b || typeof b !== "object") return "body must be an object"
  if (!isRelayRoute(b.route)) return "unknown route"
  if (!str(b.eventId, 1, MAX_ID)) return "eventId"
  if (!str(b.roomId, 1, MAX_ID)) return "roomId"
  if (!str(b.threadRootId, 0, MAX_ID)) return "threadRootId"
  if (!str(b.sender, 1, MAX_ID)) return "sender"
  if (typeof b.postedAt !== "number" || !Number.isFinite(b.postedAt)) return "postedAt"
  if (!str(b.text, 1, MAX_TEXT) || !(b.text as string).trim()) return "text"
  if (typeof b.implicit !== "boolean") return "implicit"
  return {
    route: b.route,
    eventId: b.eventId as string,
    roomId: b.roomId as string,
    threadRootId: b.threadRootId as string,
    sender: b.sender as string,
    postedAt: b.postedAt,
    text: b.text as string,
    implicit: b.implicit,
  }
}

export async function handleRelayRequest(relay: Relay, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const route = `${request.method} ${url.pathname}`
  try {
    switch (route) {
      case "GET /v1/health":
        return json(relay.health())
      case "POST /v1/inbound": {
        const parsed = parseInbound(await readJson(request))
        if (typeof parsed === "string") return bad(`invalid inbound: ${parsed}`)
        return json(await relay.handleInbound(parsed))
      }
      case "GET /v1/outbox": {
        const name = url.searchParams.get("route")
        if (!isRelayRoute(name)) return bad("unknown route")
        const waitMs = Math.max(0, Math.min(Number(url.searchParams.get("waitMs") ?? "0") || 0, MAX_WAIT_MS))
        return json(await relay.takeOutbox(name, waitMs))
      }
      case "POST /v1/outbox/ack": {
        const body = (await readJson(request)) as AckRequest
        if (!str(body?.outboxId, 1, MAX_ID) || !str(body?.chatEventId, 1, MAX_ID)) return bad("invalid ack")
        return relay.ack(body) ? json({ ok: true }) : json({ error: "unknown outbox id" }, 404)
      }
      case "POST /v1/outbox/nack": {
        const body = (await readJson(request)) as NackRequest
        if (!str(body?.outboxId, 1, MAX_ID) || typeof body?.error !== "string" || typeof body?.definite !== "boolean") {
          return bad("invalid nack")
        }
        return relay.nack(body) ? json({ ok: true }) : json({ error: "unknown outbox id" }, 404)
      }
      default:
        return json({ error: "not found" }, 404)
    }
  } catch (error) {
    if (error instanceof SyntaxError) return bad("malformed JSON")
    if (error instanceof Error && error.message === "body too large") return json({ error: "body too large" }, 413)
    console.error(`[RELAY] ${route} failed:`, error instanceof Error ? error.message : error)
    return json({ error: "internal error" }, 500)
  }
}

export function startRelayServer(relay: Relay, socketPath: string) {
  const dir = dirname(socketPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new Error(`refusing to replace a non-socket at ${socketPath}`)
    rmSync(socketPath)
  }
  const server = Bun.serve({ unix: socketPath, fetch: (request) => handleRelayRequest(relay, request) })
  chmodSync(socketPath, 0o600)
  return server
}
