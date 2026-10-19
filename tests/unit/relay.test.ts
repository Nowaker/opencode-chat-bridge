import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RelayClient } from "../../src/relay/client"
import { parseRelayId } from "../../src/relay/prompt"
import { Relay, type RelayApi, type RouteConfig } from "../../src/relay/relay"
import { parseInbound, startRelayServer } from "../../src/relay/server"
import type { ApiMessage } from "../../src/relay/turns"
import type { InboundRequest } from "../../src/relay/types"
import type { PromptOutcome } from "../../src/relay/vibeterm-api"

// Every journal record is written synchronously; on a loaded host that is slow.
setDefaultTimeout(30_000)

const SESSION = "ses_matrixcoordinator"
const ROOM = "!room:example.org"
const OWNER = "@owner:example.org"

type Outcome = PromptOutcome | ((text: string) => PromptOutcome)

class FakeApi implements RelayApi {
  prompts: Array<{ sessionID: string; key: string; text: string }> = []
  outcomes: Outcome[] = []
  messageReads = 0
  private readonly transcripts = new Map<string, ApiMessage[]>()
  private seq = 0

  private list(sessionID: string): ApiMessage[] {
    let list = this.transcripts.get(sessionID)
    if (!list) this.transcripts.set(sessionID, (list = []))
    return list
  }

  private id(prefix: string): string {
    return `${prefix}_${String(++this.seq).padStart(6, "0")}`
  }

  addUser(text: string, sessionID = SESSION): string {
    const id = this.id("msg_u")
    this.list(sessionID).push({ info: { id, role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text }] })
    return id
  }

  addAssistant(parentID: string, opts: { text?: string; finish?: string; error?: unknown } = {}, sessionID = SESSION): string {
    const id = this.id("msg_a")
    const created = Date.now() + 5
    this.list(sessionID).push({
      info: {
        id,
        role: "assistant",
        parentID,
        ...(opts.finish === undefined ? {} : { finish: opts.finish }),
        ...(opts.error === undefined ? {} : { error: opts.error }),
        time: { created, completed: created + 1 },
      },
      parts: opts.text === undefined ? [] : [{ type: "text", text: opts.text }],
    })
    return id
  }

  lastUser(sessionID = SESSION): string {
    const users = this.list(sessionID).filter((m) => m.info["role"] === "user")
    return String(users[users.length - 1]?.info["id"])
  }

  async promptAsync(sessionID: string, key: string, text: string): Promise<PromptOutcome> {
    this.prompts.push({ sessionID, key, text })
    const next = this.outcomes.shift()
    if (next) return typeof next === "function" ? next(text) : next
    return { kind: "delivered", messageId: this.addUser(text, sessionID) }
  }

  async messages(sessionID: string, limit: number): Promise<ApiMessage[]> {
    return this.list(sessionID).slice(-limit)
  }

  async message(sessionID: string, messageID: string): Promise<ApiMessage | null> {
    this.messageReads++
    return this.list(sessionID).find((m) => m.info["id"] === messageID) ?? null
  }
}

const dirs: string[] = []
const relays: Relay[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const relay of relays.splice(0)) relay.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Setup {
  dir?: string
  route?: Partial<RouteConfig>
  options?: Partial<ConstructorParameters<typeof Relay>[1]>
}

async function startRelay(api: FakeApi, setup: Setup = {}): Promise<{ relay: Relay; dir: string }> {
  const dir = setup.dir ?? scratch()
  const relay = new Relay(api, {
    stateDir: dir,
    routes: {
      matrix: {
        enabled: true,
        sessionID: SESSION,
        allowedUsers: [OWNER],
        allowedRooms: [ROOM],
        defaultRoom: ROOM,
        repliesOnly: false,
        idsInPrompt: true,
        chatLabel: "Test room",
        ...setup.route,
      },
    },
    pollIntervalMs: 3_600_000,
    retryDelaysMs: [5, 5, 5],
    uncertainSettleMs: 20,
    claimLeaseMs: 400,
    syncJournal: false,
    resendWindowMs: 60_000,
    nackBackoffMs: 10,
    log: () => {},
    ...setup.options,
  })
  relays.push(relay)
  await relay.start()
  return { relay, dir }
}

