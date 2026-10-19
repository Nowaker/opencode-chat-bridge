import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { createHmac, randomBytes } from "crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { apiCall, parseReceiptList, startApiServer } from "../../src/otp/api"
import { Broker, type Profile, type Receipt } from "../../src/otp/broker"
import { runCli } from "../../src/otp/cli"
import { isRecord } from "../../src/otp/guards"
import { signatureHeader } from "../../src/otp/signature"
import { openStore } from "../../src/otp/store"
import { startWebhookServer, webhookHandler } from "../../src/otp/webhook"

// Every commit is fsynced (synchronous = FULL); on a loaded host that is slow.
setDefaultTimeout(30_000)

const KEY = randomBytes(32).toString("base64url")
const SESSION_A = "ses_otptestsessionA"
const SESSION_B = "ses_otptestsessionB"
const T0 = Date.UTC(2026, 9, 19, 18, 0, 0)
const SENDER_A = "AIBRIDGE-TEST-A"
const SENDER_B = "AIBRIDGE-TEST-B"
const SECOND = 1_000
const MINUTE = 60_000

const dirs: string[] = []
const harnesses: Harness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "otp-"))
  chmodSync(dir, 0o700)
  dirs.push(dir)
  return dir
}

/** The value, or a failed test naming what was missing. */
function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing`)
  return value
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** What the phone knows about one captured message, on the true clock (the desktop's). */
interface PhoneEvent {
  deliveryId?: string
  kind?: "sms" | "notification"
  sender?: string
  code?: string
  text?: string
  label?: string
  /** True capture time. */
  capturedAt: number
  /** When the phone first saw it, if later than the capture (a late SMS delivery). */
  observedAt?: number
  /** `source`: captured_at_ms is an external clock (an SMS's PDU time); `phone`: the phone's own clock. */
  basis?: "source" | "phone"
  /** The phone's clock error. */
  skew?: number
  /** `phone` sends the v1.3.1 age_ms; `none` leaves it out, as after a reboot. */
  age?: "phone" | "none"
  test?: boolean
  package?: string
}

/** The body the SMS Forward app sends. */
interface EventBody {
  version: number
  ts_ms: number
  redirect_id: number
  event_id: number
  source: { number: string; name: string; kind: "sms" | "notification"; package?: string }
  body: string
  label: string
  delivery_id: string
  captured_at_ms: number
  age_ms?: number
  test: boolean
}

function body(event: PhoneEvent, desktopNow: number): EventBody {
  const skew = event.skew ?? 0
  const kind = event.kind ?? "sms"
  const basis = event.basis ?? (kind === "sms" ? "source" : "phone")
  const capturedAtMs = basis === "source" ? event.capturedAt : event.capturedAt + skew
  const observedAt = event.observedAt ?? Math.min(event.capturedAt, desktopNow)
  // v1.3.1: wall-clock age at the phone's first observation, plus monotonic time since.
  const ageMs = Math.max(0, observedAt + skew - capturedAtMs) + (desktopNow - observedAt)
  return {
    version: 1,
    ts_ms: desktopNow + skew,
    redirect_id: 7,
    event_id: 42,
    source: {
      number: event.sender ?? SENDER_A,
      name: "Synthetic Contact",
      kind,
      ...(kind === "notification" ? { package: event.package ?? "org.aibridge.test" } : {}),
    },
    body: event.text ?? `AIBRIDGE-TEST code ${event.code ?? "482913"} https://example.test/otp`,
    label: event.label ?? "AIBRIDGE-TEST",
    delivery_id: event.deliveryId ?? crypto.randomUUID(),
    captured_at_ms: capturedAtMs,
    ...((event.age ?? "phone") === "phone" ? { age_ms: ageMs } : {}),
    test: event.test ?? true,
  }
}

/** org.json writes `/` as `\/`, which a JSON.stringify of the parsed body would not reproduce. */
function orgJson(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, "\\/")
}

/** A webhook answer: its status, its text, the text parsed, and the receipt id it carries. */
interface Answer {
  status: number
  text: string
  json: unknown
  receiptId: string | undefined
}

interface Running {
  db: Database
  broker: Broker
  webhook: ReturnType<typeof startWebhookServer>
  api: ReturnType<typeof startApiServer>
}

class Harness {
  clock = T0
  readonly runtime: string
  readonly socket: string
  logs: string[] = []
  private running: Running | null = null

  constructor(readonly dir: string = scratch(), private readonly profiles: Record<string, Profile> = {}) {
    this.runtime = join(dir, "run")
    mkdirSync(this.runtime, { recursive: true, mode: 0o700 })
    this.socket = join(dir, "state", "broker.sock")
    mkdirSync(join(dir, "state"), { recursive: true, mode: 0o700 })
    this.start()
    harnesses.push(this)
  }

  get dbPath(): string {
    return join(this.dir, "state", "otp.sqlite")
  }

  private get live(): Running {
    if (this.running === null) throw new Error("the broker is stopped")
    return this.running
  }

  get db(): Database {
    return this.live.db
  }

  get broker(): Broker {
    return this.live.broker
  }

  start(): void {
    const db = openStore(this.dbPath)
    const broker = new Broker(db, { now: () => this.clock, profiles: () => this.profiles })
    this.running = {
      db,
      broker,
      webhook: startWebhookServer(webhookHandler(broker, KEY, () => this.clock, (line) => this.logs.push(line)), "127.0.0.1", 0),
      api: startApiServer(broker, this.socket),
    }
  }

