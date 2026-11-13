import { describe, expect, test } from "bun:test"
import { createOptions, REQUEST_STAMP, RoomSync, type MatrixRoomsPort, type RoomsRelayPort } from "../../connectors/matrix-rooms"
import type { OwnerMembership, RoomClaimResponse, RoomsResponse } from "../../src/relay/types"

const BOT = "@bot:example.org"
const OWNER = "@owner:example.org"
const MAIN = "!main:example.org"

function registry(overrides: Partial<RoomsResponse> = {}): RoomsResponse {
  return { owners: [OWNER], rooms: [], space: null, spaceChildren: [], wanted: [], named: true, ...overrides }
}

/** A homeserver in memory: rooms with state, the bot's joined set and account data. */
class FakeMatrix implements MatrixRoomsPort {
  state = new Map<string, Map<string, Record<string, unknown>>>()
  joined = new Set<string>()
  created: Array<Record<string, unknown>> = []
  sent: Array<{ roomId: string; type: string; stateKey: string; content: Record<string, unknown> }> = []
  notices: Array<{ roomId: string; text: string }> = []
  left: string[] = []
  account = new Map<string, Record<string, unknown>>()
  private seq = 0

  setState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): void {
    let room = this.state.get(roomId)
    if (!room) this.state.set(roomId, (room = new Map()))
    room.set(`${type}\u0000${stateKey}`, content)
  }

  async joinedRooms(): Promise<string[]> {
    return [...this.joined]
  }
  async createRoom(options: Record<string, unknown>): Promise<string> {
    this.created.push(options)
    const roomId = `!made${++this.seq}:example.org`
    this.joined.add(roomId)
    const creation = options["creation_content"]
    this.setState(roomId, "m.room.create", "", typeof creation === "object" && creation !== null ? { ...creation } : {})
    return roomId
  }
  async stateEvent(roomId: string, type: string, stateKey: string): Promise<Record<string, unknown> | null> {
    return this.state.get(roomId)?.get(`${type}\u0000${stateKey}`) ?? null
  }
  async sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): Promise<void> {
    this.sent.push({ roomId, type, stateKey, content })
    this.setState(roomId, type, stateKey, content)
  }
  async accountData(type: string): Promise<Record<string, unknown>> {
    return this.account.get(type) ?? {}
  }
  async setAccountData(type: string, content: Record<string, unknown>): Promise<void> {
    this.account.set(type, content)
  }
  async leave(roomId: string): Promise<void> {
    this.left.push(roomId)
    this.joined.delete(roomId)
  }
  async notice(roomId: string, text: string): Promise<void> {
    this.notices.push({ roomId, text })
  }
}

/** The relay's registry, enough of it to drive the connector. */
class FakeRelay implements RoomsRelayPort {
  response = registry()
  createdCalls: Array<{ requestId: string; roomId: string }> = []
  members: Array<{ roomId: string; user: string; membership: OwnerMembership }> = []
  claims: Array<{ roomId: string; inviter: string; name: string; encrypted: boolean }> = []
  claimAnswer: RoomClaimResponse = { state: "bound", kind: "project", label: "app" }
  goneCalls: string[] = []
  reads = 0

  async rooms(): Promise<RoomsResponse> {
    this.reads++
    return structuredClone(this.response)
  }
  async created(requestId: string, roomId: string): Promise<void> {
    this.createdCalls.push({ requestId, roomId })
    const want = this.response.wanted.find((entry) => entry.requestId === requestId)
    if (!want) throw new Error(`no request ${requestId}`)
    this.response.wanted = this.response.wanted.filter((entry) => entry !== want)
    this.response.rooms.push({ roomId, kind: want.kind, key: "", label: want.name, ownerJoined: false })
    if (want.kind === "space") this.response.space = roomId
  }
  async member(roomId: string, user: string, membership: OwnerMembership): Promise<void> {
    this.members.push({ roomId, user, membership })
  }
  async claim(roomId: string, inviter: string, name: string, encrypted: boolean): Promise<RoomClaimResponse> {
    this.claims.push({ roomId, inviter, name, encrypted })
    if (this.claimAnswer.state === "bound") this.response.rooms.push({ roomId, kind: this.claimAnswer.kind, key: "", label: this.claimAnswer.label, ownerJoined: true })
    return this.claimAnswer
  }
  async gone(roomId: string): Promise<void> {
    this.goneCalls.push(roomId)
    this.response.rooms = this.response.rooms.filter((room) => room.roomId !== roomId)
  }
}