function message(eventId: string, text: string, extra: Partial<InboundRequest> = {}): InboundRequest {
  return { route: "matrix", eventId, roomId: ROOM, threadRootId: "", sender: OWNER, postedAt: Date.now(), text, implicit: false, ...extra }
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}

describe("inbound", () => {
  test("delivers an allowlisted message once, under a key derived from its relay id", async () => {
    const api = new FakeApi()
    const { relay, dir } = await startRelay(api)
    const first = await relay.handleInbound(message("$e1", "hello"))
    expect(first.state).toBe("accepted")
    await until(() => relay.state.relays.get(first.relayId!)?.dispatch === "delivered")

    expect(api.prompts).toHaveLength(1)
    expect(api.prompts[0].key).toBe(`ai-bridge-relay:${first.relayId}`)
    expect(api.prompts[0].sessionID).toBe(SESSION)
    expect(api.prompts[0].text.startsWith("[chat_relay]\n")).toBe(true)
    expect(api.prompts[0].text.endsWith("\n\nhello")).toBe(true)
    expect(parseRelayId(api.prompts[0].text)).toBe(first.relayId!)
    expect(readdirSync(join(dir, "pending"))).toEqual([])

    const again = await relay.handleInbound(message("$e1", "hello"))
    expect(again).toEqual({ state: "duplicate", relayId: first.relayId })
    await Bun.sleep(20)
    expect(api.prompts).toHaveLength(1)
  })

  test("refuses a chat, sender or route nobody allowlisted", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    expect((await relay.handleInbound(message("$e1", "x", { roomId: "!other:example.org" }))).state).toBe("rejected")
    expect((await relay.handleInbound(message("$e2", "x", { sender: "@stranger:example.org" }))).state).toBe("rejected")
    expect((await relay.handleInbound(message("$e3", "x", { route: "whatsapp" }))).state).toBe("rejected")
    expect(api.prompts).toHaveLength(0)
  })

  test("ignores a message posted before the relay served the chat", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    const old = await relay.handleInbound(message("$old", "x", { postedAt: Date.now() - 10 * 60_000 }))
    expect(old.state).toBe("ignored")
    expect(api.prompts).toHaveLength(0)
  })

  test("takes an untriggered thread reply only in a thread it serves", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    expect((await relay.handleInbound(message("$r1", "more", { threadRootId: "$unknown", implicit: true }))).state).toBe("ignored")
    expect((await relay.handleInbound(message("$root", "start"))).state).toBe("accepted")
    const reply = await relay.handleInbound(message("$r2", "more", { threadRootId: "$root", implicit: true }))
    expect(reply.state).toBe("accepted")
    expect(relay.state.relays.get(reply.relayId!)?.replyThreadRootId).toBe("$root")
  })
})