  stop(): void {
    const running = this.running
    if (running === null) return
    this.running = null
    running.broker.stop()
    running.webhook.stop(true)
    running.api.stop(true)
    running.db.close()
  }

  restart(): void {
    this.stop()
    this.start()
  }

  get url(): string {
    return `http://127.0.0.1:${this.live.webhook.port}/v1/events`
  }

  async postRaw(raw: string, headers: Record<string, string>, method = "POST", url = this.url): Promise<Answer> {
    const response = await fetch(url, { method, body: method === "GET" ? undefined : raw, headers })
    const text = await response.text()
    const json = parseJson(text)
    const receiptId = isRecord(json) && typeof json.receipt_id === "string" ? json.receipt_id : undefined
    return { status: response.status, text, json, receiptId }
  }

  /** Sends what the phone would send right now, signed like the phone signs it. */
  async send<T extends { ts_ms: number; delivery_id: string }>(
    value: T,
    options: { key?: string; t?: number; idempotencyKey?: string } = {},
  ): Promise<Answer> {
    const raw = orgJson(value)
    return this.postRaw(raw, {
      "content-type": "application/json; charset=utf-8",
      "x-smsforward-signature": signatureHeader(options.key ?? KEY, new TextEncoder().encode(raw), options.t ?? value.ts_ms),
      "idempotency-key": options.idempotencyKey ?? value.delivery_id,
    })
  }

  async phone(event: PhoneEvent): Promise<Answer & { value: EventBody }> {
    const value = body(event, this.clock)
    return { ...(await this.send(value)), value }
  }

  async cli(session: string | null, ...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = []
    const err: string[] = []
    const env: Record<string, string> = { AI_BRIDGE_OTP_SOCKET: this.socket, XDG_RUNTIME_DIR: this.runtime }
    if (session) env.VIBETERM_SESSION_ID = session
    const code = await runCli(args, env, { out: (line) => out.push(line), err: (line) => err.push(line) })
    return { code, out, err }
  }

  async request(session: string, ...flags: string[]): Promise<string> {
    const result = await this.cli(session, "request", "--account", "synthetic@example.test", "--test", ...flags)
    expect(result.code).toBe(0)
    return defined(result.out.find((line) => line.startsWith("request_id=")), "request_id").slice("request_id=".length)
  }

  codeFile(requestId: string): string {
    return join(this.runtime, "ai-bridge-otp", `${requestId}.env`)
  }

  claimedCode(requestId: string): string | undefined {
    if (!existsSync(this.codeFile(requestId))) return undefined
    return /^OTP_CODE=(.*)$/m.exec(readFileSync(this.codeFile(requestId), "utf8"))?.[1]
  }

  /** Every delivery, read back through `receipts --json` and the CLI's own parser. */
  async receipts(): Promise<Receipt[]> {
    const result = await this.cli(null, "receipts", "--since", "30d", "--json")
    expect(result.code).toBe(0)
    return parseReceiptList({ receipts: parseJson(result.out.join("\n")) })
  }

  async receipt(deliveryId: string): Promise<Receipt> {
    return defined((await this.receipts()).find((r) => r.deliveryId === deliveryId), `the receipt of ${deliveryId}`)
  }
}

