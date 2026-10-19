import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AckRequest, InboundRequest, InboundResponse, NackRequest, OutboxItem, OutboxResponse } from "../../src/relay/types"
import {
  fitReply,
  nativeClient,
  nativeReplySender,
  NativeError,
  promptFromEvent,
  TRUNCATION_NOTE,
  WHATSAPP_TEXT_LIMIT,
  WhatsAppNativeDriver,
  type Gate,
  type HeldRecord,
  type NativeCall,
  type RelayPort,
  type ReplyOutcome,
  type ReplyRequest,
  type WhatsAppNativeOptions,
} from "../../src/relay/whatsapp-native"
import { spawnVerifier, verifierVerdict, type VerifierRun, type VerifierRunner } from "../../src/relay/whatsapp-verifier"

setDefaultTimeout(30_000)

const GROUP = "120363000000000001@g.us"
const CONV = `c_${"a".repeat(64)}`
const ACCOUNT = `a_${"b".repeat(64)}`
const GEN = `g_${"c".repeat(64)}`
const GEN2 = `g_${"d".repeat(64)}`
const NOW = 1_800_000_600_000
const HEAD_AT = NOW - 300_000
const OWNER = "15550000001"

const gate: Gate = { groupJid: GROUP, conversationId: CONV, trigger: "!oc", windowMs: 600_000, generation: GEN, floorSequence: 19, notBefore: HEAD_AT }

