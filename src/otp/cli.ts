#!/usr/bin/env bun
/**
 * ai-bridge-otp: the OTP broker's command line (contract section 3).
 *
 * It talks to the broker over its private Unix socket (`--socket`, or
 * `AI_BRIDGE_OTP_SOCKET`) and never prints a code, body, sender or name. A
 * code goes only to a 0600 file, as `OTP_CODE=<code>`. Consume that file with
 * the browser tool's `secrets: {path, keys: ["OTP_CODE"]}`, or `source` it
 * inside one script; never cat, echo or read it.
 *
 * Exit codes: 0 done or matched, 1 error, 2 expired or timed out,
 * 3 ambiguous, 4 cancelled, 5 busy (`request`), 6 pending (`claim`).
 */

import { existsSync } from "fs"
import { dirname, join, resolve } from "path"
import {
  apiCall,
  errorMessage,
  MAX_WAIT_MS,
  parseCancelAnswer,
  parseClaimAnswer,
  parseCreateAnswer,
  parseReceiptList,
  parseRequestList,
  parseResendAnswer,
  type ApiResponse,
} from "./api"
import { ShapeError } from "./guards"
import { ensurePrivateDir, writePrivateText } from "./private-files"

export const EXIT = { ok: 0, error: 1, expired: 2, ambiguous: 3, cancelled: 4, busy: 5, pending: 6 } as const

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
}

const USAGE = `usage: ai-bridge-otp <command> ...
  request --service S --account A [--challenge C] [--window 10m] [--sender X]... [--body-pattern RE]
          [--package P]... [--code-pattern RE] [--test] [--supersede] [--session ses_...]
  resend REQUEST_ID [--session ses_...]
  wait REQUEST_ID [--timeout 10m] [--out PATH] [--session ses_...]
  claim REQUEST_ID [--out PATH] [--session ses_...]
  cancel REQUEST_ID [--session ses_...]
  status [REQUEST_ID] [--json]
  receipts [--since 1h] [--json]
Durations: 90s, 10m, 1h, 7d. Every command takes --socket PATH (default $AI_BRIDGE_OTP_SOCKET); the session defaults to $VIBETERM_SESSION_ID.`

class UsageError extends Error {}

type Env = Record<string, string | undefined>
type Flags = Map<string, string[]>

const REQUEST_ID = /^otp_[0-9a-f]{20}$/
const CODE = /^[A-Za-z0-9-]{1,64}$/