describe("webhook signature", () => {
  test("verifies the raw bytes, including org.json's \\/ escapes", async () => {
    const h = new Harness()
    const value = body({ capturedAt: T0 }, T0)
    const raw = orgJson(value)
    expect(raw).toContain("https:\\/\\/example.test\\/otp")
    // A receiver that re-serialized before verifying would compute a different MAC.
    const reserialized = JSON.stringify(JSON.parse(raw))
    const mac = (text: string) => createHmac("sha256", Buffer.from(KEY, "utf8")).update(Buffer.from(text, "utf8")).digest("hex")
    expect(mac(reserialized)).not.toBe(mac(raw))

    const stored = await h.send(value)
    expect(stored.status).toBe(200)
    expect(stored.json).toEqual({ status: "stored", receipt_id: expect.stringMatching(/^rct_[0-9a-f]{20}$/) })

    // Signed over the re-serialized form but sent as org.json bytes: refused.
    const other = { ...value, delivery_id: crypto.randomUUID() }
    const otherRaw = orgJson(other)
    const refused = await h.postRaw(otherRaw, {
      "x-smsforward-signature": signatureHeader(KEY, new TextEncoder().encode(JSON.stringify(other)), other.ts_ms),
      "idempotency-key": other.delivery_id,
    })
    expect(refused.status).toBe(401)
    expect(refused.json).toEqual({ status: "bad_signature" })
  })

  test("refuses a wrong key, a tampered body, and a missing or malformed header, storing nothing", async () => {
    const h = new Harness()
    const value = body({ capturedAt: T0 }, T0)
    expect((await h.send(value, { key: randomBytes(32).toString("base64url") })).json).toEqual({ status: "bad_signature" })

    const raw = orgJson(value)
    const signature = signatureHeader(KEY, new TextEncoder().encode(raw), value.ts_ms)
    const tampered = raw.replace("482913", "482914")
    expect((await h.postRaw(tampered, { "x-smsforward-signature": signature, "idempotency-key": value.delivery_id })).status).toBe(401)
    expect((await h.postRaw(raw, { "idempotency-key": value.delivery_id })).status).toBe(401)
    for (const header of ["t=abc,v1=00", `v1=${"0".repeat(64)}`, `t=${value.ts_ms}`, `t=${value.ts_ms},v1=xyz`]) {
      expect((await h.postRaw(raw, { "x-smsforward-signature": header, "idempotency-key": value.delivery_id })).status).toBe(401)
    }
    expect(await h.receipts()).toEqual([])
  })

  test("refuses a signature more than 300 s away from the desktop clock, or a t that is not the body's ts_ms", async () => {
    const h = new Harness()
    const old = body({ capturedAt: T0 - 301 * SECOND, skew: -301 * SECOND }, T0)
    expect(await h.send(old)).toMatchObject({ status: 401, json: { status: "stale_signature" } })
    const ahead = body({ capturedAt: T0, skew: 301 * SECOND }, T0)
    expect(await h.send(ahead)).toMatchObject({ status: 401, json: { status: "stale_signature" } })
    const inside = body({ capturedAt: T0, skew: -299 * SECOND }, T0)
    expect(await h.send(inside)).toMatchObject({ status: 200, json: { status: "stored" } })

    const value = body({ capturedAt: T0 }, T0)
    expect(await h.send(value, { t: value.ts_ms + 1 })).toMatchObject({ status: 401, json: { status: "bad_signature" } })
  })

  test("answers 404 to anything but POST /v1/events", async () => {
    const h = new Harness()
    const base = h.url.replace("/v1/events", "")
    expect((await h.postRaw("", {}, "GET")).status).toBe(404)
    expect((await h.postRaw("{}", {}, "PUT")).status).toBe(404)
    expect((await h.postRaw("{}", {}, "POST", `${base}/v1/event`)).status).toBe(404)
    expect((await h.postRaw("{}", {}, "POST", `${base}/`)).status).toBe(404)
  })

  test("refuses invalid fields by name, and never echoes content", async () => {
    const h = new Harness()
    const cases = [
      { value: { ...body({ capturedAt: T0 }, T0), delivery_id: "not-a-uuid" }, field: "delivery_id" },
      { value: { ...body({ capturedAt: T0 }, T0), age_ms: -1 }, field: "age_ms" },
      { value: { ...body({ capturedAt: T0 }, T0), captured_at_ms: "soon" }, field: "captured_at_ms" },
      { value: { ...body({ capturedAt: T0 }, T0), version: 2 }, field: "version" },
      { value: { ...body({ capturedAt: T0 }, T0), source: { number: SENDER_A, name: "x", kind: "notification" } }, field: "source.package" },
      { value: { ...body({ capturedAt: T0 }, T0), source: { number: SENDER_A, name: "x", kind: "email" } }, field: "source.kind" },
    ]
    for (const { value, field } of cases) {
      const response = await h.send(value)
      expect(response.status).toBe(400)
      expect(response.json).toEqual({ status: "invalid", error: field })
      expect(response.text).not.toContain(SENDER_A)
      expect(response.text).not.toContain("482913")
    }
    const value = body({ capturedAt: T0 }, T0)
    expect((await h.send(value, { idempotencyKey: crypto.randomUUID() })).json).toEqual({ status: "invalid", error: "idempotency_key" })

    const big = body({ capturedAt: T0, text: `AIBRIDGE-TEST ${"x".repeat(16 * 1024)}` }, T0)
    expect(await h.send(big)).toMatchObject({ status: 413, json: { status: "invalid", error: "body" } })
    expect(h.logs.join("\n")).not.toContain(SENDER_A)
    expect(await h.receipts()).toEqual([])
  })

  test("reads JSON null in an optional field like a missing one, so a retry that drops it is a duplicate", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    const value = body({ capturedAt: T0 + SECOND, code: "868686" }, h.clock)
    const nulled = {
      ...value,
      age_ms: null,
      redirect_id: null,
      event_id: null,
      label: null,
      source: { ...value.source, name: null, package: null, time_basis: null },
    }
    const stored = await h.send(nulled)
    expect(stored).toMatchObject({ status: 200, json: { status: "stored" } })
    expect(await h.receipt(value.delivery_id)).toMatchObject({ state: "matched", ageSource: "ts", timeBasis: null })

    h.clock += 10 * SECOND
    const { age_ms: _a, redirect_id: _r, event_id: _e, label: _l, ...dropped } = nulled
    const { name: _n, package: _p, time_basis: _t, ...source } = nulled.source
    const retry = await h.send({ ...dropped, source, ts_ms: h.clock })
    expect(retry).toMatchObject({ status: 200, json: { status: "duplicate", receipt_id: defined(stored.receiptId, "the stored receipt id") } })

    const untested = body({ capturedAt: T0 + SECOND, code: "878787" }, h.clock)
    expect((await h.send({ ...untested, test: null })).json).toMatchObject({ status: "stored" })
    expect((await h.receipt(untested.delivery_id)).test).toBe(false)

    const note = body({ kind: "notification", capturedAt: T0 + SECOND }, h.clock)
    const noPackage = { ...note, source: { ...note.source, package: null } }
    expect(await h.send(noPackage)).toMatchObject({ status: 400, json: { status: "invalid", error: "source.package" } })

    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("868686")
  })
})