let seq = 19
function event(text: string | null, message: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any {
  seq++
  return {
    sequence: seq,
    kind: "message",
    generation: GEN,
    observed_at: NOW - 5_000,
    origin: "live",
    conversation_id: CONV,
    message: {
      id: `true_${GROUP}_SYNTH${seq}`,
      chat_id: GROUP,
      from_me: true,
      self: true,
      sender_id: "98765432100001@lid",
      timestamp: NOW - 6_000,
      type: "chat",
      text,
      text_truncated: false,
      revision: "original",
      deleted: false,
      ack: 1,
      attachment: null,
      quoted_message_id: null,
      forwarded: false,
      quoted: false,
      trusted_self: true,
      send_request_id: null,
      ...message,
    },
    ...extra,
  }
}

const dirs: string[] = []
const drivers: WhatsAppNativeDriver[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-wa-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}

describe("which message is a prompt", () => {
  test("the account's own fresh text with the trigger", () => {
    const e = event("!oc  what is on my calendar?")
    expect(promptFromEvent(e, gate, NOW)).toEqual({
      ok: true,
      eventId: e.message.id,
      text: "what is on my calendar?",
      postedAt: NOW - 6_000,
      observedAt: NOW - 5_000,
      sequence: e.sequence,
    })
    expect(promptFromEvent(event("!oc\nmulti\nline"), gate, NOW)).toMatchObject({ ok: true, text: "multi\nline" })
  })

  test("the trigger opens the raw text as a word, with something after it", () => {
    expect(promptFromEvent(event("!ocx"), gate, NOW)).toEqual({ ok: false, reason: "no trigger" })
    expect(promptFromEvent(event(" !oc x"), gate, NOW)).toEqual({ ok: false, reason: "no trigger" })
    expect(promptFromEvent(event("hello !oc x"), gate, NOW)).toEqual({ ok: false, reason: "no trigger" })
    expect(promptFromEvent(event("!oc   "), gate, NOW)).toEqual({ ok: false, reason: "nothing after the trigger" })
  })

  test.each([
    ["an edit event", {}, { kind: "edit" }, "kind edit"],
    ["another chat", { chat_id: "120363000000000002@g.us" }, {}, "another chat"],
    ["another conversation id", {}, { conversation_id: `c_${"f".repeat(64)}` }, "another chat"],
    ["someone else's message", { from_me: false }, {}, "not the account's own message"],
    ["an own message from an untrusted sender", { trusted_self: false }, {}, "sender not trusted as the account"],
    ["the relay's own echo", { send_request_id: "obx_1" }, {}, "echo of a relay reply"],
    ["an app that does not report echoes", { send_request_id: undefined }, {}, "echo marker not reported"],
    ["history", {}, { origin: "history" }, "origin history"],
    ["an unknown origin", {}, { origin: "unknown" }, "origin unknown"],
    ["another generation", {}, { generation: GEN2 }, "another generation"],
    ["the live head itself", {}, { sequence: 19 }, "not after the live head and every discontinuity"],
    ["a forward", { forwarded: true }, {}, "forwarded"],
    ["forwarding not reported", { forwarded: null }, {}, "forwarding not reported"],
    ["a quote", { quoted: true }, {}, "quotes a message"],
    ["a quoted id", { quoted_message_id: "true_x_y" }, {}, "quotes a message"],
    ["an image", { type: "image", text: null }, {}, "type image"],
    ["truncated text", { text_truncated: true }, {}, "text truncated"],
    ["an edited message", { revision: "1800000000000" }, {}, "edited or deleted"],
    ["a deleted message", { deleted: true }, {}, "edited or deleted"],
    ["an attachment", { attachment: { type: "document" } }, {}, "carries an attachment"],
    ["posted before the head", { timestamp: HEAD_AT }, {}, "posted or observed before the live head"],
    ["observed before the head", {}, { observed_at: HEAD_AT }, "posted or observed before the live head"],
    ["a timestamp more than a minute ahead", { timestamp: NOW + 61_000 }, {}, "timestamp in the future"],
    ["an observation in the future", {}, { observed_at: NOW + 1 }, "timestamp in the future"],
  ])("refuses %s", (_label, message, extra, reason) => {
    expect(promptFromEvent(event("!oc do it", message, extra), gate, NOW)).toEqual({ ok: false, reason })
  })

  test("a phone clock a few seconds fast is not a future message", () => {
    expect(promptFromEvent(event("!oc do it", { timestamp: NOW + 5_000 }), gate, NOW)).toMatchObject({ ok: true, postedAt: NOW + 5_000 })
  })

  test("refuses a message the app would no longer let it answer", () => {
    const old = event("!oc do it", { timestamp: NOW - 600_000 }, { observed_at: NOW - 1_000 })
    expect(promptFromEvent(old, { ...gate, notBefore: NOW - 900_000 }, NOW)).toEqual({ ok: false, reason: "older than the reply window" })
  })
})

describe("one reply", () => {
  test("a short answer is the marker and the body", () => {
    expect(fitReply("  the answer \n", "[AI] ")).toBe("[AI] the answer")
  })

  test("a long answer is cut to fit, marked, and says so", () => {
    const reply = fitReply("word ".repeat(3_000), "[AI] ")
    expect(reply.length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT)
    expect(reply.startsWith("[AI] word")).toBe(true)
    expect(reply.endsWith(TRUNCATION_NOTE)).toBe(true)
  })

  test("never cuts through a surrogate pair", () => {
    const room = WHATSAPP_TEXT_LIMIT - "[AI] ".length - TRUNCATION_NOTE.length
    const body = "x".repeat(room - 1) + "😀".repeat(50)
    const reply = fitReply(body, "[AI] ")
    const kept = reply.slice("[AI] ".length, reply.length - TRUNCATION_NOTE.length)
    const last = kept.charCodeAt(kept.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
  })
})

describe("the app's reply operation", () => {
  const request: ReplyRequest = { capability_id: "cap", conversation_id: CONV, parent_message_id: "PID", text: "[AI] hi", request_id: "obx_abc123" }

  function sender(answer: () => unknown) {
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    const call: NativeCall = async (operation, payload) => {
      calls.push({ operation, payload })
      return answer()
    }
    return { calls, sender: nativeReplySender(call) }
  }

  test("sends exactly the five fields and reads back the provider id", async () => {
    const { calls, sender: s } = sender(() => ({ provider_message_id: "WAMID", state: "server_ack", send_request_id: "obx_abc123" }))
    expect(await s.reply(request)).toEqual({ kind: "sent", messageId: "WAMID", state: "server_ack" })
    expect(calls).toEqual([{ operation: "messages.reply", payload: { ...request } }])
  })

  test("anything but a confirmed send of this request is unknown", async () => {
    expect((await sender(() => ({ provider_message_id: "WAMID", state: "unknown", send_request_id: "obx_abc123" })).sender.reply(request)).kind).toBe("unknown")
    expect((await sender(() => ({ provider_message_id: "WAMID", state: "server_ack", send_request_id: "other" })).sender.reply(request)).kind).toBe("unknown")
    expect((await sender(() => ({ provider_message_id: null, state: "reserved", send_request_id: "obx_abc123" })).sender.reply(request)).kind).toBe("unknown")
  })

  test.each([
    ["UNTRUSTED_PARENT", "refused"],
    ["PARENT_CONSUMED", "refused"],
    ["REQUEST_CONFLICT", "refused"],
    ["CAPABILITY_REQUIRED", "refused"],
    ["INVALID_REQUEST", "refused"],
    ["REPLY_RATE_LIMIT", "rate_limited"],
    ["SERVICE_TIMEOUT", "unresolved"],
    ["SERVICE_UNAVAILABLE", "unresolved"],
    ["OPERATION_FAILED", "unresolved"],
    ["SOMETHING_NEW", "unresolved"],
  ])("%s is %s", async (code, kind) => {
    const { sender: s } = sender(() => {
      throw new NativeError(code)
    })
    expect(await s.reply(request)).toEqual({ kind, error: code } as ReplyOutcome)
  })
})

describe("the app's client module", () => {
  test("its codes come through, and anything else is OPERATION_FAILED", async () => {
    const dir = scratch()
    const path = join(dir, "client.cjs")
    writeFileSync(path, [
      "exports.call = async (operation, payload) => {",
      "  if (operation === 'coded') throw Object.assign(new Error('x'), { code: 'UNTRUSTED_PARENT' })",
      "  if (operation === 'plain') throw new Error('boom')",
      "  return { operation, payload }",
      "}",
    ].join("\n"))
    const call = nativeClient(path)
    expect(await call("messages.events", { limit: 1 })).toEqual({ operation: "messages.events", payload: { limit: 1 } })
    await expect(call("coded", {})).rejects.toMatchObject({ code: "UNTRUSTED_PARENT" })
    await expect(call("plain", {})).rejects.toMatchObject({ code: "OPERATION_FAILED" })
    writeFileSync(join(dir, "empty.cjs"), "exports.other = 1\n")
    expect(() => nativeClient(join(dir, "empty.cjs"))).toThrow("exports no call()")
  })
})

// -----------------------------------------------------------------------------
// The driver
// -----------------------------------------------------------------------------

class FakeRelay implements RelayPort {
  inbound: InboundRequest[] = []
  acks: AckRequest[] = []
  nacks: NackRequest[] = []
  uncertain: Array<{ outboxId: string; reason: string }> = []

  async handleInbound(request: InboundRequest): Promise<InboundResponse> {
    this.inbound.push(request)
    return { state: "accepted", relayId: `rly_${this.inbound.length}` }
  }
  async takeOutbox(): Promise<OutboxResponse> {
    await Bun.sleep(5)
    return { items: [], typingRooms: [] }
  }
  ack(request: AckRequest): boolean {
    this.acks.push(request)
    return true
  }
  nack(request: NackRequest): boolean {
    this.nacks.push(request)
    return true
  }
  markUncertain(outboxId: string, reason: string): boolean {
    this.uncertain.push({ outboxId, reason })
    return true
  }
}

/** The app's journal: `messages.events` from an opaque cursor, and nothing else. */
class FakeApp {
  events: any[] = []
  account = ACCOUNT
  generation = GEN
  calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
  call: NativeCall = async (operation, payload) => {
    this.calls.push({ operation, payload })
    if (operation !== "messages.events") throw new NativeError("UNEXPECTED_OPERATION")
    const after = Number(String(payload.cursor).slice("cur:".length))
    const page = this.events.filter((e) => e.sequence > after).slice(0, Number(payload.limit))
    return { account: this.account, generation: this.generation, events: page, cursor: `cur:${page.at(-1)?.sequence ?? after}` }
  }
}

interface Rig {
  dir: string
  app: FakeApp
  relay: FakeRelay
  driver: WhatsAppNativeDriver
  notices: Array<{ session: string; key: string; text: string }>
  replies: ReplyRequest[]
  outcomes: ReplyOutcome[]
  clock: { now: number }
  logs: string[]
  heldPath: (name: string) => string
}

async function rig(options: Partial<WhatsAppNativeOptions> = {}, existing?: Pick<Rig, "dir" | "app" | "relay" | "clock">): Promise<Rig> {
  const dir = existing?.dir ?? scratch()
  const head = join(dir, "reply-live-head.json")
  if (!existsSync(head)) {
    writeFileSync(head, JSON.stringify({ account: ACCOUNT, generation: GEN, cursor: "cur:19", high_water: 19, observed_at: HEAD_AT, live_head: true }))
  }
  const app = existing?.app ?? new FakeApp()
  const relay = existing?.relay ?? new FakeRelay()
  const clock = existing?.clock ?? { now: NOW }
  const notices: Rig["notices"] = []
  const replies: ReplyRequest[] = []
  const outcomes: ReplyOutcome[] = []
  const logs: string[] = []
  const stateDir = join(dir, "state", "whatsapp")
  mkdirSync(join(dir, "state"), { recursive: true, mode: 0o700 })
  const driver = new WhatsAppNativeDriver({
    relay,
    call: app.call,
    sender: {
      async reply(request) {
        replies.push(request)
        return outcomes.shift() ?? { kind: "sent", messageId: `WAMID${replies.length}`, state: "server_ack" }
      },
    },
    stateDir,
    headFile: head,
    groupJid: GROUP,
    conversationId: CONV,
    capabilityId: "cap-1",
    capabilityExpiresAt: NOW + 3_600_000,
    ownerSender: OWNER,
    aiPrefix: "[AI] ",
    hold: false,
    notify: async (session, key, text) => {
      notices.push({ session, key, text })
      return { kind: "delivered" }
    },
    releaseCommand: "bun src/relay/whatsapp-release.ts --config /x/relay.json",
    pollIntervalMs: 3_600_000,
    now: () => clock.now,
    log: (line) => logs.push(line),
    ...options,
  })
  drivers.push(driver)
  return { dir, app, relay, driver, notices, replies, outcomes, clock, logs, heldPath: (name) => join(stateDir, "held", `${name}.json`) }
}

function release(r: Rig, name: string): void {
  const release = join(r.dir, "state", "whatsapp", "release")
  renameSync(r.heldPath(name), join(release, `${name}.json`))
}

function done(r: Rig, name: string): HeldRecord {
  return JSON.parse(readFileSync(join(r.dir, "state", "whatsapp", "done", `${name}.json`), "utf8"))
}

describe("reading the app's journal", () => {
  test("starts at the live head, follows only its own cursor, and hands a fresh prompt on with its deadline", async () => {
    const r = await rig()
    const e = event("!oc hello")
    r.app.events.push(e)
    await r.driver.start()
    await until(() => r.relay.inbound.length === 1)
    expect(r.relay.inbound[0]).toEqual({
      route: "whatsapp",
      eventId: e.message.id,
      roomId: GROUP,
      threadRootId: "",
      sender: OWNER,
      postedAt: NOW - 6_000,
      text: "hello",
      implicit: false,
      replyBy: NOW - 6_000 + 600_000 - 30_000,
    })
    expect(r.app.calls.every((c) => c.operation === "messages.events")).toBe(true)
    expect(r.app.calls[0].payload).toEqual({ conversation_id: CONV, cursor: "cur:19", limit: 100 })
    await until(() => JSON.parse(readFileSync(join(r.dir, "state", "whatsapp", "driver.json"), "utf8")).cursor === `cur:${e.sequence}`)
  })

  test("history, other participants, echoes and ciphertext are never prompts", async () => {
    const r = await rig()
    r.app.events.push(
      event("!oc a", {}, { origin: "history" }),
      event("!oc b", { from_me: false, trusted_self: false }),
      event("[AI] c", { send_request_id: "obx_1" }),
      event(null, { type: "ciphertext" }),
    )
    await r.driver.start()
    await until(() => r.app.calls.length >= 1)
    await Bun.sleep(30)
    expect(r.relay.inbound).toEqual([])
  })

  test("a restart follows its own cursor, not the head record", async () => {
    const first = await rig()
    const e = event("!oc one")
    first.app.events.push(e)
    await first.driver.start()
    await until(() => first.relay.inbound.length === 1)
    first.driver.stop()
    writeFileSync(join(first.dir, "reply-live-head.json"), JSON.stringify({ account: ACCOUNT, generation: GEN, cursor: "cur:0", high_water: 0, observed_at: 0, live_head: true }))
    const second = await rig({}, first)
    first.app.calls.length = 0
    await second.driver.start()
    await until(() => first.app.calls.length >= 1)
    expect(first.app.calls[0].payload.cursor).toBe(`cur:${e.sequence}`)
  })

  test("a different account stops the route", async () => {
    const r = await rig()
    r.app.account = `a_${"9".repeat(64)}`
    r.app.events.push(event("!oc hello"))
    await r.driver.start()
    await until(() => r.driver.health().halted !== null)
    expect(r.relay.inbound).toEqual([])
  })
})

describe("hold and release", () => {
  test("a prompt is held in a private record before the cursor moves, and announced by path only", async () => {
    const r = await rig({ hold: true, notifySessions: ["ses_native", "ses_operator"], coordinatorSession: "ses_coordinator" })
    const e = event("!oc the secret words")
    r.app.events.push(e)
    await r.driver.start()
    const name = `s${e.sequence}`
    await until(() => r.notices.length === 3)
    expect(r.relay.inbound).toEqual([])
    const record: HeldRecord = JSON.parse(readFileSync(r.heldPath(name), "utf8"))
    expect(record).toMatchObject({ name, verdict: "prompt", reason: null, sequence: e.sequence, origin: "live", generation: GEN, invalidated: null })
    expect(record.message["id"]).toBe(e.message.id)
    expect(record.prompt?.text).toBe("the secret words")
    expect(statSync(r.heldPath(name)).mode & 0o777).toBe(0o600)
    expect(statSync(join(r.dir, "state", "whatsapp", "held")).mode & 0o777).toBe(0o700)
    const toPeople = r.notices.filter((n) => n.key.startsWith("ai-bridge-relay:held:"))
    expect(toPeople.map((n) => n.session).sort()).toEqual(["ses_native", "ses_operator"])
    for (const notice of r.notices) {
      expect(notice.text).not.toContain(e.message.id)
      expect(notice.text).not.toContain("secret words")
      expect(notice.text).not.toContain(GROUP)
    }
    expect(toPeople[0].text).toContain(r.heldPath(name))
    expect(toPeople[0].text).toContain(`Release after verification: bun src/relay/whatsapp-release.ts --config /x/relay.json ${name}`)
    const wake = r.notices.find((n) => n.session === "ses_coordinator")!
    expect(wake.key).toBe(`ai-bridge-relay:wake:${name}`)
    expect(wake.text).toContain("NO_REPLY")
  })

  test("an own message that is not a prompt is held with its reason, and cannot be released", async () => {
    const r = await rig({ hold: true })
    const e = event("just chatting")
    r.app.events.push(e)
    await r.driver.start()
    const name = `s${e.sequence}`
    await until(() => existsSync(r.heldPath(name)))
    expect(JSON.parse(readFileSync(r.heldPath(name), "utf8"))).toMatchObject({ verdict: "not-a-prompt", reason: "no trigger", prompt: null })
    release(r, name)
    await r.driver.processReleases()
    expect(done(r, name).released?.outcome).toBe("refused: the relay's verdict was not a prompt")
    expect(r.relay.inbound).toEqual([])
  })

  test("a release hands the held prompt on with its deadline", async () => {
    const r = await rig({ hold: true })
    const e = event("!oc go")
    r.app.events.push(e)
    await r.driver.start()
    const name = `s${e.sequence}`
    await until(() => existsSync(r.heldPath(name)))
    release(r, name)
    await r.driver.processReleases()
    expect(r.relay.inbound).toEqual([expect.objectContaining({ eventId: e.message.id, text: "go", replyBy: NOW - 6_000 + 570_000 })])
    expect(done(r, name).released?.outcome).toBe("accepted rly_1")
  })

  test("a release with too little time left is refused: that needs a new owner message", async () => {
    const r = await rig({ hold: true })
    const e = event("!oc late")
    r.app.events.push(e)
    await r.driver.start()
    const name = `s${e.sequence}`
    await until(() => existsSync(r.heldPath(name)))
    r.clock.now = NOW - 6_000 + 570_000 - 60_000
    release(r, name)
    await r.driver.processReleases()
    expect(done(r, name).released?.outcome).toBe("refused: 60s left before the reply deadline; a new owner message is needed")
    expect(r.relay.inbound).toEqual([])
  })

  test.each([
    ["an edit", (e: any) => ({ ...event(null), kind: "edit", message: { ...e.message, text: "!oc changed", revision: "x" } }), "the message was edited"],
    ["a delete", (e: any) => ({ ...event(null), kind: "delete", message: { ...e.message, deleted: true } }), "the message was deleted"],
    ["a gap", () => ({ sequence: ++seq, kind: "gap", reason: "collection_failed", generation: GEN, observed_at: NOW }), "a journal gap followed it"],
    ["a second plaintext observation", (e: any) => ({ ...event(null), message: { ...e.message } }), "a second plaintext observation of the same message"],
    ["a new generation", () => ({ sequence: ++seq, kind: "reset", reason: "generation_changed", generation: GEN2, observed_at: NOW }), "the app started a new generation"],
  ])("%s after it means a held prompt can no longer be answered", async (_label, after, reason) => {
    const r = await rig({ hold: true })
    const e = event("!oc first")
    r.app.events.push(e)
    await r.driver.start()
    const name = `s${e.sequence}`
    await until(() => existsSync(r.heldPath(name)))
    r.app.events.push(after(e))
    await r.driver.pollOnce()
    expect(JSON.parse(readFileSync(r.heldPath(name), "utf8")).invalidated?.reason).toBe(reason)
    release(r, name)
    await r.driver.processReleases()
    expect(done(r, name).released?.outcome).toBe(`refused: it can no longer be answered: ${reason}`)
    expect(r.relay.inbound).toEqual([])
  })

  test("acks change nothing, and a ciphertext observation before the plaintext is not ambiguous", async () => {
    const r = await rig({ hold: true })
    const cipher = event(null, { type: "ciphertext" })
    const plain = { ...event("!oc fine"), message: { ...cipher.message, type: "chat", text: "!oc fine" } }
    r.app.events.push(cipher, plain, { ...event(null), kind: "ack", message: { ...plain.message, ack: 2 } })
    await r.driver.start()
    const name = `s${plain.sequence}`
    await until(() => existsSync(r.heldPath(name)))
    await r.driver.pollOnce()
    expect(existsSync(r.heldPath(`s${cipher.sequence}`))).toBe(false)
    expect(JSON.parse(readFileSync(r.heldPath(name), "utf8"))).toMatchObject({ verdict: "prompt", invalidated: null })
  })

  test("reading a page again after a crash does not invalidate what followed a gap", async () => {
    const r = await rig({ hold: true })
    const gap = { sequence: ++seq, kind: "gap", reason: "collector_started", generation: GEN, observed_at: NOW - 7_000 }
    const e = event("!oc after the gap")
    r.app.events.push(gap, e)
    await r.driver.start()
    const name = `s${e.sequence}`
    await until(() => existsSync(r.heldPath(name)))
    r.driver.stop()
    const statePath = join(r.dir, "state", "whatsapp", "driver.json")
    await until(() => JSON.parse(readFileSync(statePath, "utf8")).cursor === `cur:${e.sequence}`)
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), cursor: `cur:${gap.sequence - 1}` }), { mode: 0o600 })
    const again = await rig({ hold: true }, r)
    await again.driver.start()
    await again.driver.pollOnce()
    expect(JSON.parse(readFileSync(r.heldPath(name), "utf8")).invalidated).toBeNull()
  })
})