describe("delivery", () => {
  test("an uncertain delivery is retried with the same key, never a new one", async () => {
    const api = new FakeApi()
    api.outcomes.push({ kind: "uncertain", status: 504, error: "BadRequest: may still register" })
    const { relay } = await startRelay(api)
    const { relayId } = await relay.handleInbound(message("$e1", "hello"))
    await until(() => relay.state.relays.get(relayId!)?.dispatch === "delivered")
    expect(api.prompts).toHaveLength(2)
    expect(api.prompts[1].key).toBe(api.prompts[0].key)
    expect(api.prompts[1].text).toBe(api.prompts[0].text)
  })

  test("gives up after its retry budget and says so in the thread", async () => {
    const api = new FakeApi()
    for (let i = 0; i < 4; i++) api.outcomes.push({ kind: "retry", error: "connection refused" })
    const { relay } = await startRelay(api)
    const { relayId } = await relay.handleInbound(message("$e1", "hello"))
    await until(() => relay.state.relays.get(relayId!)?.dispatch === "abandoned")
    expect(api.prompts).toHaveLength(4)
    const outbox = await relay.takeOutbox("matrix", 0)
    expect(outbox.items).toHaveLength(1)
    expect(outbox.items[0]).toMatchObject({ kind: "notice", roomId: ROOM, threadRootId: "$e1", replyToEventId: "$e1" })
    expect(outbox.items[0].text).toContain("was not delivered")
  })

  test("a refusal is reported once and not retried", async () => {
    const api = new FakeApi()
    api.outcomes.push({ kind: "failed", status: 404, error: "NotFoundError" })
    const { relay } = await startRelay(api)
    const { relayId } = await relay.handleInbound(message("$e1", "hello"))
    await until(() => relay.state.relays.get(relayId!)?.dispatch === "failed")
    await Bun.sleep(20)
    expect(api.prompts).toHaveLength(1)
    const outbox = await relay.takeOutbox("matrix", 0)
    expect(outbox.items[0].text).toContain("HTTP 404")
  })
})

describe("coordinator turns", () => {
  async function delivered(api: FakeApi, relay: Relay, eventId = "$e1"): Promise<{ relayId: string; userId: string }> {
    const { relayId } = await relay.handleInbound(message(eventId, "what is the time?"))
    await until(() => relay.state.relays.get(relayId!)?.dispatch === "delivered")
    return { relayId: relayId!, userId: relay.state.relays.get(relayId!)!.messageId! }
  }

  test("the answer goes into the thread of the message it answers, and typing stops", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    const { userId } = await delivered(api, relay)
    expect(relay.typingRooms("matrix")).toEqual([ROOM])

    api.addAssistant(userId, { text: "checking", finish: "tool-calls" })
    api.addAssistant(userId, { text: "It is 04:00 UTC.", finish: "stop" })
    await relay.watchRoute("matrix")

    const outbox = await relay.takeOutbox("matrix", 0)
    expect(outbox.items).toHaveLength(1)
    expect(outbox.items[0]).toMatchObject({ kind: "reply", roomId: ROOM, threadRootId: "$e1", replyToEventId: "$e1", text: "It is 04:00 UTC." })
    expect(outbox.items[0].txnId).toBe(`aibr-${outbox.items[0].outboxId}`)
    expect(outbox.typingRooms).toEqual([])

    await relay.watchRoute("matrix")
    expect([...relay.state.outbox.values()]).toHaveLength(1)
  })

  test("NO_REPLY posts nothing", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    const { userId } = await delivered(api, relay)
    api.addAssistant(userId, { text: "NO_REPLY", finish: "stop" })
    await relay.watchRoute("matrix")
    expect(relay.state.outbox.size).toBe(0)
    expect(relay.typingRooms("matrix")).toEqual([])
  })

  test("a turn answering no relayed message goes top-level, or nowhere on a replies-only route", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    api.addAssistant(api.addUser("a schedule fired"), { text: "Nightly check: all green.", finish: "stop" })
    await relay.watchRoute("matrix")
    const outbox = await relay.takeOutbox("matrix", 0)
    expect(outbox.items).toHaveLength(1)
    expect(outbox.items[0]).toMatchObject({ roomId: ROOM, threadRootId: "", replyToEventId: "" })

    const quiet = new FakeApi()
    const { relay: repliesOnly } = await startRelay(quiet, { route: { repliesOnly: true } })
    quiet.addAssistant(quiet.addUser("a notification"), { text: "something", finish: "stop" })
    await repliesOnly.watchRoute("matrix")
    expect(repliesOnly.state.outbox.size).toBe(0)
    expect(repliesOnly.state.processedTurns.size).toBe(1)
  })

  test("REPLY_TO sends a later turn into the named thread", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    const { relayId, userId } = await delivered(api, relay)
    api.addAssistant(userId, { text: "Started a child session; I will report back.", finish: "stop" })
    api.addAssistant(api.addUser("child finished"), { text: `REPLY_TO: ${relayId}\nThe child is done: 3 files changed.`, finish: "stop" })
    await relay.watchRoute("matrix")
    const outbox = await relay.takeOutbox("matrix", 0)
    expect(outbox.items.map((i) => [i.threadRootId, i.text])).toEqual([
      ["$e1", "Started a child session; I will report back."],
      ["$e1", "The child is done: 3 files changed."],
    ])
  })

  test("a lost receipt is settled by the transcript, and the answer still lands in the thread", async () => {
    const api = new FakeApi()
    api.outcomes.push((text) => {
      api.addUser(text)
      return { kind: "uncertain", error: "The operation timed out." }
    })
    const { relay } = await startRelay(api, { options: { uncertainSettleMs: 60_000 } })
    const { relayId } = await relay.handleInbound(message("$e1", "hello"))
    await until(() => relay.state.relays.get(relayId!)?.dispatch === "uncertain")

    api.addAssistant(api.lastUser(), { text: "hi there", finish: "stop" })
    await relay.watchRoute("matrix")

    const record = relay.state.relays.get(relayId!)!
    expect(record.dispatch).toBe("delivered")
    expect(record.messageId).toBe(api.lastUser())
    const outbox = await relay.takeOutbox("matrix", 0)
    expect(outbox.items[0]).toMatchObject({ threadRootId: "$e1", text: "hi there" })
    expect(api.prompts).toHaveLength(1)
  })

  test("a turn that ends in an error is reported in the thread", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    const { userId } = await delivered(api, relay)
    api.addAssistant(userId, { error: { name: "MessageAbortedError" } })
    await relay.watchRoute("matrix")
    const outbox = await relay.takeOutbox("matrix", 0)
    expect(outbox.items[0]).toMatchObject({ kind: "notice", threadRootId: "$e1" })
    expect(outbox.items[0].text).toContain("MessageAbortedError")
  })
})