describe("deduplication", () => {
  test("a lost-ACK retry with a changed age_ms, and a retry after a reboot without one, change nothing", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    const first = await h.phone({ capturedAt: T0 + 2 * SECOND, code: "731905" })
    expect(first.json).toMatchObject({ status: "stored" })
    const receiptId = defined(first.receiptId, "the first receipt id")
    const before = await h.receipt(first.value.delivery_id)
    expect(before.state).toBe("matched")

    // The ACK was lost: the phone retries 40 s later, re-signed, with a grown age_ms.
    h.clock += 40 * SECOND
    const retry = { ...first.value, ts_ms: h.clock, age_ms: defined(first.value.age_ms, "age_ms") + 40 * SECOND }
    expect(await h.send(retry)).toMatchObject({ status: 200, json: { status: "duplicate", receipt_id: receiptId } })

    // The phone rebooted: same delivery, no age_ms any more.
    h.clock += 60 * SECOND
    const { age_ms: _, ...rebooted } = { ...first.value, ts_ms: h.clock }
    expect(await h.send(rebooted)).toMatchObject({ status: 200, json: { status: "duplicate", receipt_id: receiptId } })

    // And a byte-identical resend, which on its own would prove nothing.
    expect((await h.send(retry)).json).toMatchObject({ status: "duplicate" })

    const after = await h.receipt(first.value.delivery_id)
    expect(after.duplicates).toBe(3)
    expect(after.captureDesktopMs).toBe(before.captureDesktopMs)
    expect(after.ageMs).toBe(before.ageMs)
    expect(after.tsMs).toBe(before.tsMs)
    expect(after.state).toBe("matched")
    expect((await h.receipts()).length).toBe(1)

    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("731905")
  })

  test("the same delivery_id with different immutable content is a conflict", async () => {
    const h = new Harness()
    const first = await h.phone({ capturedAt: T0, code: "100200" })
    const changed = { ...first.value, label: "edited", ts_ms: h.clock }
    expect(await h.send(changed)).toMatchObject({ status: 409, json: { status: "conflict" } })
    const recoded = { ...first.value, body: "AIBRIDGE-TEST code 999999", ts_ms: h.clock }
    expect((await h.send(recoded)).status).toBe(409)
    expect((await h.receipts()).length).toBe(1)
  })

  test("a long-queued retransmit with a fresh ts_ms is ACKed and never matches a newer request", async () => {
    const h = new Harness()
    // Stored before any request existed, then retransmitted after one was registered.
    const early = await h.phone({ capturedAt: T0 - 30 * SECOND, code: "300300" })
    expect(early.json).toMatchObject({ status: "stored" })
    h.clock += 2 * MINUTE
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += MINUTE
    const retransmit = { ...early.value, ts_ms: h.clock, age_ms: 3 * MINUTE + 30 * SECOND }
    expect((await h.send(retransmit)).json).toMatchObject({ status: "duplicate" })
    expect((await h.receipt(early.value.delivery_id)).state).toBe("unmatched")

    // Never ACKed before: its first arrival comes after the registration, with its original capture time.
    const queued = await h.phone({ capturedAt: T0 - 20 * SECOND, observedAt: T0 - 20 * SECOND, code: "400400" })
    expect(queued.json).toMatchObject({ status: "stored" })
    const receipt = await h.receipt(queued.value.delivery_id)
    expect(receipt).toMatchObject({ state: "stale", reason: "before_registration", captureDesktopMs: T0 - 20 * SECOND })

    const claim = await h.cli(SESSION_A, "claim", id)
    expect(claim).toMatchObject({ code: 6, out: ["pending"] })
  })
})

