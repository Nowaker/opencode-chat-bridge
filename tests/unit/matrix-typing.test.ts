import { describe, expect, test } from "bun:test"
import { TypingAwareClient, TypingTransitions, typingSets } from "../../connectors/matrix-typing"

const ROOM = "!room:example.org"
const OTHER_ROOM = "!other:example.org"
const OWNER = "@owner:example.org"
const BOT = "@bot:example.org"
const STRANGER = "@stranger:example.org"

/** A raw /sync response with one m.typing per room, as Synapse sends it. */
function sync(typing: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    next_batch: "s2",
    rooms: {
      join: Object.fromEntries(Object.entries(typing).map(([roomId, userIds]) => [roomId, {
        timeline: { events: [] },
        ephemeral: { events: [{ type: "m.receipt", content: {} }, { type: "m.typing", content: { user_ids: userIds } }] },
      }])),
    },
    ...extra,
  }
}

describe("typingSets", () => {
  test("reads each joined room's typist set; the last m.typing in a response wins", () => {
    const raw = sync({ [ROOM]: [OWNER, BOT] })
    ;(raw.rooms as any).join[ROOM].ephemeral.events.push({ type: "m.typing", content: { user_ids: [] } })
    expect([...typingSets(raw)]).toEqual([[ROOM, []]])
    expect([...typingSets(sync({ [ROOM]: [OWNER, OWNER] }))]).toEqual([[ROOM, [OWNER]]])
  })

  test("malformed or missing ephemeral data yields nothing and never throws", () => {
    for (const raw of [null, {}, { rooms: null }, { rooms: { join: 5 } }, { rooms: { join: { [ROOM]: { ephemeral: { events: "x" } } } } },
      sync({ [ROOM]: "not a list" }), sync({ [ROOM]: [OWNER, 7] }), { rooms: { join: { [ROOM]: { ephemeral: { events: [null, { type: "m.typing" }] } } } } }]) {
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
    const client = new TypingAwareClient("https://matrix.example.org", "token")
    const order: string[] = []
    client.onTyping = (roomId, userIds) => order.push(`typing ${roomId} ${userIds.join(",")}`)
    client.on("room.event", () => order.push("event"))
    const raw = sync({ [ROOM]: [OWNER] })
    ;(raw.rooms as any).join[ROOM].timeline.events.push({ type: "m.room.topic", event_id: "$t", sender: OWNER, content: { topic: "x" } })
    await (client as any).processSync(raw)
    expect(order).toEqual([`typing ${ROOM} ${OWNER}`, "event"])
  })

  test("a throwing listener does not stop the sync from being processed", async () => {
    const client = new TypingAwareClient("https://matrix.example.org", "token")
    const events: string[] = []
    client.onTyping = () => { throw new Error("boom") }
    client.on("room.event", (_room: string, event: any) => events.push(event.event_id))
    const raw = sync({ [ROOM]: [OWNER] })
    ;(raw.rooms as any).join[ROOM].timeline.events.push({ type: "m.room.topic", event_id: "$t", sender: OWNER, content: { topic: "x" } })
    await (client as any).processSync(raw)
    expect(events).toEqual(["$t"])
  })
})

describe("the Matrix connector's typing forwarding", () => {
  test("sends a reset per allowlisted room, then only the owner's transitions in allowlisted rooms", async () => {
    const { MatrixConnector } = await import("../../connectors/matrix")
    const connector = new MatrixConnector()
    const sent: Array<Record<string, unknown>> = []
    ;(connector as any).relay = { typing: async (request: Record<string, unknown>) => { sent.push(request) } }
    ;(connector as any).allowedUsers = new Set([OWNER])
    ;(connector as any).allowedChannels = new Set([ROOM])
    const matrix = { getUserId: async () => BOT, onTyping: null as null | ((roomId: string, userIds: string[]) => void) }
    await (connector as any).observeTyping(matrix, [ROOM], [OWNER])
    matrix.onTyping!(ROOM, [])
    matrix.onTyping!(OTHER_ROOM, [])
    matrix.onTyping!(ROOM, [OWNER, BOT, STRANGER])
    matrix.onTyping!(OTHER_ROOM, [OWNER])
    matrix.onTyping!(ROOM, [BOT])
    await Promise.resolve()
    expect(sent.map(({ roomId, sender, state }) => ({ roomId, sender, state }))).toEqual([
      { roomId: ROOM, sender: OWNER, state: "reset" },
      { roomId: ROOM, sender: OWNER, state: "start" },
      { roomId: ROOM, sender: OWNER, state: "stop" },
    ])
    expect(sent.every((request) => request.route === "matrix" && typeof request.observedAt === "number")).toBe(true)
  })
})

describe("the Matrix connector's edits", () => {
  test("an edit is forwarded under its own id and names the event it edits", async () => {
    const { MatrixConnector } = await import("../../connectors/matrix")
    const connector = new MatrixConnector()
    const sent: Array<Record<string, unknown>> = []
    ;(connector as any).relay = { inbound: async (request: Record<string, unknown>) => { sent.push(request); return { state: "accepted" } } }
    const context = { roomId: ROOM, sender: OWNER, eventId: "$edit", threadRootEventId: "", sessionId: "s" }
    const edit = { event_id: "$edit", origin_server_ts: 5, content: { body: "* hi", "m.new_content": { body: "hi" }, "m.relates_to": { rel_type: "m.replace", event_id: "$orig" } } }
    await (connector as any).forwardToRelay(context, edit, "* hi", false)
    await (connector as any).forwardToRelay({ ...context, eventId: "$plain" }, { event_id: "$plain", origin_server_ts: 6, content: { body: "hi" } }, "hi", false)
    expect(sent.map(({ eventId, originalEventId }) => ({ eventId, originalEventId }))).toEqual([
      { eventId: "$edit", originalEventId: "$orig" },
      { eventId: "$plain", originalEventId: undefined },
    ])
  })
})