function setup(clock = { at: 0 }) {
  const matrix = new FakeMatrix()
  const relay = new FakeRelay()
  const logs: string[] = []
  const sync = new RoomSync({ matrix, relay, botUserId: BOT, log: (line) => logs.push(line), now: () => clock.at })
  return { matrix, relay, sync, logs, clock }
}

describe("creating rooms", () => {
  test("a project room is encrypted at creation, restricted to the Space, and points at it", () => {
    const options = createOptions({ requestId: "project:abc", kind: "project", name: "app", topic: "t" }, registry({ space: "!space:example.org" }), BOT)
    expect(options).toMatchObject({
      name: "app",
      creation_content: { [REQUEST_STAMP]: "project:abc" },
      power_level_content_override: { users: { [BOT]: 100, [OWNER]: 100 } },
      initial_state: [
        { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
        { type: "m.space.parent", state_key: "!space:example.org", content: { via: ["example.org"], canonical: true } },
        { type: "m.room.join_rules", state_key: "", content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: "!space:example.org" }] } },
      ],
    })
    expect(options).not.toHaveProperty("invite")
    expect(createOptions({ requestId: "project:abc", kind: "project", name: "app", topic: "t" }, registry(), BOT)).toBeNull()
  })

  test("the Space invites the owners; the direct chat is encrypted and direct", () => {
    expect(createOptions({ requestId: "space", kind: "space", name: "Vibeterm", topic: "t" }, registry(), BOT)).toMatchObject({
      invite: [OWNER],
      creation_content: { type: "m.space", [REQUEST_STAMP]: "space" },
    })
    expect(createOptions({ requestId: "dm", kind: "dm", name: "", topic: "" }, registry(), BOT)).toMatchObject({
      is_direct: true,
      invite: [OWNER],
      preset: "trusted_private_chat",
      initial_state: [{ type: "m.room.encryption" }],
    })
  })

  test("wanted rooms are created once, reported, listed in the Space, and the direct chat marked direct", async () => {
    const { matrix, relay, sync } = setup()
    relay.response = registry({
      spaceChildren: [MAIN],
      wanted: [
        { requestId: "space", kind: "space", name: "Vibeterm", topic: "" },
        { requestId: "dm", kind: "dm", name: "", topic: "" },
      ],
    })
    await sync.sync()
    expect(relay.createdCalls.map((call) => call.requestId)).toEqual(["space", "dm"])
    const space = relay.response.space
    const dm = relay.response.rooms.find((room) => room.kind === "dm")?.roomId
    expect(matrix.sent).toEqual([{ roomId: space, type: "m.space.child", stateKey: MAIN, content: { via: ["example.org"] } }])
    expect(matrix.account.get("m.direct")).toEqual({ [OWNER]: [dm] })
    expect(sync.allows(dm ?? "")).toBe(true)
    expect(sync.allows(space ?? "")).toBe(false)

    relay.response.wanted.push({ requestId: "project:abc", kind: "project", name: "app", topic: "" })
    await sync.sync()
    const project = relay.response.rooms.find((room) => room.kind === "project")?.roomId
    expect(matrix.sent.at(-1)).toEqual({ roomId: space, type: "m.space.child", stateKey: project, content: { via: ["example.org"] } })
    expect(sync.allows(project ?? "")).toBe(true)

    await sync.sync()
    expect(matrix.created).toHaveLength(3)
    expect(matrix.sent).toHaveLength(2)
  })

  test("after a crash, the room already made for a request is found by its stamp, not made again", async () => {
    const { matrix, relay, sync } = setup()
    matrix.joined.add("!earlier:example.org")
    matrix.setState("!earlier:example.org", "m.room.create", "", { type: "m.space", [REQUEST_STAMP]: "space" })
    relay.response = registry({ wanted: [{ requestId: "space", kind: "space", name: "Vibeterm", topic: "" }] })
    await sync.sync()
    expect(matrix.created).toEqual([])
    expect(relay.createdCalls).toEqual([{ requestId: "space", roomId: "!earlier:example.org" }])
  })

  test("a relay that cannot be read is said once, and nothing is done", async () => {
    const { relay, sync, logs } = setup()
    relay.rooms = async () => {
      throw new Error("relay /v1/rooms: HTTP 404")
    }
    await sync.sync()
    await sync.sync()
    expect(logs).toEqual(["[ROOMS] rooms not read from the relay: relay /v1/rooms: HTTP 404"])
  })
})