describe("capture time", () => {
  test("an event captured just before registration is stale, one captured just after is eligible", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 3 * SECOND
    const before = await h.phone({ capturedAt: T0 - 1, code: "111111" })
    const after = await h.phone({ capturedAt: T0 + 1, code: "222222" })
    const [b, a] = [await h.receipt(before.value.delivery_id), await h.receipt(after.value.delivery_id)]
    expect(b).toMatchObject({ state: "stale", reason: "before_registration", captureDesktopMs: T0 - 1 })
    expect(b.requests).toEqual([{ requestId: id, role: "stale", notBefore: T0 }])
    expect(a).toMatchObject({ state: "matched", captureDesktopMs: T0 + 1 })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("222222")
  })

  test("an old event in flight across registration is reported with its capture time against not_before", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    // Captured 2 s before the registration, delivered 3 s after it.
    h.clock = T0 + 3 * SECOND
    const inFlight = await h.phone({ capturedAt: T0 - 2 * SECOND, code: "121212" })
    const receipt = await h.receipt(inFlight.value.delivery_id)
    expect(receipt.captureDesktopMs).toBe(T0 - 2 * SECOND)
    expect(receipt.arrivalMs).toBe(T0 + 3 * SECOND)
    expect(receipt.requests[0]).toEqual({ requestId: id, role: "stale", notBefore: T0 })
    expect(receipt.captureDesktopMs).toBeLessThan(receipt.requests[0].notBefore)

    const text = await h.cli(null, "receipts", "--since", "1h")
    expect(text.out[0]).toContain(`capture_desktop=${new Date(T0 - 2 * SECOND).toISOString()}`)
    expect(text.out[0]).toContain(`${id}:stale:not_before=${new Date(T0).toISOString()}`)
  })

  test("an old SMS that Android delivers late keeps its age from before the phone saw it", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    // PDU time 5 min before the registration; Android hands it over 1 min after it.
    h.clock = T0 + 70 * SECOND
    const late = await h.phone({ capturedAt: T0 - 5 * MINUTE, observedAt: T0 + MINUTE, code: "505050" })
    const receipt = await h.receipt(late.value.delivery_id)
    expect(receipt.ageMs).toBe(6 * MINUTE + 10 * SECOND)
    expect(receipt).toMatchObject({ state: "stale", reason: "before_registration", captureDesktopMs: T0 - 5 * MINUTE })

    // The same for a notification, whose capture time is the phone's: its age carries the time before observation.
    const note = await h.phone({ kind: "notification", capturedAt: T0 - 5 * MINUTE, observedAt: T0 + MINUTE, code: "515151" })
    expect(await h.receipt(note.value.delivery_id)).toMatchObject({ state: "stale", captureDesktopMs: T0 - 5 * MINUTE })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(6)
  })

  test("an old event delivered late after a resend, or after a cancel and a new request, is stale", async () => {
    const h = new Harness()
    const first = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock = T0 + MINUTE
    expect((await h.cli(SESSION_A, "resend", first)).out).toEqual([`not_before=${new Date(T0 + MINUTE).toISOString()}`])
    h.clock = T0 + 90 * SECOND
    const beforeResend = await h.phone({ capturedAt: T0 + 30 * SECOND, code: "616161" })
    expect(await h.receipt(beforeResend.value.delivery_id)).toMatchObject({ state: "stale", reason: "before_resend" })

    expect((await h.cli(SESSION_A, "cancel", first)).out).toEqual([`cancelled ${first}`])
    h.clock = T0 + 2 * MINUTE
    const second = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock = T0 + 150 * SECOND
    const beforeSecond = await h.phone({ capturedAt: T0 + 100 * SECOND, code: "626262" })
    expect(await h.receipt(beforeSecond.value.delivery_id)).toMatchObject({ state: "stale", reason: "before_registration" })
    expect((await h.cli(SESSION_A, "claim", second)).code).toBe(6)
    expect((await h.cli(SESSION_A, "claim", first)).code).toBe(4)
  })

  test("a resend makes an earlier matched code stale and lets a fresh one through", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 10 * SECOND
    await h.phone({ capturedAt: T0 + 5 * SECOND, code: "717171" })
    h.clock += 10 * SECOND
    await h.cli(SESSION_A, "resend", id)
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(6)
    h.clock += 5 * SECOND
    await h.phone({ capturedAt: h.clock - SECOND, code: "727272" })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("727272")
  })

  test("a phone clock off by minutes in either direction changes no SMS outcome", async () => {
    const outcomes: string[] = []
    for (const skew of [-4 * MINUTE, -MINUTE, 0, MINUTE, 4 * MINUTE]) {
      const h = new Harness()
      const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
      h.clock = T0 + 20 * SECOND
      const old = await h.phone({ capturedAt: T0 - 3 * MINUTE, observedAt: T0 - 3 * MINUTE, skew, code: "818181" })
      const fresh = await h.phone({ capturedAt: T0 + 5 * SECOND, skew, code: "828282" })
      expect(old.status).toBe(200)
      expect(fresh.status).toBe(200)
      const claim = await h.cli(SESSION_A, "claim", id)
      outcomes.push(
        `${(await h.receipt(old.value.delivery_id)).state} ${(await h.receipt(fresh.value.delivery_id)).state} ${claim.code} ${h.claimedCode(id)}`,
      )
    }
    expect(new Set(outcomes)).toEqual(new Set(["stale claimed 0 828282"]))
  })

  test("a phone clock off by minutes never makes an old notification eligible, on either clock basis", async () => {
    for (const basis of ["phone", "source"] as const) {
      for (const skew of [-4 * MINUTE, 0, 4 * MINUTE]) {
        const h = new Harness()
        await h.request(SESSION_A, "--service", "proof-a", "--package", "org.aibridge.test")
        h.clock = T0 + 20 * SECOND
        const old = await h.phone({ kind: "notification", basis, capturedAt: T0 - 3 * MINUTE, skew, code: "919191" })
        expect((await h.receipt(old.value.delivery_id)).state).toBe("stale")
        const fresh = await h.phone({ kind: "notification", basis, capturedAt: T0 + 5 * SECOND, skew, code: "929292" })
        const state = (await h.receipt(fresh.value.delivery_id)).state
        // The cost of failing closed: a slow phone stamping its own clock, or a fast phone
        // against a server's clock, makes a fresh notification look older.
        const failsClosed = (basis === "phone" && skew < 0) || (basis === "source" && skew > 0)
        expect(state).toBe(failsClosed ? "stale" : "matched")
      }
    }
  })

  test("a source time more than 300 s in the future is a clock anomaly", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 10 * SECOND
    const future = await h.phone({ capturedAt: h.clock + 301 * SECOND, code: "131313" })
    expect(future.json).toMatchObject({ status: "stored" })
    expect(await h.receipt(future.value.delivery_id)).toMatchObject({ state: "unmatched", reason: "clock_anomaly" })
    // Inside the margin it is clamped to its arrival and counts.
    const near = await h.phone({ capturedAt: h.clock + 200 * SECOND, code: "141414" })
    expect(await h.receipt(near.value.delivery_id)).toMatchObject({ state: "matched", captureDesktopMs: h.clock })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("141414")
  })

  test("an event arriving after its request expired matches nothing, and the request answers expired", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A, "--window", "1m")
    h.clock = T0 + 61 * SECOND
    const late = await h.phone({ capturedAt: T0 + 30 * SECOND, code: "151515" })
    expect(await h.receipt(late.value.delivery_id)).toMatchObject({ state: "unmatched", reason: "no_request" })
    expect(await h.cli(SESSION_A, "claim", id)).toMatchObject({ code: 2, out: ["expired"] })
    expect(await h.cli(SESSION_A, "wait", id, "--timeout", "2s")).toMatchObject({ code: 2, out: ["expired"] })
  })
})