describe("outbox", () => {
  async function queued(api: FakeApi, relay: Relay): Promise<void> {
    api.addAssistant(api.addUser("tick"), { text: "status", finish: "stop" })
    await relay.watchRoute("matrix")
  }

  test("an unconfirmed post is offered again under the same transaction id, then confirmed once", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    await queued(api, relay)
    const first = (await relay.takeOutbox("matrix", 0)).items
    expect(first).toHaveLength(1)
    expect((await relay.takeOutbox("matrix", 0)).items).toHaveLength(0)
    await Bun.sleep(450)
    const again = (await relay.takeOutbox("matrix", 0)).items
    expect(again.map((i) => [i.outboxId, i.txnId])).toEqual([[first[0].outboxId, first[0].txnId]])
    expect(relay.ack({ outboxId: first[0].outboxId, chatEventId: "$posted" })).toBe(true)
    expect(relay.state.outbox.get(first[0].outboxId)?.state).toBe("sent")
    await Bun.sleep(450)
    expect((await relay.takeOutbox("matrix", 0)).items).toHaveLength(0)
  })

  test("past the resend window an unconfirmed post becomes uncertain and is left alone", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api, { options: { resendWindowMs: 150 } })
    await queued(api, relay)
    const [item] = (await relay.takeOutbox("matrix", 0)).items
    await Bun.sleep(500)
    expect((await relay.takeOutbox("matrix", 0)).items).toHaveLength(0)
    expect(relay.state.outbox.get(item.outboxId)?.state).toBe("uncertain")
  })

  test("a failure that may have landed is offered again; a refusal is not", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    await queued(api, relay)
    const [item] = (await relay.takeOutbox("matrix", 0)).items
    relay.nack({ outboxId: item.outboxId, error: "socket hang up", definite: false })
    await Bun.sleep(20)
    const [retry] = (await relay.takeOutbox("matrix", 0)).items
    expect(retry.txnId).toBe(item.txnId)
    relay.nack({ outboxId: item.outboxId, error: "M_FORBIDDEN", definite: true })
    await Bun.sleep(450)
    expect((await relay.takeOutbox("matrix", 0)).items).toHaveLength(0)
    expect(relay.state.outbox.get(item.outboxId)?.state).toBe("failed")
  })

  test("a waiting connector is woken as soon as something is queued", async () => {
    const api = new FakeApi()
    const { relay } = await startRelay(api)
    const started = Date.now()
    const waiting = relay.takeOutbox("matrix", 8_000)
    await Bun.sleep(20)
    await queued(api, relay)
    const outbox = await waiting
    expect(outbox.items).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(6_000)
  })
})