describe("the held-message verifier", () => {
  const verifier = { command: ["/native/verifier", "--config", "/native/config.json"], timeoutMs: 45_000 }

  function exited(code: number, output: string): VerifierRun {
    return { kind: "exit", code, signal: null, output, lines: output.split("\n").filter((line) => line.trim()).length, bytes: Buffer.byteLength(output) }
  }

  function pending() {
    let finish: (result: VerifierRun) => void = () => { throw new Error("verifier not started") }
    const result = new Promise<VerifierRun>((resolve) => { finish = resolve })
    const commands: Array<{ command: readonly string[]; timeoutMs: number }> = []
    const runVerifier: VerifierRunner = async (command, timeoutMs) => {
      commands.push({ command, timeoutMs })
      return result
    }
    return { commands, runVerifier, finish }
  }

  function record(r: Rig, name: string): HeldRecord {
    return JSON.parse(readFileSync(r.heldPath(name), "utf8"))
  }

  test("runs after the private write without blocking polling or sending early notices, then releases through the queue", async () => {
    const child = pending()
    const r = await rig({ hold: true, verifier, runVerifier: child.runVerifier, notifySessions: ["ses_native", "ses_operator"], coordinatorSession: "ses_coordinator" })
    const e = event("!oc verifier happy path")
    const name = `s${e.sequence}`
    r.app.events.push(e)
    await r.driver.start()
    await until(() => child.commands.length === 1)
    expect(record(r, name).verification).toBeUndefined()
    expect(statSync(r.heldPath(name)).mode & 0o777).toBe(0o600)
    expect(child.commands).toEqual([{ command: [...verifier.command, name], timeoutMs: 45_000 }])
    expect(r.notices).toEqual([])
    expect(r.driver.health().verifier).toEqual({ configured: true, lastOutcome: null, lastAt: null })
    await r.driver.pollOnce()
    expect(child.commands).toHaveLength(1)
    let queued: HeldRecord | undefined
    r.relay.handleInbound = async (request) => {
      queued = JSON.parse(readFileSync(join(r.dir, "state", "whatsapp", "release", `${name}.json`), "utf8"))
      r.relay.inbound.push(request)
      return { state: "accepted", relayId: "rly_1" }
    }
    child.finish(exited(0, `verified ${name}\n`))
    await until(() => existsSync(join(r.dir, "state", "whatsapp", "done", `${name}.json`)))
    expect(queued?.verification).toEqual({ at: new Date(NOW).toISOString(), outcome: "verified", line: `verified ${name}`, reason: null })
    expect(r.relay.inbound).toEqual([expect.objectContaining({ eventId: e.message.id, text: "verifier happy path", replyBy: NOW - 6_000 + 570_000 })])
    expect(existsSync(r.heldPath(name))).toBe(false)
    expect(r.notices.map((notice) => notice.key).sort()).toEqual([`ai-bridge-relay:held:${name}:ses_native`, `ai-bridge-relay:held:${name}:ses_operator`])
    for (const notice of r.notices) {
      expect(notice.text.startsWith("[ai-bridge-relay notice: automated,")).toBe(true)
      expect(notice.text).toContain(join(r.dir, "state", "whatsapp", "release", `${name}.json`))
      expect(notice.text).toContain(join(r.dir, "state", "whatsapp", "done", `${name}.json`))
      expect(notice.text).not.toContain(r.heldPath(name))
      expect(notice.text).toContain(`verified ${name}`)
      expect(notice.text).toContain("Action: released")
      expect(notice.text).not.toContain("whatsapp-release.ts")
      expect(notice.text).not.toContain(e.message.id)
      expect(notice.text).not.toContain("verifier happy path")
    }
    expect(r.driver.health().verifier).toEqual({ configured: true, lastOutcome: "verified", lastAt: new Date(NOW).toISOString() })
  })

  test("verification never bypasses the minimum release window", async () => {
    const child = pending()
    const r = await rig({ hold: true, verifier, runVerifier: child.runVerifier })
    const e = event("!oc late verification")
    const name = `s${e.sequence}`
    r.app.events.push(e)
    await r.driver.start()
    await until(() => child.commands.length === 1)
    r.clock.now = NOW - 6_000 + 570_000 - 60_000
    child.finish(exited(0, `verified ${name}`))
    await until(() => existsSync(join(r.dir, "state", "whatsapp", "done", `${name}.json`)))
    expect(done(r, name).released?.outcome).toBe("refused: 60s left before the reply deadline; a new owner message is needed")
    expect(r.relay.inbound).toEqual([])
  })

  test.each(["edit", "gap", "generation"])("verification never bypasses a concurrent %s invalidation", async (change) => {
    const child = pending()
    const r = await rig({ hold: true, verifier, runVerifier: child.runVerifier, pageLimit: 1 })
    const e = event("!oc changed during verification")
    const name = `s${e.sequence}`
    r.app.events.push(e)
    await r.driver.start()
    await until(() => child.commands.length === 1)
    r.app.events.push(change === "edit"
      ? { ...event(null), kind: "edit", message: e.message }
      : { sequence: ++seq, kind: "gap", reason: "test", generation: change === "generation" ? GEN2 : GEN, observed_at: NOW })
    child.finish(exited(0, `verified ${name}`))
    await until(() => existsSync(join(r.dir, "state", "whatsapp", "done", `${name}.json`)))
    expect(done(r, name).released?.outcome.startsWith("refused:")).toBe(true)
    expect(r.relay.inbound).toEqual([])
  })

  test("a refusal persists its verdict before discarding, without prompting or waking", async () => {
    const e = event("!oc refused")
    const name = `s${e.sequence}`
    const r = await rig({ hold: true, verifier, runVerifier: async () => exited(1, `refuse ${name}: policy (owner-only)`), notifySessions: ["ses_native"], coordinatorSession: "ses_coordinator" })
    r.app.events.push(e)
    await r.driver.start()
    const discarded = join(r.dir, "state", "whatsapp", "discarded", `${name}.json`)
    await until(() => existsSync(discarded))
    expect(JSON.parse(readFileSync(discarded, "utf8")).verification).toMatchObject({ outcome: "refused", line: `refuse ${name}: policy (owner-only)`, reason: null })
    expect(existsSync(r.heldPath(name))).toBe(false)
    expect(r.relay.inbound).toEqual([])
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0].text).toContain("Action: discarded")
    expect(r.notices[0].text).not.toContain("whatsapp-release.ts")
  })

  test("unavailable stays held, sends both operator commands and wakes only after the outcome", async () => {
    const child = pending()
    const r = await rig({ hold: true, verifier, runVerifier: child.runVerifier, notifySessions: ["ses_native"], coordinatorSession: "ses_coordinator" })
    const e = event("!oc unavailable")
    const name = `s${e.sequence}`
    r.app.events.push(e)
    await r.driver.start()
    await until(() => child.commands.length === 1)
    expect(r.notices).toEqual([])
    child.finish(exited(2, `unavailable ${name}: app busy`))
    await until(() => r.notices.length === 2)
    expect(record(r, name).verification).toMatchObject({ outcome: "unavailable", line: `unavailable ${name}: app busy`, reason: null })
    expect(r.notices[0].key).toBe(`ai-bridge-relay:held:${name}:ses_native`)
    expect(r.notices[0].text).toContain("Action: still held")
    expect(r.notices[0].text).toContain(`bun src/relay/whatsapp-release.ts --config /x/relay.json ${name}`)
    expect(r.notices[0].text).toContain(`bun src/relay/whatsapp-release.ts --config /x/relay.json ${name} --discard`)
    expect(r.notices[1].key).toBe(`ai-bridge-relay:wake:${name}`)
    expect(r.relay.inbound).toEqual([])
  })

  test.each([
    ["wrong record", 0, "verified s999999999", null],
    ["two lines", 0, "verified NAME\n1234567890@g.us secret text", null],
    ["unknown exit", 3, "1234567890@g.us secret text", "exit 3"],
    ["unrecognized line", 0, "1234567890@g.us secret text", null],
    ["no output", 0, " \n\t", null],
    ["wrong refusal record", 1, "refuse s999999999: policy", null],
    ["unsafe unavailable reason", 2, "unavailable NAME: 1234567890@g.us secret text", null],
  ])("%s is inconclusive, with no raw output retained or forwarded", async (_label, code, raw, reason) => {
    const e = event("!oc held")
    const name = `s${e.sequence}`
    const output = raw.replace("NAME", name)
    const result = exited(code, output)
    const r = await rig({ hold: true, verifier, runVerifier: async () => result, notifySessions: ["ses_native"], coordinatorSession: "ses_coordinator" })
    r.app.events.push(e)
    await r.driver.start()
    await until(() => r.notices.length === 2)
    const expected = reason ?? `output not recognized (${output.split("\n").filter((line) => line.trim()).length} lines, ${Buffer.byteLength(output)} bytes)`
    expect(record(r, name).verification).toEqual({ at: new Date(NOW).toISOString(), outcome: "inconclusive", line: null, reason: expected })
    const exposed = JSON.stringify({ logs: r.logs, notices: r.notices, stored: record(r, name) })
    expect(exposed).not.toContain("1234567890@g.us secret text")
    expect(exposed).not.toContain("s999999999")
    expect(r.notices[0].text).toContain(expected)
    expect(r.notices[0].text).toContain("Action: still held")
    expect(r.notices[1].key).toBe(`ai-bridge-relay:wake:${name}`)
    expect(r.relay.inbound).toEqual([])
  })

  test.each([true, false])("hold=%s never verifies a not-a-prompt record or a live prompt", async (hold) => {
    let calls = 0
    const r = await rig({ hold, verifier, runVerifier: async () => { calls++; return exited(3, "") } })
    const e = event(hold ? "ordinary chat" : "!oc live prompt")
    r.app.events.push(e)
    await r.driver.start()
    await r.driver.pollOnce()
    expect(calls).toBe(0)
    if (hold) expect(record(r, `s${e.sequence}`).verdict).toBe("not-a-prompt")
    else expect(r.relay.inbound).toHaveLength(1)
  })

  test("restart verifies an unverified held record, but never reruns its recorded outcome", async () => {
    const first = await rig({ hold: true })
    const e = event("!oc restart")
    const name = `s${e.sequence}`
    first.app.events.push(e)
    await first.driver.start()
    await until(() => existsSync(first.heldPath(name)))
    first.driver.stop()
    let calls = 0
    const options = { hold: true, verifier, notifySessions: ["ses_native"], runVerifier: async () => { calls++; return exited(2, `unavailable ${name}: offline`) } }
    const second = await rig(options, first)
    await second.driver.start()
    await until(() => second.notices.length === 1)
    second.driver.stop()
    const third = await rig(options, first)
    await third.driver.start()
    await until(() => third.notices.length === 1)
    await third.driver.pollOnce()
    expect(calls).toBe(1)
    expect(record(third, name).verification?.outcome).toBe("unavailable")
  })

  test("restart completes a recorded verified rename without running the verifier again", async () => {
    const first = await rig({ hold: true })
    const e = event("!oc recovered release")
    const name = `s${e.sequence}`
    first.app.events.push(e)
    await first.driver.start()
    await until(() => existsSync(first.heldPath(name)))
    first.driver.stop()
    writeFileSync(first.heldPath(name), JSON.stringify({ ...record(first, name), verification: { at: new Date(NOW).toISOString(), outcome: "verified", line: `verified ${name}`, reason: null } }), { mode: 0o600 })
    let calls = 0
    const second = await rig({ hold: true, verifier, runVerifier: async () => { calls++; return exited(3, "") } }, first)
    await second.driver.start()
    await until(() => existsSync(join(second.dir, "state", "whatsapp", "done", `${name}.json`)))
    expect(calls).toBe(0)
    expect(second.relay.inbound).toHaveLength(1)
  })

  test("a real executable receives argv with the record last, ignored stdin and the relay environment", async () => {
    const dir = scratch()
    const script = join(dir, "verify.sh")
    writeFileSync(script, '#!/bin/sh\n[ "$1" = "--config" ] && [ "$2" = "/synthetic/config.json" ] && [ -n "$PATH" ] || exit 3\nif read -r input; then exit 3; fi\nprintf "  verified %s  \\n" "$3" >&2\n', { mode: 0o700 })
    const r = await rig({ hold: true, verifier: { command: [script, "--config", "/synthetic/config.json"], timeoutMs: 1_000 } })
    const e = event("!oc spawned")
    r.app.events.push(e)
    await r.driver.start()
    await until(() => existsSync(join(r.dir, "state", "whatsapp", "done", `s${e.sequence}.json`)))
    expect(done(r, `s${e.sequence}`).verification?.outcome).toBe("verified")
    expect(r.relay.inbound).toHaveLength(1)
  })

  test("a real timeout terminates then kills the child, remains held and wakes the coordinator", async () => {
    const dir = scratch()
    const script = join(dir, "timeout.sh")
    const pidFile = join(dir, "pid")
    writeFileSync(script, '#!/bin/sh\ntrap "" TERM\nprintf "%s" "$$" > "$1"\nexec /bin/sleep 60\n', { mode: 0o700 })
    const r = await rig({ hold: true, verifier: { command: [script, pidFile], timeoutMs: 1_000 }, notifySessions: ["ses_native"], coordinatorSession: "ses_coordinator" })
    const e = event("!oc timeout")
    r.app.events.push(e)
    await r.driver.start()
    await until(() => existsSync(pidFile))
    const pid = Number(readFileSync(pidFile, "utf8"))
    expect(() => process.kill(pid, 0)).not.toThrow()
    await until(() => r.notices.length === 2)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(record(r, `s${e.sequence}`).verification).toMatchObject({ outcome: "inconclusive", line: null, reason: "timed out" })
    expect(r.relay.inbound).toEqual([])
  })

  test("a missing executable is inconclusive with only its errno", async () => {
    const r = await rig({ hold: true, verifier: { command: [join(scratch(), "missing")], timeoutMs: 1_000 }, notifySessions: ["ses_native"] })
    const e = event("!oc missing")
    r.app.events.push(e)
    await r.driver.start()
    await until(() => r.notices.length === 1)
    expect(record(r, `s${e.sequence}`).verification).toMatchObject({ outcome: "inconclusive", line: null, reason: "spawn failed: ENOENT" })
    expect(r.notices[0].text).toContain("spawn failed: ENOENT")
  })

  test("the real capture counts both streams and caps their total at 8 KiB", async () => {
    const script = join(scratch(), "output.sh")
    writeFileSync(script, '#!/bin/sh\nprintf "verified s20\\n"\nprintf "1234567890@g.us secret text\\n" >&2\n', { mode: 0o700 })
    const result = await spawnVerifier([script, "s20"], 1_000)
    expect(result).toMatchObject({ kind: "exit", lines: 2 })
    expect(verifierVerdict(result, "s20")).toMatchObject({ outcome: "inconclusive", line: null })
    writeFileSync(script, '#!/bin/sh\nprintf "verified s20\\n"\n/bin/head -c 9000 /dev/zero | /usr/bin/tr "\\000" " " >&2\n', { mode: 0o700 })
    const overflow = await spawnVerifier([script, "s20"], 1_000)
    if (overflow.kind !== "exit") throw new Error("script did not exit")
    expect(overflow.bytes).toBeGreaterThan(8_192)
    expect(Buffer.byteLength(overflow.output)).toBeLessThanOrEqual(8_193)
    expect(verifierVerdict(overflow, "s20")).toMatchObject({ outcome: "inconclusive", line: null })
  })

  test("a real signal exit records only the signal name", async () => {
    const script = join(scratch(), "signal.sh")
    writeFileSync(script, '#!/bin/sh\nprintf "1234567890@g.us secret text\\n"\nkill -TERM "$$"\n', { mode: 0o700 })
    const r = await rig({ hold: true, verifier: { command: [script], timeoutMs: 1_000 }, notifySessions: ["ses_native"] })
    const e = event("!oc signaled")
    r.app.events.push(e)
    await r.driver.start()
    await until(() => r.notices.length === 1)
    expect(record(r, `s${e.sequence}`).verification).toMatchObject({ outcome: "inconclusive", line: null, reason: "signal SIGTERM" })
    expect(JSON.stringify({ notices: r.notices, logs: r.logs, record: record(r, `s${e.sequence}`) })).not.toContain("1234567890@g.us secret text")
  })
})