describe("matching", () => {
  test("two sessions with different challenges and senders each get only their own code", async () => {
    const h = new Harness()
    const a = await h.request(SESSION_A, "--service", "proof-a", "--challenge", "login-a", "--sender", SENDER_A)
    const b = await h.request(SESSION_B, "--service", "proof-b", "--challenge", "login-b", "--sender", SENDER_B)
    const waitA = h.cli(SESSION_A, "wait", a, "--timeout", "10s")
    const waitB = h.cli(SESSION_B, "wait", b, "--timeout", "10s")
    h.clock += 5 * SECOND
    await h.phone({ sender: SENDER_B, capturedAt: T0 + 2 * SECOND, code: "246802" })
    await h.phone({ sender: SENDER_A, capturedAt: T0 + 3 * SECOND, code: "135791" })
    const [resultA, resultB] = await Promise.all([waitA, waitB])
    expect(resultA).toMatchObject({ code: 0, out: [`matched ${h.codeFile(a)}`] })
    expect(resultB).toMatchObject({ code: 0, out: [`matched ${h.codeFile(b)}`] })
    expect(h.claimedCode(a)).toBe("135791")
    expect(h.claimedCode(b)).toBe("246802")
    expect(statSync(h.codeFile(a)).mode & 0o777).toBe(0o600)
    expect(statSync(join(h.runtime, "ai-bridge-otp")).mode & 0o777).toBe(0o700)
    // Neither session can read the other's.
    expect((await h.cli(SESSION_B, "claim", a)).code).toBe(1)
  })

  test("an event eligible for two open requests goes to neither", async () => {
    const h = new Harness()
    const a = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    const b = await h.request(SESSION_B, "--service", "proof-b", "--body-pattern", "AIBRIDGE-AMBIG")
    h.clock += 5 * SECOND
    const event = await h.phone({ sender: SENDER_A, capturedAt: T0 + SECOND, text: "AIBRIDGE-AMBIG code 373737" })
    const receipt = await h.receipt(event.value.delivery_id)
    expect(receipt.state).toBe("ambiguous")
    expect(receipt.requests.map((r) => r.requestId).sort()).toEqual([a, b].sort())
    expect(await h.cli(SESSION_A, "wait", a, "--timeout", "2s")).toMatchObject({ code: 3, out: ["ambiguous"] })
    expect(await h.cli(SESSION_B, "claim", b)).toMatchObject({ code: 3, out: ["ambiguous"] })
    expect(h.claimedCode(a)).toBeUndefined()
    expect(h.claimedCode(b)).toBeUndefined()
  })

  test("the same code twice is one code; two distinct codes are ambiguous until a resend", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    await h.phone({ capturedAt: T0 + SECOND, code: "454545" })
    await h.phone({ capturedAt: T0 + 2 * SECOND, code: "454545" })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("454545")

    h.clock += MINUTE
    const second = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    await h.phone({ capturedAt: h.clock - 3 * SECOND, code: "565656" })
    await h.phone({ capturedAt: h.clock - 2 * SECOND, code: "676767" })
    expect(await h.cli(SESSION_A, "claim", second)).toMatchObject({ code: 3, out: ["ambiguous"] })
    await h.cli(SESSION_A, "resend", second)
    h.clock += 5 * SECOND
    await h.phone({ capturedAt: h.clock - SECOND, code: "787878" })
    expect((await h.cli(SESSION_A, "claim", second)).code).toBe(0)
    expect(h.claimedCode(second)).toBe("787878")
  })

  test("a consumed code satisfies no other request, and only its own session reads it again", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    const event = await h.phone({ capturedAt: T0 + SECOND, code: "898989" })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    rmSync(h.codeFile(id))
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("898989")
    expect(await h.cli(SESSION_B, "claim", id)).toMatchObject({ code: 1, err: ["ai-bridge-otp: the request belongs to another session"] })

    h.clock += 10 * SECOND
    const next = await h.request(SESSION_B, "--service", "proof-a", "--sender", SENDER_A)
    expect((await h.send({ ...event.value, ts_ms: h.clock })).json).toMatchObject({ status: "duplicate" })
    expect((await h.cli(SESSION_B, "claim", next)).code).toBe(6)
    expect((await h.receipt(event.value.delivery_id)).state).toBe("claimed")
  })

  test("a code the provider rejected is reported with cancel and deleted", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    await h.phone({ capturedAt: T0 + SECOND, code: "909090" })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(await h.cli(SESSION_A, "cancel", id)).toMatchObject({ code: 0, out: [`rejected ${id}`] })
    expect(await h.cli(SESSION_A, "claim", id)).toMatchObject({ code: 4, out: ["cancelled"] })
    const status = await h.cli(null, "status", id)
    expect(status.out[0]).toContain("rejected=")
  })

  test("leases serialize requests that share a sender, a package or a (service, account)", async () => {
    const h = new Harness()
    const a = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    const busy = await h.cli(SESSION_B, "request", "--service", "proof-b", "--account", "other@example.test", "--test", "--sender", "aibridge-test-a")
    expect(busy).toMatchObject({ code: 5, out: [`busy holder=${a} session=${SESSION_A} expires_at=${new Date(T0 + 10 * MINUTE).toISOString()}`] })
    expect((await h.cli(SESSION_B, "request", "--service", "proof-b", "--account", "x", "--test", "--sender", SENDER_A, "--supersede")).code).toBe(5)
    expect((await h.cli(SESSION_B, "request", "--service", "proof-a", "--account", "synthetic@example.test", "--test", "--sender", SENDER_B)).code).toBe(5)
    // A real request never competes with a test one.
    expect((await h.cli(SESSION_B, "request", "--service", "proof-a", "--account", "synthetic@example.test", "--sender", SENDER_A)).code).toBe(0)

    const waiting = h.cli(SESSION_A, "wait", a, "--timeout", "10s")
    const replaced = await h.cli(SESSION_A, "request", "--service", "proof-a", "--account", "synthetic@example.test", "--test", "--sender", SENDER_A, "--supersede")
    expect(replaced.code).toBe(0)
    expect(replaced.err).toEqual([`superseded ${a}`])
    expect(await waiting).toMatchObject({ code: 4, out: ["cancelled"] })

    const bodyOnly = await h.request(SESSION_A, "--service", "proof-c", "--body-pattern", "AIBRIDGE-C")
    expect((await h.cli(SESSION_B, "request", "--service", "proof-c", "--account", "z", "--test", "--body-pattern", "AIBRIDGE-Z")).code).toBe(5)
    expect(bodyOnly).toMatch(/^otp_/)
  })

  test("a service profile supplies the hints, and a request needs some", async () => {
    const h = new Harness(scratch(), { proofsvc: { senders: [SENDER_A], bodyPattern: "aibridge-test" } })
    const refused = await h.cli(SESSION_A, "request", "--service", "unknown", "--account", "a", "--test")
    expect(refused.code).toBe(1)
    expect(refused.err[0]).toContain("has no profile")
    const id = await h.request(SESSION_A, "--service", "proofsvc")
    h.clock += 5 * SECOND
    const wrong = await h.phone({ sender: SENDER_B, capturedAt: T0 + SECOND, code: "202020" })
    expect(await h.receipt(wrong.value.delivery_id)).toMatchObject({ state: "unmatched", reason: "hints:sender" })
    const twoCodes = await h.phone({ capturedAt: T0 + SECOND, text: "AIBRIDGE-TEST code 202021 or 202022" })
    expect(await h.receipt(twoCodes.value.delivery_id)).toMatchObject({ state: "unmatched", reason: "no_code" })
    await h.phone({ sender: "aibridge test a", capturedAt: T0 + 2 * SECOND, code: "303030" })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("303030")
  })

  test("status and receipts carry ids, states and times, never content", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--challenge", "secret-challenge-label", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    await h.phone({ capturedAt: T0 + SECOND, code: "414141" })
    await h.phone({ sender: SENDER_B, capturedAt: T0 + SECOND, code: "424242" })
    const outputs = [
      await h.cli(null, "status"),
      await h.cli(null, "status", id, "--json"),
      await h.cli(null, "receipts"),
      await h.cli(null, "receipts", "--json"),
    ].flatMap((r) => [...r.out, ...r.err])
    const text = outputs.join("\n")
    expect(text).toContain(id)
    for (const secret of ["414141", "424242", SENDER_A, SENDER_B, "Synthetic Contact", "example.test/otp", "synthetic@example.test", "secret-challenge-label"]) {
      expect(text).not.toContain(secret)
    }
  })
})