describe("restart", () => {
  test("a restart neither delivers again nor posts again, and re-reads reply text it needs", async () => {
    const api = new FakeApi()
    const { relay, dir } = await startRelay(api)
    const { relayId } = await relay.handleInbound(message("$e1", "hello"))
    await until(() => relay.state.relays.get(relayId!)?.dispatch === "delivered")
    api.addAssistant(api.lastUser(), { text: "the answer", finish: "stop" })
    await relay.watchRoute("matrix")
    const watermark = relay.state.routes.get("matrix")!.watermarkMs
    relay.stop()
    relays.splice(relays.indexOf(relay), 1)

    const { relay: second } = await startRelay(api, { dir })
    expect(second.state.routes.get("matrix")!.watermarkMs).toBe(watermark)
    await second.watchRoute("matrix")
    await Bun.sleep(20)
    expect(api.prompts).toHaveLength(1)
    expect(second.state.outbox.size).toBe(1)
    expect((await second.handleInbound(message("$e1", "hello"))).state).toBe("duplicate")

    const reads = api.messageReads
    const outbox = await second.takeOutbox("matrix", 0)
    expect(outbox.items.map((i) => i.text)).toEqual(["the answer"])
    expect(api.messageReads).toBe(reads + 1)
  })
})

describe("socket server", () => {
  test("validates the inbound shape", () => {
    expect(typeof parseInbound(null)).toBe("string")
    expect(parseInbound({ ...message("$e", "x"), route: "slack" })).toBe("unknown route")
    expect(parseInbound({ ...message("$e", "   ") })).toBe("text")
    expect(parseInbound({ ...message("$e", "x"), implicit: "no" })).toBe("implicit")
    expect(parseInbound(message("$e", "x"))).toEqual(message("$e", "x"))
  })

  test("serves the connector over a private Unix socket", async () => {
    const api = new FakeApi()
    const { relay, dir } = await startRelay(api)
    const socketPath = join(dir, "sock", "relay.sock")
    const server = startRelayServer(relay, socketPath)
    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, "sock")).mode & 0o777).toBe(0o700)
      const client = new RelayClient(socketPath)

      const health = await client.health()
      expect((health.routes as any).matrix.sessionID).toBe(SESSION)

      const accepted = await client.inbound(message("$e1", "hello"))
      expect(accepted.state).toBe("accepted")
      await until(() => relay.state.relays.get(accepted.relayId!)?.dispatch === "delivered")

      const waiting = client.outbox("matrix", 8_000)
      await Bun.sleep(20)
      api.addAssistant(api.lastUser(), { text: "over the socket", finish: "stop" })
      await relay.watchRoute("matrix")
      const outbox = await waiting
      expect(outbox.items.map((i) => i.text)).toEqual(["over the socket"])
      await client.ack(outbox.items[0].outboxId, "$posted")
      expect(relay.state.outbox.get(outbox.items[0].outboxId)?.state).toBe("sent")

      await expect(client.inbound({ ...message("$e2", "x"), route: "slack" as any })).rejects.toThrow("HTTP 400")
      const big = await fetch("http://relay/v1/inbound", {
        method: "POST",
        unix: socketPath,
        body: "x".repeat(70 * 1024),
      } as RequestInit)
      expect(big.status).toBe(413)
    } finally {
      server.stop(true)
    }
  })
})
