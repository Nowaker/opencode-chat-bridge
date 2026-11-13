import { describe, expect, test } from "bun:test"
import { TypingAwareClient, TypingForwarder, TypingTransitions, typingSets } from "../../connectors/matrix-typing"
import type { TypingRequest } from "../../src/relay/types"

const ROOM = "!room:example.org"
const OTHER_ROOM = "!other:example.org"
const OWNER = "@owner:example.org"
const BOT = "@bot:example.org"
const STRANGER = "@stranger:example.org"

interface RoomFixture {
  /** `content.user_ids` of the room's m.typing, as sent (possibly malformed). */
  typing: unknown
  /** More ephemeral events after it, in order. */
  ephemeral?: unknown[]
  timeline?: unknown[]
}

/** A raw /sync response: per joined room an m.receipt and an m.typing, as Synapse sends them. */
function sync(rooms: Record<string, RoomFixture>) {
  return {
    next_batch: "s2",
    rooms: {
      join: Object.fromEntries(Object.entries(rooms).map(([roomId, room]) => [roomId, {
        timeline: { events: room.timeline ?? [] },
        ephemeral: {
          events: [{ type: "m.receipt", content: {} }, { type: "m.typing", content: { user_ids: room.typing } }, ...(room.ephemeral ?? [])],
        },
      }])),
    },
  }
}

const TOPIC_EVENT = { type: "m.room.topic", event_id: "$t", sender: OWNER, content: { topic: "x" } }

function eventId(event: unknown): string {
  return typeof event === "object" && event !== null && "event_id" in event && typeof event.event_id === "string" ? event.event_id : "?"
}

/** The SDK's protected sync hook, run on a fixture as the sync loop would. */
class SyncProbe extends TypingAwareClient {
  constructor() {
    super("https://matrix.example.org", "token")
  }

  runSync(raw: unknown): Promise<unknown> {
    return this.processSync(raw)
  }
}

describe("typingSets", () => {
  test("reads each joined room's typist set; the last m.typing in a response wins", () => {
    const raw = sync({ [ROOM]: { typing: [OWNER, BOT], ephemeral: [{ type: "m.typing", content: { user_ids: [] } }] } })
    expect([...typingSets(raw)]).toEqual([[ROOM, []]])
    expect([...typingSets(sync({ [ROOM]: { typing: [OWNER, OWNER] } }))]).toEqual([[ROOM, [OWNER]]])
  })

  test("malformed or missing ephemeral data yields nothing and never throws", () => {
    for (const raw of [null, {}, { rooms: null }, { rooms: { join: 5 } }, { rooms: { join: { [ROOM]: { ephemeral: { events: "x" } } } } },
      sync({ [ROOM]: { typing: "not a list" } }), sync({ [ROOM]: { typing: [OWNER, 7] } }),
      { rooms: { join: { [ROOM]: { ephemeral: { events: [null, { type: "m.typing" }, { type: "m.typing", content: [] }] } } } } }]) {
      expect(typingSets(raw).size).toBe(0)
    }
  })
})

describe("TypingTransitions", () => {
  const watched = (roomId: string, sender: string) => roomId === ROOM && sender === OWNER

  test("the first set is a baseline whose typists start partial; then starts and stops of watched senders only", () => {
    const transitions = new TypingTransitions(watched)
    expect(transitions.apply(ROOM, [OWNER, STRANGER])).toEqual([{ roomId: ROOM, sender: OWNER, state: "start", partial: true }])
    expect(transitions.apply(ROOM, [])).toEqual([{ roomId: ROOM, sender: OWNER, state: "stop" }])
    expect(transitions.apply(ROOM, [BOT, STRANGER])).toEqual([])
    expect(transitions.apply(ROOM, [OWNER, BOT])).toEqual([{ roomId: ROOM, sender: OWNER, state: "start" }])
    expect(transitions.apply(ROOM, [OWNER])).toEqual([])
    expect(transitions.apply(OTHER_ROOM, [OWNER])).toEqual([])
    expect(transitions.apply(OTHER_ROOM, [])).toEqual([])
  })

  test("after reset the next set is a baseline again", () => {
    const transitions = new TypingTransitions(watched)
    expect(transitions.apply(ROOM, [])).toEqual([])
    transitions.reset()
    expect(transitions.apply(ROOM, [OWNER])).toEqual([{ roomId: ROOM, sender: OWNER, state: "start", partial: true }])
  })
})

