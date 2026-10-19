#!/usr/bin/env bun
/**
 * Sends a synthetic, signed test event to the broker's webhook, built and
 * signed the way the SMS Forward app does it. For proofs only: each event
 * carries `"test": true`, so it can only ever match a test request.
 *
 * The key is read from its file inside this process and never printed, and
 * the request is sent from this process too: a signed header handed to a
 * command such as curl can be read from /proc while it runs, and replayed
 * for 300 s. The synthetic code is random, kept in a private state file and
 * never printed: `compare` reports only whether an OTP_CODE file holds it.
 *
 *   send-test-event.ts new --state FILE [--sender S] [--text 'X {code} Y'] [--captured-ago 0s] [--kind sms|notification]
 *   send-test-event.ts send --state FILE --url URL --key-file FILE [--phone-skew -4m] [--age phone|none] [--label L]
 *   send-test-event.ts compare --state FILE --otp-file FILE
 */

import { randomInt, randomUUID } from "crypto"
import { int, oneOf, record, text } from "./guards"
import { readPrivateText, writePrivateText } from "./private-files"
import { signatureHeader } from "./signature"

const KINDS = ["sms", "notification"] as const

interface State {
  deliveryId: string
  capturedAtMs: number
  kind: (typeof KINDS)[number]
  sender: string
  text: string
  code: string
}

function readState(path: string): State {
  const state = record(JSON.parse(readPrivateText(path)), "state")
  return {
    deliveryId: text(state.deliveryId, "deliveryId"),
    capturedAtMs: int(state.capturedAtMs, "capturedAtMs"),
    kind: oneOf(state.kind, KINDS, "kind"),
    sender: text(state.sender, "sender"),
    text: text(state.text, "text"),
    code: text(state.code, "code"),
  }
}

function options(argv: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`expected --name value pairs, got ${argv[i]}`)
    map.set(argv[i].slice(2), argv[i + 1])
  }
  return map
}

const UNITS = new Map([
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
])

function duration(value: string | undefined): number {
  const match = /^(-?)(\d+)(ms|s|m|h)?$/.exec(value ?? "0")
  const unit = match ? UNITS.get(match[3] ?? "s") : undefined
  if (!match || unit === undefined) throw new Error(`${value} is not a duration`)
  return (match[1] ? -1 : 1) * Number(match[2]) * unit
}

function required(map: Map<string, string>, name: string): string {
  const value = map.get(name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function create(map: Map<string, string>): void {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0")
  const kind = map.get("kind") === "notification" ? "notification" : "sms"
  const state: State = {
    deliveryId: randomUUID(),
    capturedAtMs: Date.now() - duration(map.get("captured-ago")),
    kind,
    sender: map.get("sender") ?? "AIBRIDGE-TEST",
    text: (map.get("text") ?? "AIBRIDGE-TEST code {code} https://example.test/otp").replace("{code}", code),
    code,
  }
  writePrivateText(required(map, "state"), JSON.stringify(state) + "\n")
  console.log(`created ${state.deliveryId} captured_at=${new Date(state.capturedAtMs).toISOString()} kind=${kind}`)
}

async function send(map: Map<string, string>): Promise<number> {
  const state = readState(required(map, "state"))
  const key = readPrivateText(required(map, "key-file")).trim()
  const url = required(map, "url")
  // The phone's clock: its own send time, and the age it would report, both on it.
  const tsMs = Date.now() + duration(map.get("phone-skew"))
  const age = map.get("age") ?? "phone"
  const body = {
    version: 1,
    ts_ms: tsMs,
    redirect_id: -1,
    event_id: 0,
    source: {
      number: state.sender,
      name: "AIBRIDGE-TEST",
      kind: state.kind,
      ...(state.kind === "notification" ? { package: "org.aibridge.test" } : {}),
      time_basis: state.kind === "sms" ? "sms_pdu" : "messaging_style",
    },
    body: state.text,
    label: map.get("label") ?? "AIBRIDGE-TEST",
    delivery_id: state.deliveryId,
    captured_at_ms: state.capturedAtMs,
    ...(age === "phone" ? { age_ms: Math.max(0, tsMs - state.capturedAtMs) } : {}),
    test: true,
  }
  // org.json writes `/` as `\/`; the signature covers exactly these bytes.
  const raw = new TextEncoder().encode(JSON.stringify(body).replace(/\//g, "\\/"))
  // A redirect is reported, never followed: following it would hand the signed header to another URL.
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-SmsForward-Signature": signatureHeader(key, raw, tsMs),
      "Idempotency-Key": state.deliveryId,
    },
    body: raw,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  }
  try {
    const response = await fetch(url, init)
    const answer = (await response.text()).trimEnd().split("\n").join(" ")
    console.log(`HTTP ${response.status} ${answer}`)
    return response.status === 200 ? 0 : 1
  } catch (error) {
    console.log(`request failed: ${error instanceof Error ? error.name : "unknown"}`)
    return 1
  }
}

function compare(map: Map<string, string>): number {
  const state = readState(required(map, "state"))
  const claimed = /^OTP_CODE=(.*)$/m.exec(readPrivateText(required(map, "otp-file")))?.[1]
  const matches = claimed === state.code
  console.log(`code matches: ${matches}`)
  return matches ? 0 : 1
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const map = options(rest)
  if (command === "new") {
    create(map)
    return 0
  }
  if (command === "send") return await send(map)
  if (command === "compare") return compare(map)
  console.error("usage: send-test-event.ts new|send|compare --state FILE ...")
  return 2
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (error) {
    console.error(`send-test-event: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