describe("the CLI socket", () => {
  test("refuses a field of the wrong type with a 400 naming it, and creates, changes and logs nothing", async () => {
    const h = new Harness()
    const logged: string[] = []
    const capture = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "))
    }
    const log = spyOn(console, "log").mockImplementation(capture)
    const error = spyOn(console, "error").mockImplementation(capture)
    const wrongType = (field: string) => ({ status: 400, body: { error: `${field} has the wrong type`, kind: "invalid" } })
    try {
      const valid = { session: SESSION_A, service: "proof-a", account: "synthetic@example.test", senders: [SENDER_A], test: true }
      const create = (request: Record<string, unknown>) => apiCall(h.socket, "POST", "/v1/requests", request)
      expect(await create({ ...valid, test: "true" })).toEqual(wrongType("test"))
      expect(await create({ ...valid, senders: SENDER_A })).toEqual(wrongType("senders"))
      expect(await create({ ...valid, senders: [SENDER_A, 7] })).toEqual(wrongType("senders"))
      expect(await create({ ...valid, windowMs: "600000" })).toEqual(wrongType("windowMs"))
      expect(await create({ ...valid, supersede: "yes" })).toEqual(wrongType("supersede"))
      expect(await create({ ...valid, account: 42 })).toEqual(wrongType("account"))
      expect(await create({ ...valid, session: undefined })).toEqual({ status: 400, body: { error: "session is required", kind: "invalid" } })
      expect(h.broker.status()).toEqual([])

      const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
      for (const verb of ["claim", "resend", "cancel"]) {
        expect(await apiCall(h.socket, "POST", `/v1/requests/${id}/${verb}`, { session: 42 })).toEqual(wrongType("session"))
      }
      expect(await apiCall(h.socket, "POST", `/v1/requests/${id}/claim`, { session: SESSION_A, waitMs: "abc" })).toEqual(wrongType("waitMs"))
      expect(h.broker.status(id)).toMatchObject([{ state: "open", verdict: "pending", resends: 0 }])
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
    expect(logged).toEqual([])
  })
})