describe("TypingAwareClient", () => {
  test("reports typing from the raw sync before the SDK processes the same response", async () => {
    const client = new SyncProbe()
    const order: string[] = []
    client.typingObserver = {
      typing: (roomId, userIds) => order.push(`typing ${roomId} ${userIds.join(",")}`),
      failed: (error) => order.push(`failed ${String(error)}`),
    }
    client.on("room.event", (_roomId: string, event: unknown) => order.push(`event ${eventId(event)}`))
    await client.runSync(sync({ [ROOM]: { typing: [OWNER], timeline: [TOPIC_EVENT] } }))
    expect(order).toEqual([`typing ${ROOM} ${OWNER}`, "event $t"])
  })

  test("a throwing observer is reported as failed, and the sync is still processed", async () => {
    const client = new SyncProbe()
    const failures: unknown[] = []
    const events: string[] = []
    const boom = new Error("boom")
    client.typingObserver = { typing: () => { throw boom }, failed: (error) => failures.push(error) }
    client.on("room.event", (_roomId: string, event: unknown) => events.push(eventId(event)))
    await client.runSync(sync({ [ROOM]: { typing: [OWNER], timeline: [TOPIC_EVENT] } }))
    expect(failures).toEqual([boom])
    expect(events).toEqual(["$t"])
  })

  test("without an observer the sync is processed as the SDK does", async () => {
    const client = new SyncProbe()
    const events: string[] = []
    client.on("room.event", (_roomId: string, event: unknown) => events.push(eventId(event)))
    await client.runSync(sync({ [ROOM]: { typing: [OWNER], timeline: [TOPIC_EVENT] } }))
    expect(events).toEqual(["$t"])
  })
})

/** A relay socket whose typing POSTs the test settles one by one. */
class SlowRelay {
  readonly calls: TypingRequest[] = []
  private readonly settles: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  send = (request: TypingRequest): Promise<void> => {
    this.calls.push(request)
    return new Promise<void>((resolve, reject) => { this.settles.push({ resolve, reject }) })
  }

  /** Settles the oldest unsettled POST, then lets the forwarder hand out the next one. */
  async settle(error?: Error): Promise<void> {
    await drain()
    const next = this.settles.shift()
    if (!next) throw new Error("no POST in flight")
    if (error) next.reject(error)
    else next.resolve()
    await drain()
  }
}

/** Lets the forwarder's promise chain run up to its next POST; no timer involved. */
async function drain(): Promise<void> {
  for (let tick = 0; tick < 8; tick++) await Promise.resolve()
}

function forwarder(relay: SlowRelay, failures: unknown[] = [], clock = { ms: 1_000 }) {
  return new TypingForwarder({
    stream: "run-a", botUserId: BOT, rooms: [ROOM], users: [OWNER],
    allowed: (roomId, sender) => roomId === ROOM && sender === OWNER,
    send: relay.send, failed: (error) => failures.push(error), now: () => clock.ms,
  })
}

const brief = (request: TypingRequest) => [request.state, request.seq, request.observedAt]

