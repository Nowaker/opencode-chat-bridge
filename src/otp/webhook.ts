/**
 * The phone's webhook: `POST /v1/events` on a loopback port, reached from the
 * tailnet only through Caddy (contract section 1). Verification runs in the
 * contract's order, and no response or log line carries the source, body,
 * label or a code.
 */

import type { Broker } from "./broker"
import { parseEvent } from "./event"
import { MAX_SIGNATURE_SKEW_MS, parseSignatureHeader, SIGNATURE_HEADER, signatureMatches } from "./signature"

export const MAX_EVENT_BYTES = 16 * 1024

function json(body: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export function webhookHandler(broker: Broker, key: string, now: () => number = Date.now, log: (line: string) => void = console.log) {
  const invalid = (field: string, status = 400) => {
    log(`[OTP] event refused: invalid ${field}`)
    return json({ status: "invalid", error: field }, status)
  }
  const refused = (status: "bad_signature" | "stale_signature") => {
    log(`[OTP] event refused: ${status}`)
    return json({ status }, 401)
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/events") return json({ status: "not_found" }, 404)

    // 1. The raw body, at most 16 KiB.
    if (Number(request.headers.get("content-length") ?? "0") > MAX_EVENT_BYTES) return invalid("body", 413)
    let raw: Uint8Array
    try {
      raw = new Uint8Array(await request.arrayBuffer())
    } catch {
      return invalid("body", 413)
    }
    if (raw.byteLength > MAX_EVENT_BYTES) return invalid("body", 413)

    // 2. The HMAC over exactly those bytes, before any parsing.
    const signature = parseSignatureHeader(request.headers.get(SIGNATURE_HEADER))
    if (!signature || !signatureMatches(key, raw, signature)) return refused("bad_signature")

    // 3. The signed `ts_ms` is the header's `t`, and fresh.
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
    } catch {
      return invalid("json")
    }
    const ts = (body as { ts_ms?: unknown } | null)?.ts_ms
    if (typeof ts !== "number" || !Number.isSafeInteger(ts)) return invalid("ts_ms")
    if (ts !== signature.t) return refused("bad_signature")
    const arrivalMs = now()
    if (Math.abs(arrivalMs - ts) > MAX_SIGNATURE_SKEW_MS) return refused("stale_signature")

    // 4. The fields, and `Idempotency-Key == delivery_id`.
    const parsed = parseEvent(body)
    if (!parsed.ok) return invalid(parsed.field)
    if (request.headers.get("idempotency-key") !== parsed.event.deliveryId) return invalid("idempotency_key")

    // 5-6. Deduplicate, decide and commit, then answer.
    try {
      const outcome = broker.ingest(parsed.event, arrivalMs)
      const event = `delivery=${parsed.event.deliveryId} kind=${parsed.event.kind} test=${parsed.event.test}`
      switch (outcome.status) {
        case "stored":
          log(`[OTP] stored ${outcome.receiptId} ${event} state=${outcome.state}`)
          return json({ status: "stored", receipt_id: outcome.receiptId }, 200)
        case "duplicate":
          log(`[OTP] duplicate ${outcome.receiptId} ${event}`)
          return json({ status: "duplicate", receipt_id: outcome.receiptId }, 200)
        case "conflict":
          log(`[OTP] conflict ${event}`)
          return json({ status: "conflict" }, 409)
      }
    } catch (error) {
      log(`[OTP] event not stored: ${error instanceof Error ? error.message : String(error)}`)
      return json({ status: "error" }, 500)
    }
  }
}

export function startWebhookServer(handler: (request: Request) => Promise<Response>, host: string, port: number) {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error(`the webhook listens on loopback only, not ${host}`)
  return Bun.serve({ hostname: host, port, maxRequestBodySize: 4 * MAX_EVENT_BYTES, fetch: handler })
}