describe("membership", () => {
  test("each owner's membership is reported once per change, from state and from events", async () => {
    const { matrix, relay, sync, clock } = setup()
    relay.response = registry({ rooms: [{ roomId: "!p:example.org", kind: "project", key: "/p", label: "p", ownerJoined: false }] })
    await sync.sync()
    expect(relay.members).toEqual([{ roomId: "!p:example.org", user: OWNER, membership: "leave" }])

    await sync.memberEvent("!p:example.org", { type: "m.room.member", state_key: OWNER, content: { membership: "join" } })
    await sync.memberEvent("!p:example.org", { type: "m.room.member", state_key: OWNER, content: { membership: "join" } })
    await sync.memberEvent("!p:example.org", { type: "m.room.member", state_key: "@stranger:example.org", content: { membership: "join" } })
    await sync.memberEvent("!other:example.org", { type: "m.room.member", state_key: OWNER, content: { membership: "join" } })
    expect(relay.members.map((entry) => entry.membership)).toEqual(["leave", "join"])

    // A missed event is caught by the rescan.
    matrix.setState("!p:example.org", "m.room.member", OWNER, { membership: "leave" })
    await sync.sync()
    expect(relay.members).toHaveLength(2)
    clock.at += 5 * 60_000
    await sync.sync()
    expect(relay.members.at(-1)).toEqual({ roomId: "!p:example.org", user: OWNER, membership: "leave" })
  })

  test("the bot leaving a registry room reports it gone and stops allowing it", async () => {
    const { relay, sync } = setup()
    relay.response = registry({ rooms: [{ roomId: "!p:example.org", kind: "project", key: "/p", label: "p", ownerJoined: true }] })
    await sync.sync()
    expect(sync.allows("!p:example.org")).toBe(true)
    await sync.memberEvent("!p:example.org", { type: "m.room.member", state_key: BOT, content: { membership: "leave" } })
    expect(relay.goneCalls).toEqual(["!p:example.org"])
    expect(sync.allows("!p:example.org")).toBe(false)
  })
})

describe("rooms the owner names", () => {
  test("a bound room is allowed and told what it is", async () => {
    const { matrix, relay, sync } = setup()
    matrix.setState("!n:example.org", "m.room.name", "", { name: "vt app" })
    matrix.setState("!n:example.org", "m.room.encryption", "", { algorithm: "m.megolm.v1.aes-sha2" })
    await sync.invited("!n:example.org", OWNER)
    expect(relay.claims).toEqual([{ roomId: "!n:example.org", inviter: OWNER, name: "vt app", encrypted: true }])
    expect(sync.allows("!n:example.org")).toBe(true)
    expect(matrix.notices).toEqual([{ roomId: "!n:example.org", text: expect.stringContaining("Bound to project app") }])
    expect(matrix.left).toEqual([])
  })

  test("a refused room gets the reason and the bot leaves", async () => {
    const { matrix, relay, sync } = setup()
    relay.claimAnswer = { state: "refused", reason: "turn on encryption in this room first, then invite me again" }
    await sync.invited("!n:example.org", OWNER)
    expect(relay.claims[0]).toMatchObject({ name: "", encrypted: false })
    expect(matrix.notices).toEqual([{ roomId: "!n:example.org", text: "Not bound: turn on encryption in this room first, then invite me again." }])
    expect(matrix.left).toEqual(["!n:example.org"])
    expect(sync.allows("!n:example.org")).toBe(false)
  })

  test("with named rooms off, an owner's invite is joined and left alone", async () => {
    const { matrix, relay, sync } = setup()
    relay.response = registry({ named: false })
    await sync.invited("!n:example.org", OWNER)
    expect(relay.claims).toEqual([])
    expect(matrix.left).toEqual([])
    expect(matrix.notices).toEqual([])
  })
})
