import { describe, expect, test } from "bun:test"
import {
  createOptions,
  hierarchyNext,
  rateLimitMs,
  REQUEST_STAMP,
  RoomSync,
  spaceChildren,
  type MatrixRoomsPort,
  type RoomsRelayPort,
  type SpaceChild,
} from "../../connectors/matrix-rooms"
import type { OwnerMembership, RoomClaimResponse, RoomClaimSource, RoomsResponse } from "../../src/relay/types"

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
    const error = this.createErrors.shift()
    if (error !== undefined) throw error
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
  children: SpaceChild[] = []
  hierarchyReads = 0
  joins: string[] = []
  /** Thrown by the next createRoom calls, one each, before any room is made. */
  createErrors: unknown[] = []
  async hierarchy(): Promise<SpaceChild[]> {
    this.hierarchyReads++
    return this.children.map((child) => ({ ...child }))
  }
  async join(roomId: string): Promise<void> {
    this.joins.push(roomId)
    this.joined.add(roomId)
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
  claims: Array<{ roomId: string; inviter: string; name: string; encrypted: boolean; source: RoomClaimSource }> = []
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
  async claim(roomId: string, inviter: string, name: string, encrypted: boolean, source: RoomClaimSource): Promise<RoomClaimResponse> {
    this.claims.push({ roomId, inviter, name, encrypted, source })
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
  const allowedRooms: string[] = []
  const sync = new RoomSync({
    matrix, relay, botUserId: BOT, log: (line) => logs.push(line), now: () => clock.at,
    allowedRoom: (roomId) => allowedRooms.push(roomId),
  })
  return { matrix, relay, sync, logs, clock, allowedRooms }
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

describe("rooms becoming allowed", () => {
  test("each registry room is announced once when it becomes allowed, the Space never", async () => {
    const { relay, sync, allowedRooms } = setup()
    relay.response = registry({
      space: "!space:example.org",
      rooms: [
        { roomId: "!space:example.org", kind: "space", key: "", label: "Vibeterm", ownerJoined: true },
        { roomId: "!p:example.org", kind: "project", key: "/p", label: "p", ownerJoined: false },
      ],
    })
    await sync.sync()
    await sync.sync()
    expect(allowedRooms).toEqual(["!p:example.org"])

    await sync.invited("!n:example.org", OWNER)
    expect(allowedRooms).toEqual(["!p:example.org", "!n:example.org"])
  })
})

describe("rooms the owner names", () => {
  test("a bound room is allowed and told what it is", async () => {
    const { matrix, relay, sync } = setup()
    matrix.setState("!n:example.org", "m.room.name", "", { name: "vt app" })
    matrix.setState("!n:example.org", "m.room.encryption", "", { algorithm: "m.megolm.v1.aes-sha2" })
    await sync.invited("!n:example.org", OWNER)
    expect(relay.claims).toEqual([{ roomId: "!n:example.org", inviter: OWNER, name: "vt app", encrypted: true, source: "invite" }])
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

const LIMITED = { errcode: "M_LIMIT_EXCEEDED", statusCode: 429, retryAfterMs: 3_000, body: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 3_000 } }

describe("rate limits", () => {
  test("the wait comes from the error, a default when it names none, and nothing for other errors", () => {
    expect(rateLimitMs(LIMITED)).toBe(3_000)
    expect(rateLimitMs({ statusCode: 429, body: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 1_500 } })).toBe(1_500)
    expect(rateLimitMs({ errcode: "M_LIMIT_EXCEEDED" })).toBe(10_000)
    expect(rateLimitMs({ errcode: "M_FORBIDDEN", statusCode: 403 })).toBeNull()
    expect(rateLimitMs(new Error("socket hang up"))).toBeNull()
  })

  test("a rate limit stops the pass, the next passes wait it out, then the rest is made one at a time", async () => {
    const clock = { at: 0 }
    const { matrix, relay, sync, logs } = setup(clock)
    relay.response = registry({
      space: "!space:example.org",
      rooms: [{ roomId: "!space:example.org", kind: "space", key: "", label: "Vibeterm", ownerJoined: true }],
      wanted: [
        { requestId: "project:a", kind: "project", name: "a", topic: "" },
        { requestId: "project:b", kind: "project", name: "b", topic: "" },
      ],
    })
    matrix.createErrors.push(LIMITED)
    await sync.sync()
    expect(matrix.created).toEqual([])
    expect(relay.createdCalls).toEqual([])
    expect(logs).toEqual(["[ROOMS] room for project:a not made: rate limited by the homeserver; trying again in 3 s"])

    clock.at = 2_999
    const reads = relay.reads
    await sync.sync()
    expect(relay.reads).toBe(reads)

    clock.at = 3_000
    await sync.sync()
    expect(relay.createdCalls.map((call) => call.requestId)).toEqual(["project:a", "project:b"])
    expect(matrix.sent.map((sent) => sent.stateKey)).toEqual(relay.response.rooms.filter((room) => room.kind === "project").map((room) => room.roomId))
  })
})

describe("the questions room", () => {
  test("is made like a project room, inside the Space, and listed in it", async () => {
    expect(createOptions({ requestId: "questions", kind: "questions", name: "Vibeterm questions", topic: "t" }, registry({ space: "!space:example.org" }), BOT)).toMatchObject({
      name: "Vibeterm questions",
      initial_state: [
        { type: "m.room.encryption" },
        { type: "m.space.parent", state_key: "!space:example.org" },
        { type: "m.room.join_rules", content: { join_rule: "restricted" } },
      ],
    })
    const { matrix, relay, sync } = setup()
    relay.response = registry({
      space: "!space:example.org",
      rooms: [{ roomId: "!space:example.org", kind: "space", key: "", label: "Vibeterm", ownerJoined: true }],
      wanted: [{ requestId: "questions", kind: "questions", name: "Vibeterm questions", topic: "" }],
    })
    await sync.sync()
    const questions = relay.response.rooms.find((room) => room.kind === "questions")?.roomId
    expect(matrix.sent).toEqual([{ roomId: "!space:example.org", type: "m.space.child", stateKey: questions, content: { via: ["example.org"] } }])
    expect(sync.allows(questions ?? "")).toBe(true)
  })
})

describe("rooms an owner adds to the Space", () => {
  test("the hierarchy names who listed each child, across pages", () => {
    const pages = [
      {
        rooms: [
          {
            room_id: "!space:example.org",
            children_state: [
              { type: "m.space.child", state_key: "!a:example.org", sender: OWNER, content: { via: ["example.org"] } },
              { type: "m.space.child", state_key: "!b:example.org", sender: OWNER, content: { via: ["example.org"] } },
              { type: "m.space.child", state_key: "!removed:example.org", sender: OWNER, content: {} },
            ],
          },
          { room_id: "!a:example.org", name: "Deploy ses_abc" },
        ],
        next_batch: "p2",
      },
      { rooms: [{ room_id: "!b:example.org" }, { room_id: "!removed:example.org", name: "x" }, { room_id: "!stray:example.org", name: "y" }] },
    ]
    expect(hierarchyNext(pages[0])).toBe("p2")
    expect(hierarchyNext(pages[1])).toBe("")
    expect(spaceChildren("!space:example.org", pages)).toEqual([
      { roomId: "!a:example.org", name: "Deploy ses_abc", listedBy: OWNER },
      { roomId: "!b:example.org", name: "", listedBy: OWNER },
    ])
    expect(spaceChildren("!space:example.org", [null, { rooms: "x" }])).toEqual([])
  })

  function spaceSetup(clock = { at: 0 }) {
    const started = setup(clock)
    started.relay.response = registry({
      space: "!space:example.org",
      spaceChildren: [MAIN],
      rooms: [{ roomId: "!space:example.org", kind: "space", key: "", label: "Vibeterm", ownerJoined: true }],
    })
    return started
  }

  test("a room an owner listed with a session id in its name is joined and claimed from the Space", async () => {
    const { matrix, relay, sync, allowedRooms } = spaceSetup()
    matrix.children = [
      { roomId: "!s:example.org", name: "Deploy ses_abc123", listedBy: OWNER },
      { roomId: "!chat:example.org", name: "random chat", listedBy: OWNER },
      { roomId: "!theirs:example.org", name: "ses_abc999", listedBy: "@stranger:example.org" },
      { roomId: MAIN, name: "Vibeterm AI", listedBy: OWNER },
    ]
    matrix.setState("!s:example.org", "m.room.name", "", { name: "Deploy ses_abc123" })
    matrix.setState("!s:example.org", "m.room.encryption", "", { algorithm: "m.megolm.v1.aes-sha2" })
    relay.claimAnswer = { state: "bound", kind: "session", label: "ses_abc123" }
    await sync.sync()
    expect(matrix.joins).toEqual(["!s:example.org"])
    expect(relay.claims).toEqual([{ roomId: "!s:example.org", inviter: OWNER, name: "Deploy ses_abc123", encrypted: true, source: "space" }])
    expect(sync.allows("!s:example.org")).toBe(true)
    expect(allowedRooms).toContain("!s:example.org")
    expect(matrix.notices).toEqual([{ roomId: "!s:example.org", text: expect.stringContaining("Bound to session ses_abc123") }])
    // Its owner's membership is read in the same pass, once the registry has it.
    expect(relay.members).toContainEqual({ roomId: "!s:example.org", user: OWNER, membership: "leave" })
  })

  test("a refused room is left and not tried again until it is renamed; the Space is read once a minute", async () => {
    const clock = { at: 0 }
    const { matrix, relay, sync } = spaceSetup(clock)
    matrix.children = [{ roomId: "!s:example.org", name: "ses_short", listedBy: OWNER }]
    relay.claimAnswer = { state: "refused", reason: "there is no session ses_short; use its full id" }
    await sync.sync()
    expect(matrix.left).toEqual(["!s:example.org"])
    expect(matrix.notices).toEqual([{ roomId: "!s:example.org", text: "Not bound: there is no session ses_short; use its full id." }])

    await sync.sync()
    expect(matrix.hierarchyReads).toBe(1)
    clock.at += 60_000
    await sync.sync()
    expect(matrix.hierarchyReads).toBe(2)
    expect(matrix.joins).toEqual(["!s:example.org"])

    matrix.children = [{ roomId: "!s:example.org", name: "ses_short1", listedBy: OWNER }]
    clock.at += 60_000
    await sync.sync()
    expect(matrix.joins).toEqual(["!s:example.org", "!s:example.org"])
  })

  test("with named rooms off, the Space is not read", async () => {
    const { matrix, relay, sync } = spaceSetup()
    relay.response.named = false
    matrix.children = [{ roomId: "!s:example.org", name: "ses_abc123", listedBy: OWNER }]
    await sync.sync()
    expect(matrix.hierarchyReads).toBe(0)
    expect(matrix.joins).toEqual([])
  })
})