describe("durability and retention", () => {
  test("a broker restarted between store and claim still hands over the code, to a wait that spans the restart", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    await h.phone({ capturedAt: T0 + SECOND, code: "525252" })
    h.restart()
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    expect(h.claimedCode(id)).toBe("525252")

    const second = await h.request(SESSION_A, "--service", "proof-b", "--sender", SENDER_B)
    const waiting = h.cli(SESSION_A, "wait", second, "--timeout", "15s")
    await Bun.sleep(300)
    h.stop()
    await Bun.sleep(1_500)
    h.start()
    h.clock += 5 * SECOND
    await h.phone({ sender: SENDER_B, capturedAt: h.clock - SECOND, code: "535353" })
    expect((await waiting).code).toBe(0)
    expect(h.claimedCode(second)).toBe("535353")
  })

  test("codes go an hour after the claim, deliveries and requests after seven days, and content never reaches the disk", async () => {
    const h = new Harness()
    const id = await h.request(SESSION_A, "--service", "proof-a", "--sender", SENDER_A)
    h.clock += 5 * SECOND
    const event = await h.phone({ capturedAt: T0 + SECOND, code: "646464" })
    await h.phone({ sender: SENDER_B, capturedAt: T0 + SECOND, code: "656565" })
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)

    h.clock += 59 * MINUTE
    h.broker.purge()
    rmSync(h.codeFile(id))
    expect((await h.cli(SESSION_A, "claim", id)).code).toBe(0)
    h.clock += 2 * MINUTE
    expect(h.broker.purge().codes).toBe(1)
    expect(await h.cli(SESSION_A, "claim", id)).toMatchObject({ code: 2, out: ["expired"] })

    const disk = ["otp.sqlite", "otp.sqlite-wal", "otp.sqlite-shm"]
      .map((name) => join(h.dir, "state", name))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path).toString("latin1"))
      .join("")
    for (const secret of ["646464", "656565", SENDER_A, SENDER_B, "aibridge-test-a", "Synthetic Contact", "example.test/otp", "AIBRIDGE-TEST code"]) {
      expect(disk).not.toContain(secret)
    }

    expect((await h.receipt(event.value.delivery_id)).state).toBe("claimed")
    h.clock += 7 * 24 * 60 * MINUTE
    expect(h.broker.purge()).toMatchObject({ events: 2, requests: 1 })
    expect(await h.receipts()).toEqual([])
    expect((await h.cli(null, "status", id)).code).toBe(1)
  })

  test("the store is durable, private and owned by one broker", () => {
    const h = new Harness()
    expect(h.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    expect(h.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 })
    expect(statSync(h.dbPath).mode & 0o777).toBe(0o600)
    expect(statSync(h.socket).mode & 0o777).toBe(0o600)
    expect(() => openStore(h.dbPath)).toThrow()
  })
})

describe("entrypoints", () => {
  test("profiles.ts imports a sender from a private file by JSON pointer and prints only counts", async () => {
    const dir = scratch()
    const discovery = join(dir, "discovery.json")
    writeFileSync(discovery, JSON.stringify({ candidates: [{ sender: "+1 (555) 010-9999", source_kind: "sms" }] }), { mode: 0o600 })
    const profiles = join(dir, "profiles.json")
    const run = (file: string) =>
      Bun.spawnSync(["bun", "src/otp/profiles.ts", "--profiles", profiles, "--service", "spruce", "--senders-from", file, "--pointer", "/candidates/0/sender", "--body-pattern", "Spruce"])
    const result = run(discovery)
    expect(result.exitCode).toBe(0)
    const printed = `${result.stdout}${result.stderr}`
    expect(printed).toContain("profile spruce: 1 sender(s), body pattern set, 0 package(s), code pattern default")
    expect(printed).not.toContain("555")
    expect(statSync(profiles).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(profiles, "utf8"))).toEqual({ spruce: { senders: ["+15550109999"], bodyPattern: "Spruce" } })

    chmodSync(discovery, 0o644)
    const loose = run(discovery)
    expect(loose.exitCode).not.toBe(0)
    expect(`${loose.stdout}${loose.stderr}`).not.toContain("555")
  })

  test("main.ts serves the webhook and the socket, and cli.ts talks to it, in separate processes", async () => {
    const dir = scratch()
    const state = join(dir, "state")
    mkdirSync(state, { mode: 0o700 })
    writeFileSync(join(state, "webhook-signing-key"), KEY, { mode: 0o600 })
    const broker = Bun.spawn(["bun", "src/otp/main.ts", "--state-dir", state, "--listen", "127.0.0.1:0"], { stdout: "pipe", stderr: "pipe" })
    try {
      const reader = broker.stdout.getReader()
      let started = ""
      while (!/ on 127\.0\.0\.1:\d+ /.test(started)) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`broker exited: ${await new Response(broker.stderr).text()}`)
        started += new TextDecoder().decode(chunk.value)
      }
      expect(started).not.toContain(KEY)
      const port = defined(/ on 127\.0\.0\.1:(\d+) /.exec(started)?.[1], "the broker's port")
      const value = body({ capturedAt: Date.now(), test: true }, Date.now())
      const raw = orgJson(value)
      const response = await fetch(`http://127.0.0.1:${port}/v1/events`, {
        method: "POST",
        body: raw,
        headers: {
          "x-smsforward-signature": signatureHeader(KEY, new TextEncoder().encode(raw), value.ts_ms),
          "idempotency-key": value.delivery_id,
        },
      })
      expect(response.status).toBe(200)
      const cli = Bun.spawn(["bun", "src/otp/cli.ts", "receipts", "--socket", join(state, "broker.sock")], { stdout: "pipe", stderr: "pipe" })
      expect(await cli.exited).toBe(0)
      expect(await new Response(cli.stdout).text()).toContain(`delivery=${value.delivery_id}`)
      const usage = Bun.spawn(["bun", "src/otp/cli.ts"], { stdout: "pipe", stderr: "pipe" })
      expect(await usage.exited).toBe(1)
    } finally {
      broker.kill("SIGTERM")
      expect(await broker.exited).toBe(0)
    }
  })
})
