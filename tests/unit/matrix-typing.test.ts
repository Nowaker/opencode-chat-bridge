import { describe, expect, test } from "bun:test"
import { TypingAwareClient, TypingTransitions, forwardTyping, typingSets } from "../../connectors/matrix-typing"
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

describe("forwardTyping", () => {
  test("sends a reset per room and sender, then only allowed senders' transitions; the bot never counts", () => {
    const sent: TypingRequest[] = []
    let clock = 1_000
    const onTyping = forwardTyping({
      botUserId: BOT,
      rooms: [ROOM],
      users: [OWNER, BOT],
      allowed: (roomId, sender) => roomId === ROOM && (sender === OWNER || sender === BOT),
      send: (request) => sent.push(request),
      now: () => clock,
    })
    clock = 2_000
    onTyping(ROOM, [])
    onTyping(OTHER_ROOM, [])
    onTyping(ROOM, [OWNER, BOT, STRANGER])
    onTyping(OTHER_ROOM, [OWNER])
    clock = 3_000
    onTyping(ROOM, [BOT])
    expect(sent).toEqual([
      { route: "matrix", roomId: ROOM, sender: OWNER, state: "reset", observedAt: 1_000 },
      { route: "matrix", roomId: ROOM, sender: BOT, state: "reset", observedAt: 1_000 },
      { route: "matrix", roomId: ROOM, sender: OWNER, state: "start", observedAt: 2_000 },
      { route: "matrix", roomId: ROOM, sender: OWNER, state: "stop", observedAt: 3_000 },
    ])
  })

  test("an owner already typing when observation begins gets a partial start", () => {
    const sent: TypingRequest[] = []
    const onTyping = forwardTyping({
      botUserId: BOT, rooms: [ROOM], users: [OWNER], allowed: () => true, send: (request) => sent.push(request), now: () => 5,
    })
    onTyping(ROOM, [OWNER])
    expect(sent.at(-1)).toEqual({ route: "matrix", roomId: ROOM, sender: OWNER, state: "start", partial: true, observedAt: 5 })
  })
})