function parse(argv: string[], valued: string[], booleans: string[] = []): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    let name = arg.slice(2)
    let value: string | undefined
    const eq = name.indexOf("=")
    if (eq >= 0) {
      value = name.slice(eq + 1)
      name = name.slice(0, eq)
    }
    if (booleans.includes(name)) {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`)
      flags.set(name, ["true"])
      continue
    }
    if (!valued.includes(name) && name !== "socket") throw new UsageError(`unknown option --${name}`)
    if (value === undefined) {
      value = argv[++i]
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
    }
    flags.set(name, [...(flags.get(name) ?? []), value])
  }
  return { positional, flags }
}

function one(flags: Flags, name: string): string | undefined {
  return flags.get(name)?.at(-1)
}

const UNITS = new Map([
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
])

export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim())
  const unit = match ? UNITS.get(match[2] ?? "s") : undefined
  if (!match || unit === undefined) throw new UsageError(`${value} is not a duration such as 90s, 10m, 1h or 7d`)
  return Number(match[1]) * unit
}

function iso(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString()
}

function requestId(positional: string[]): string {
  const [id, ...extra] = positional
  if (!id || extra.length > 0) throw new UsageError("give exactly one REQUEST_ID")
  if (!REQUEST_ID.test(id)) throw new UsageError(`${id} is not a request id`)
  return id
}

function context(flags: Flags, env: Env, needSession: boolean): { socket: string; session: string } {
  const socket = one(flags, "socket") ?? env.AI_BRIDGE_OTP_SOCKET
  if (!socket) throw new UsageError("no socket: pass --socket or set AI_BRIDGE_OTP_SOCKET")
  const session = one(flags, "session") ?? env.VIBETERM_SESSION_ID ?? ""
  if (needSession && !session) throw new UsageError("no session: pass --session or set VIBETERM_SESSION_ID")
  return { socket, session }
}

async function call(socket: string, method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResponse> {
  try {
    return await apiCall(socket, method, path, body)
  } catch (error) {
    throw new Error(`broker unreachable at ${socket}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function failure(response: ApiResponse, io: CliIo): number {
  io.err(`ai-bridge-otp: ${errorMessage(response)}`)
  return EXIT.error
}

/** The answer read by `read`, or null when the broker sent something else. */
function parsed<T>(read: (value: unknown) => T, body: unknown): T | null {
  try {
    return read(body)
  } catch (error) {
    if (error instanceof ShapeError) return null
    throw error
  }
}

function unexpected(io: CliIo): number {
  io.err("ai-bridge-otp: unexpected answer from the broker")
  return EXIT.error
}

/** Where the code goes, settled before claiming so a bad path never consumes a code. */
function outPath(flag: string | undefined, env: Env, id: string): string {
  if (flag !== undefined) {
    const path = resolve(flag)
    if (!existsSync(dirname(path))) throw new UsageError(`${dirname(path)} does not exist`)
    return path
  }
  if (!env.XDG_RUNTIME_DIR) throw new UsageError("XDG_RUNTIME_DIR is not set: pass --out PATH")
  const dir = join(env.XDG_RUNTIME_DIR, "ai-bridge-otp")
  ensurePrivateDir(dir)
  return join(dir, `${id}.env`)
}

/** A claim's answer as an exit code, or null while it is still pending. */
function settle(response: ApiResponse, out: string, io: CliIo): number | null {
  if (response.status !== 200) return failure(response, io)
  const answer = parsed(parseClaimAnswer, response.body)
  if (answer === null) return unexpected(io)
  switch (answer.status) {
    case "matched":
      if (!CODE.test(answer.code)) {
        io.err("ai-bridge-otp: the broker answered with an unusable code")
        return EXIT.error
      }
      writePrivateText(out, `OTP_CODE=${answer.code}\n`)
      io.out(`matched ${out}`)
      return EXIT.ok
    case "ambiguous":
      io.out("ambiguous")
      return EXIT.ambiguous
    case "expired":
      io.out("expired")
      return EXIT.expired
    case "cancelled":
      io.out("cancelled")
      return EXIT.cancelled
    case "pending":
      return null
  }
}

async function request(argv: string[], env: Env, io: CliIo): Promise<number> {
  const { positional, flags } = parse(
    argv,
    ["service", "account", "challenge", "window", "sender", "body-pattern", "package", "code-pattern", "session"],
    ["test", "supersede"],
  )
  if (positional.length > 0) throw new UsageError(`unexpected argument ${positional[0]}`)
  const ctx = context(flags, env, true)
  const service = one(flags, "service")
  const account = one(flags, "account")
  if (!service || !account) throw new UsageError("request needs --service and --account")
  const window = one(flags, "window")
  const response = await call(ctx.socket, "POST", "/v1/requests", {
    session: ctx.session,
    service,
    account,
    challenge: one(flags, "challenge"),
    windowMs: window === undefined ? undefined : parseDuration(window),
    senders: flags.get("sender"),
    bodyPattern: one(flags, "body-pattern"),
    packages: flags.get("package"),
    codePattern: one(flags, "code-pattern"),
    test: flags.has("test"),
    supersede: flags.has("supersede"),
  })
  const answer = parsed(parseCreateAnswer, response.body)
  if (response.status === 200 && answer?.status === "created") {
    io.out(`request_id=${answer.requestId}`)
    io.out(`expires_at=${iso(answer.expiresAt)}`)
    for (const id of answer.superseded) io.err(`superseded ${id}`)
    return EXIT.ok
  }
  if (response.status === 409 && answer?.status === "busy") {
    for (const holder of answer.holders) {
      io.out(`busy holder=${holder.requestId} session=${holder.session} expires_at=${iso(holder.expiresAt)}`)
    }
    return EXIT.busy
  }
  return failure(response, io)
}

async function resend(argv: string[], env: Env, io: CliIo): Promise<number> {
  const { positional, flags } = parse(argv, ["session"])
  const id = requestId(positional)
  const ctx = context(flags, env, true)
  const response = await call(ctx.socket, "POST", `/v1/requests/${id}/resend`, { session: ctx.session })
  if (response.status !== 200) return failure(response, io)
  const answer = parsed(parseResendAnswer, response.body)
  if (answer === null) return unexpected(io)
  io.out(`not_before=${iso(answer.notBefore)}`)
  return EXIT.ok
}

async function wait(argv: string[], env: Env, io: CliIo): Promise<number> {
  const { positional, flags } = parse(argv, ["timeout", "out", "session"])
  const id = requestId(positional)
  const ctx = context(flags, env, true)
  const deadline = Date.now() + parseDuration(one(flags, "timeout") ?? "10m")
  const out = outPath(one(flags, "out"), env, id)
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now())
    let response: ApiResponse
    try {
      response = await apiCall(ctx.socket, "POST", `/v1/requests/${id}/claim`, { session: ctx.session, waitMs: Math.min(remaining, MAX_WAIT_MS) }, MAX_WAIT_MS + 15_000)
    } catch {
      // A broker restarting between store and claim is waited out, up to the timeout.
      if (Date.now() >= deadline) {
        io.err(`ai-bridge-otp: broker unreachable at ${ctx.socket}`)
        return EXIT.error
      }
      await Bun.sleep(Math.min(1_000, Math.max(1, deadline - Date.now())))
      continue
    }
    const exit = settle(response, out, io)
    if (exit !== null) return exit
    if (Date.now() >= deadline) {
      io.out("timed out")
      return EXIT.expired
    }
  }
}