describe("delivering the reply", () => {
  function item(extra: Partial<OutboxItem> = {}): OutboxItem {
    return { outboxId: "obx_abc123", txnId: "aibr-obx_abc123", roomId: GROUP, threadRootId: "PID", replyToEventId: "PID", text: "the answer", kind: "reply", replyBy: NOW + 60_000, ...extra }
  }

  test("one reply, frozen before it is sent, bound to the owner's message", async () => {
    const r = await rig()
    await r.driver.start()
    await r.driver.deliver(item())
    expect(r.replies).toEqual([{ capability_id: "cap-1", conversation_id: CONV, parent_message_id: "PID", text: "[AI] the answer", request_id: "obx_abc123" }])
    expect(r.relay.acks).toEqual([{ outboxId: "obx_abc123", chatEventId: "WAMID1" }])
    expect(statSync(join(r.dir, "state", "whatsapp", "replies", "obx_abc123.json")).mode & 0o777).toBe(0o600)
  })

  test("an unresolved attempt replays the frozen request, and three of them are unknown", async () => {
    const r = await rig()
    await r.driver.start()
    r.outcomes.push(
      { kind: "unresolved", error: "SERVICE_TIMEOUT" },
      { kind: "unresolved", error: "OPERATION_FAILED" },
      { kind: "unresolved", error: "SERVICE_UNAVAILABLE" },
    )
    await r.driver.deliver(item())
    expect(r.relay.nacks).toEqual([{ outboxId: "obx_abc123", error: "SERVICE_TIMEOUT", definite: false }])
    await r.driver.deliver(item({ text: "a different answer, read again after a restart" }))
    await r.driver.deliver(item())
    expect(r.replies).toHaveLength(3)
    expect(new Set(r.replies.map((q) => JSON.stringify(q))).size).toBe(1)
    expect(r.relay.uncertain).toHaveLength(1)
    await r.driver.deliver(item())
    expect(r.replies).toHaveLength(3)
    expect(r.relay.uncertain).toHaveLength(2)
  })

  test("a rate limit inside the deadline goes again; past it, it is refused", async () => {
    const r = await rig()
    await r.driver.start()
    r.outcomes.push({ kind: "rate_limited", error: "REPLY_RATE_LIMIT" }, { kind: "rate_limited", error: "REPLY_RATE_LIMIT" })
    await r.driver.deliver(item())
    expect(r.relay.nacks.at(-1)).toMatchObject({ definite: false })
    r.clock.now = NOW + 60_000
    await r.driver.deliver(item())
    expect(r.relay.nacks.at(-1)).toMatchObject({ definite: true, error: "rate limited until past the reply deadline" })
  })

  test("a refusal and an unknown outcome are final", async () => {
    const r = await rig()
    await r.driver.start()
    r.outcomes.push({ kind: "refused", error: "UNTRUSTED_PARENT" }, { kind: "unknown", error: "reply state unknown" })
    await r.driver.deliver(item())
    await r.driver.deliver(item())
    expect(r.replies).toHaveLength(1)
    expect(r.relay.nacks).toEqual([
      { outboxId: "obx_abc123", error: "UNTRUSTED_PARENT", definite: true },
      { outboxId: "obx_abc123", error: "UNTRUSTED_PARENT", definite: true },
    ])
    await r.driver.deliver(item({ outboxId: "obx_def456", replyToEventId: "PID2" }))
    expect(r.relay.uncertain).toEqual([{ outboxId: "obx_def456", reason: "reply state unknown" }])
  })

  test("an owner message gets one reply: a second one is never attempted", async () => {
    const r = await rig()
    await r.driver.start()
    await r.driver.deliver(item())
    await r.driver.deliver(item({ outboxId: "obx_second", kind: "notice", text: "late notice" }))
    expect(r.replies).toHaveLength(1)
    expect(r.relay.nacks).toEqual([{ outboxId: "obx_second", error: "that owner message already has its one reply", definite: true }])
  })

  test("never sent without an owner message, without a deadline, or once the deadline passed", async () => {
    const r = await rig()
    await r.driver.start()
    await r.driver.deliver(item({ outboxId: "obx_a", replyToEventId: "" }))
    await r.driver.deliver(item({ outboxId: "obx_b", replyToEventId: "P2", replyBy: undefined }))
    await r.driver.deliver(item({ outboxId: "obx_c", replyToEventId: "P3", replyBy: NOW }))
    expect(r.replies).toEqual([])
    expect(r.relay.nacks.map((n) => [n.outboxId, n.definite])).toEqual([["obx_a", true], ["obx_b", true], ["obx_c", true]])
  })

  test("a long answer is cut to one message", async () => {
    const r = await rig()
    await r.driver.start()
    await r.driver.deliver(item({ text: "x".repeat(10_000) }))
    expect(r.replies[0].text.length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT)
    expect(r.replies[0].text.startsWith("[AI] x")).toBe(true)
  })
})