describe("TypingForwarder", () => {
  test("numbers each transition per room and sender, reset first, and never counts the bot or another room", async () => {
    const relay = new SlowRelay()
    const clock = { ms: 1_000 }
    const typing = forwarder(relay, [], clock)
    typing.start()
    clock.ms = 2_000
    typing.observe(ROOM, [])
    typing.observe(OTHER_ROOM, [OWNER])
    typing.observe(ROOM, [OWNER, BOT, STRANGER])
    clock.ms = 3_000
    typing.observe(ROOM, [BOT])
    for (let sent = 0; sent < 3; sent++) await relay.settle()
    expect(relay.calls).toEqual([
      { route: "matrix", roomId: ROOM, sender: OWNER, state: "reset", observedAt: 1_000, stream: "run-a", seq: 0 },
      { route: "matrix", roomId: ROOM, sender: OWNER, state: "start", observedAt: 2_000, stream: "run-a", seq: 1 },
      { route: "matrix", roomId: ROOM, sender: OWNER, state: "stop", observedAt: 3_000, stream: "run-a", seq: 2 },
    ])
  })

  test("an owner already typing when observation begins gets a partial start", async () => {
    const relay = new SlowRelay()
    const typing = forwarder(relay)
    typing.start()
    typing.observe(ROOM, [OWNER])
    await relay.settle()
    await relay.settle()
    expect(relay.calls.at(-1)).toEqual({ route: "matrix", roomId: ROOM, sender: OWNER, state: "start", partial: true, observedAt: 1_000, stream: "run-a", seq: 1 })
  })

  test("a slow POST holds back the next one: transitions reach the relay one at a time, in order", async () => {
    const relay = new SlowRelay()
    const typing = forwarder(relay)
    typing.start()
    typing.observe(ROOM, [])
    typing.observe(ROOM, [OWNER])
    typing.observe(ROOM, [])
    await drain()
    expect(relay.calls.map(brief)).toEqual([["reset", 0, 1_000]])
    await relay.settle()
    expect(relay.calls.map((request) => request.seq)).toEqual([0, 1])
    await relay.settle()
    await relay.settle()
    expect(relay.calls.map((request) => request.state)).toEqual(["reset", "start", "stop"])
  })

  test("a failed POST is reported, and the next transition still goes out with the following seq", async () => {
    const relay = new SlowRelay()
    const failures: unknown[] = []
    const typing = forwarder(relay, failures)
    typing.start()
    typing.observe(ROOM, [])
    typing.observe(ROOM, [OWNER])
    typing.observe(ROOM, [])
    await relay.settle()
    const refused = new Error("relay down")
    await relay.settle(refused)
    await relay.settle()
    expect(failures).toEqual([refused])
    expect(relay.calls.map((request) => [request.state, request.seq])).toEqual([["reset", 0], ["start", 1], ["stop", 2]])
  })

  test("a message waits for the transitions before it, and its watermark names the last one handed out", async () => {
    const relay = new SlowRelay()
    const typing = forwarder(relay)
    typing.start()
    typing.observe(ROOM, [])
    typing.observe(ROOM, [OWNER])
    typing.observe(ROOM, [])
    let watermark: unknown = "pending"
    const fenced = typing.fence(ROOM, OWNER, 60_000).then((value) => { watermark = value })
    await relay.settle()
    await relay.settle()
    expect(watermark).toBe("pending")
    await relay.settle()
    await fenced
    expect(watermark).toEqual({ stream: "run-a", seq: 2 })
  })

  test("a stop still in flight holds a message back only up to the bound; the watermark still names the stop", async () => {
    const relay = new SlowRelay()
    const typing = forwarder(relay)
    typing.start()
    typing.observe(ROOM, [])
    typing.observe(ROOM, [OWNER])
    await relay.settle()
    await relay.settle()
    typing.observe(ROOM, [])
    // The stop's POST never settles: the message goes on after the bound, naming seq 2, which the relay has not taken.
    expect(await typing.fence(ROOM, OWNER, 20)).toEqual({ stream: "run-a", seq: 2 })
    expect(relay.calls.map((request) => request.state)).toEqual(["reset", "start", "stop"])
  })

  test("a sender never observed gets no watermark", async () => {
    const typing = forwarder(new SlowRelay())
    expect(await typing.fence(ROOM, STRANGER, 0)).toBeUndefined()
  })
})

describe("TypingForwarder, rooms allowed after start", () => {
  /** A forwarder over ROOM plus whatever `rooms` allows later, as the relay's registry does. */
  function registryForwarder(relay: SlowRelay, rooms: Set<string>, clock = { ms: 1_000 }) {
    return new TypingForwarder({
      stream: "run-a", botUserId: BOT, rooms: [ROOM], users: [OWNER],
      allowed: (roomId, sender) => (roomId === ROOM || rooms.has(roomId)) && sender === OWNER,
      send: relay.send, failed: () => {}, now: () => clock.ms,
    })
  }

  async function settle(relay: SlowRelay, posts: number): Promise<void> {
    for (let sent = 0; sent < posts; sent++) await relay.settle()
  }

  test("a room allowed later gets its own reset once, then numbers from it", async () => {
    const relay = new SlowRelay()
    const rooms = new Set<string>()
    const clock = { ms: 1_000 }
    const typing = registryForwarder(relay, rooms, clock)
    typing.start()
    clock.ms = 2_000
    typing.watch(OTHER_ROOM)
    rooms.add(OTHER_ROOM)
    typing.watch(OTHER_ROOM)
    typing.watch(OTHER_ROOM)
    clock.ms = 3_000
    typing.observe(OTHER_ROOM, [])
    typing.observe(OTHER_ROOM, [OWNER])
    await settle(relay, 3)
    expect(relay.calls.filter((call) => call.roomId === OTHER_ROOM).map(brief)).toEqual([["reset", 0, 2_000], ["start", 1, 3_000]])
    expect(await typing.fence(OTHER_ROOM, OWNER, 0)).toEqual({ stream: "run-a", seq: 1 })
  })

  test("typing in a newly allowed room before it is watched still starts with a reset, and the owner already typing is partial", async () => {
    const relay = new SlowRelay()
    const rooms = new Set<string>()
    const typing = registryForwarder(relay, rooms)
    typing.start()
    typing.observe(OTHER_ROOM, [OWNER])
    rooms.add(OTHER_ROOM)
    typing.observe(OTHER_ROOM, [OWNER])
    typing.watch(OTHER_ROOM)
    await settle(relay, 3)
    expect(relay.calls.filter((call) => call.roomId === OTHER_ROOM)).toEqual([
      { route: "matrix", roomId: OTHER_ROOM, sender: OWNER, state: "reset", observedAt: 1_000, stream: "run-a", seq: 0 },
      { route: "matrix", roomId: OTHER_ROOM, sender: OWNER, state: "start", partial: true, observedAt: 1_000, stream: "run-a", seq: 1 },
    ])
  })
})
