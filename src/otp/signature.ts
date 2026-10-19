/**
 * The SMS Forward app's webhook signature, verified exactly as the app makes
 * it (`WebhookForwardSink.kt`): header `X-SmsForward-Signature: t=<ts_ms>,v1=<hex>`,
 * where `<hex>` is the lowercase HMAC-SHA256 of the raw request body, keyed
 * with the UTF-8 bytes of the shared key.
 *
 * The HMAC is computed over the bytes received, before any JSON parsing:
 * org.json escapes `/` as `\/`, so a body parsed and serialized again no
 * longer matches the signature.
 */

import { createHmac, timingSafeEqual } from "crypto"

export const SIGNATURE_HEADER = "x-smsforward-signature"
/** A signature older or newer than this is refused as stale. */
export const MAX_SIGNATURE_SKEW_MS = 300_000

export interface ParsedSignature {
  t: number
  v1: Buffer
}

export function parseSignatureHeader(value: string | null): ParsedSignature | null {
  if (!value || value.length > 512) return null
  let t: number | undefined
  let v1: Buffer | undefined
  for (const part of value.split(",")) {
    const eq = part.indexOf("=")
    if (eq <= 0) return null
    const key = part.slice(0, eq).trim()
    const field = part.slice(eq + 1).trim()
    if (key === "t") {
      if (!/^\d{1,16}$/.test(field)) return null
      t = Number(field)
    } else if (key === "v1") {
      if (!/^[0-9a-fA-F]{64}$/.test(field)) return null
      v1 = Buffer.from(field, "hex")
    }
  }
  if (t === undefined || v1 === undefined || !Number.isSafeInteger(t)) return null
  return { t, v1 }
}

function hmac(key: string, raw: Uint8Array): Buffer {
  return createHmac("sha256", Buffer.from(key, "utf8")).update(raw).digest()
}

/** Constant-time comparison of `v1` with the HMAC of the exact bytes received. */
export function signatureMatches(key: string, raw: Uint8Array, signature: ParsedSignature): boolean {
  const expected = hmac(key, raw)
  return expected.length === signature.v1.length && timingSafeEqual(expected, signature.v1)
}

/** The header value the app sends for `raw` at `tsMs`; used by tests and the proof tool. */
export function signatureHeader(key: string, raw: Uint8Array, tsMs: number): string {
  return `t=${tsMs},v1=${hmac(key, raw).toString("hex")}`
}