describe("the release command", () => {
  test("moves a held record to release or discarded, and refuses anything not held", () => {
    const dir = scratch()
    const stateDir = join(dir, "state")
    for (const sub of ["held", "release"]) mkdirSync(join(stateDir, "whatsapp", sub), { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, "whatsapp", "held", "s20.json"), "{}", { mode: 0o600 })
    writeFileSync(join(stateDir, "whatsapp", "held", "s21.json"), "{}", { mode: 0o600 })
    const config = join(dir, "relay.json")
    writeFileSync(config, JSON.stringify({
      socketPath: join(dir, "relay.sock"),
      stateDir,
      vibetermApi: { secretsModule: "/nonexistent/index.ts" },
      routes: { whatsapp: { enabled: false, sessionID: "ses_abc" } },
    }))
    const run = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../../src/relay/whatsapp-release.ts"), "--config", config, ...args])
    expect(run("s20").exitCode).toBe(0)
    expect(existsSync(join(stateDir, "whatsapp", "release", "s20.json"))).toBe(true)
    expect(run("--discard", "s21").exitCode).toBe(0)
    expect(existsSync(join(stateDir, "whatsapp", "discarded", "s21.json"))).toBe(true)
    expect(run("s20").exitCode).toBe(1)
    expect(run("nope").exitCode).toBe(2)

    writeFileSync(join(stateDir, "whatsapp", "held", "s22.json"), "{}", { mode: 0o600 })
    const fromEnv = Bun.spawnSync(["bun", join(import.meta.dir, "../../src/relay/whatsapp-release.ts"), "s22"], {
      env: { ...process.env, AI_BRIDGE_RELAY_CONFIG: config },
    })
    expect(fromEnv.exitCode).toBe(0)
    expect(existsSync(join(stateDir, "whatsapp", "release", "s22.json"))).toBe(true)
  })
})