async function claim(argv: string[], env: Env, io: CliIo): Promise<number> {
  const { positional, flags } = parse(argv, ["out", "session"])
  const id = requestId(positional)
  const ctx = context(flags, env, true)
  const out = outPath(one(flags, "out"), env, id)
  const response = await call(ctx.socket, "POST", `/v1/requests/${id}/claim`, { session: ctx.session, waitMs: 0 })
  const exit = settle(response, out, io)
  if (exit !== null) return exit
  io.out("pending")
  return EXIT.pending
}

async function cancel(argv: string[], env: Env, io: CliIo): Promise<number> {
  const { positional, flags } = parse(argv, ["session"])
  const id = requestId(positional)
  const ctx = context(flags, env, true)
  const response = await call(ctx.socket, "POST", `/v1/requests/${id}/cancel`, { session: ctx.session })
  if (response.status !== 200) return failure(response, io)
  const answer = parsed(parseCancelAnswer, response.body)
  if (answer === null) return unexpected(io)
  io.out(answer.rejected ? `rejected ${id}` : `${answer.state} ${id}`)
  return EXIT.ok
}

async function status(argv: string[], env: Env, io: CliIo): Promise<number> {
  const { positional, flags } = parse(argv, [], ["json"])
  const id = positional.length > 0 ? requestId(positional) : undefined
  const ctx = context(flags, env, false)
  const response = await call(ctx.socket, "GET", `/v1/requests${id ? `?id=${id}` : ""}`)
  if (response.status !== 200) return failure(response, io)
  const requests = parsed(parseRequestList, response.body)
  if (requests === null) return unexpected(io)
  if (id && requests.length === 0) {
    io.err(`ai-bridge-otp: no such request ${id}`)
    return EXIT.error
  }
  if (flags.has("json")) {
    io.out(JSON.stringify(requests, null, 2))
    return EXIT.ok
  }
  for (const r of requests) {
    const parts = [
      r.requestId,
      r.verdict ? `${r.state}/${r.verdict}` : r.state,
      `service=${r.service}`,
      ...(r.test ? ["test"] : []),
      `session=${r.session}`,
      `created=${iso(r.createdAt)}`,
      `not_before=${iso(r.notBefore)}`,
      `expires=${iso(r.expiresAt)}`,
      `resends=${r.resends}`,
      `matched=${r.events.matched}`,
      `ambiguous=${r.events.ambiguous}`,
      `stale=${r.events.stale}`,
    ]
    if (r.closedAt !== null) parts.push(`closed=${iso(r.closedAt)}`, `reason=${r.closeReason}`)
    if (r.rejectedAt !== null) parts.push(`rejected=${iso(r.rejectedAt)}`)
    io.out(parts.join(" "))
  }
  return EXIT.ok
}

async function receipts(argv: string[], env: Env, io: CliIo): Promise<number> {
  const { positional, flags } = parse(argv, ["since"], ["json"])
  if (positional.length > 0) throw new UsageError(`unexpected argument ${positional[0]}`)
  const ctx = context(flags, env, false)
  const within = parseDuration(one(flags, "since") ?? "1h")
  const response = await call(ctx.socket, "GET", `/v1/receipts?withinMs=${within}`)
  if (response.status !== 200) return failure(response, io)
  const list = parsed(parseReceiptList, response.body)
  if (list === null) return unexpected(io)
  if (flags.has("json")) {
    io.out(JSON.stringify(list, null, 2))
    return EXIT.ok
  }
  for (const r of list) {
    const requests = r.requests.map((q) => `${q.requestId}:${q.role}:not_before=${iso(q.notBefore)}`).join(",") || "-"
    io.out(
      [
        r.receiptId,
        `delivery=${r.deliveryId}`,
        r.reason ? `${r.state}(${r.reason})` : r.state,
        `stored=${iso(r.arrivalMs)}`,
        `ts_ms=${r.tsMs}`,
        `captured_at_ms=${r.capturedAtMs}`,
        `capture_desktop=${iso(r.captureDesktopMs)}`,
        `age_ms=${r.ageMs}(${r.ageSource})`,
        `duplicates=${r.duplicates}`,
        `kind=${r.kind}`,
        ...(r.timeBasis ? [`time_basis=${r.timeBasis}`] : []),
        ...(r.test ? ["test"] : []),
        `requests=${requests}`,
      ].join(" "),
    )
  }
  return EXIT.ok
}

const COMMANDS: Record<string, (argv: string[], env: Env, io: CliIo) => Promise<number>> = {
  request,
  resend,
  wait,
  claim,
  cancel,
  status,
  receipts,
}

export async function runCli(argv: string[], env: Env = process.env, io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE)
    return command === undefined ? EXIT.error : EXIT.ok
  }
  const run = COMMANDS[command]
  try {
    if (!run) throw new UsageError(`unknown command ${command}`)
    return await run(rest, env, io)
  } catch (error) {
    io.err(`ai-bridge-otp: ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof UsageError) io.err(USAGE)
    return EXIT.error
  }
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)))
