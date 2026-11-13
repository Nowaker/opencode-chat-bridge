/**
 * The Matrix side of the relay's room registry (vibeterm-channels `rooms.ts`).
 *
 * The relay decides which rooms exist and where items go; this does the
 * Matrix work and reports back:
 *
 * - creates each room the relay wants: the Space "Vibeterm" (owners invited),
 *   a project room inside it (encrypted at creation, `restricted` to Space
 *   members, so it shows in the Space with no invite), and the direct chat
 *   (encrypted, `is_direct`, listed in the bot's `m.direct`). Each carries its
 *   request id in its creation content, so after a crash the room already made
 *   is found and reported instead of a second one being created;
 * - lists project rooms and the configured rooms in the Space;
 * - reports each owner's membership in every registry room, and the bot
 *   leaving one;
 * - binds a room an owner created, by its name, when the relay serves named
 *   rooms: one the owner invited the bot to, or one the owner listed in the
 *   Space (read from the Space's hierarchy, joined as a Space member). The
 *   relay checks the name, the owner and the room's encryption; a refused room
 *   gets the reason and the bot leaves;
 * - backs off when the homeserver rate-limits it (`M_LIMIT_EXCEEDED`): the
 *   pass stops, and the next one starts after `retry_after_ms`.
 *
 * A registry room's id joins the connector's allowlist once the relay has it;
 * the Space never does, as it carries no messages.
 */

import type { OwnerMembership, RoomClaimResponse, RoomClaimSource, RoomsResponse, RoomWanted } from "../src/relay/types"
import { OWNER_MEMBERSHIPS } from "../src/relay/types"

/** The creation-content key a created room carries its relay request id under. */
export const REQUEST_STAMP = "org.vibeterm.request_id"
/** Every owner's membership in every registry room is read again this often; events keep it current in between. */
const MEMBERSHIP_RESCAN_MS = 5 * 60_000
/** How often the Space's rooms are read for rooms an owner added there. */
const DISCOVERY_MS = 60_000
/** The wait after a rate limit that names none. */
const DEFAULT_RATE_LIMIT_MS = 10_000
/** A name the relay may bind: a session id standing on its own anywhere, or `vt <project>`. */
const BINDING_NAME = /(?<![A-Za-z0-9_])ses_[A-Za-z0-9]+(?![A-Za-z0-9_])|^\s*vt\s+\S/i

/** A room listed in a Space, as its hierarchy shows it. */
export interface SpaceChild {
  roomId: string
  name: string
  /** Who sent the Space's `m.space.child` for it. */
  listedBy: string
}

export interface MatrixRoomsPort {
  joinedRooms(): Promise<string[]>
  createRoom(options: Record<string, unknown>): Promise<string>
  /** Null when the room has no such state event. */
  stateEvent(roomId: string, type: string, stateKey: string): Promise<Record<string, unknown> | null>
  sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): Promise<void>
  /** `{}` when the bot has none of that type. */
  accountData(type: string): Promise<Record<string, unknown>>
  setAccountData(type: string, content: Record<string, unknown>): Promise<void>
  leave(roomId: string): Promise<void>
  notice(roomId: string, text: string): Promise<void>
  /** The rooms listed in a Space that the bot can see. */
  hierarchy(spaceId: string): Promise<SpaceChild[]>
  join(roomId: string, via: string[]): Promise<void>
}

export interface RoomsRelayPort {
  rooms(): Promise<RoomsResponse>
  created(requestId: string, roomId: string): Promise<void>
  member(roomId: string, user: string, membership: OwnerMembership): Promise<void>
  claim(roomId: string, inviter: string, name: string, encrypted: boolean, source: RoomClaimSource): Promise<RoomClaimResponse>
  gone(roomId: string): Promise<void>
}

export interface RoomSyncOptions {
  matrix: MatrixRoomsPort
  relay: RoomsRelayPort
  botUserId: string
  log(line: string): void
  now(): number
  /** A registry room became one this connector may act in. */
  allowedRoom?(roomId: string): void
}

const ENCRYPTION = { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMembership(value: unknown): value is OwnerMembership {
  return typeof value === "string" && (OWNER_MEMBERSHIPS as readonly string[]).includes(value)
}

function serverOf(userId: string): string {
  return userId.slice(userId.indexOf(":") + 1)
}

/** The next page's token of a `GET /rooms/{space}/hierarchy` answer, or "" at the end. */
export function hierarchyNext(response: unknown): string {
  return isRecord(response) && typeof response["next_batch"] === "string" ? response["next_batch"] : ""
}

/**
 * The child rooms in the pages of `GET /rooms/{space}/hierarchy`, each with
 * who listed it: the sender of the Space's `m.space.child`, which only the
 * Space's own entry (first page) carries, while a child's name is in its own
 * entry, possibly on a later page.
 */
export function spaceChildren(spaceId: string, pages: readonly unknown[]): SpaceChild[] {
  const rooms = pages.flatMap((page) => (isRecord(page) && Array.isArray(page["rooms"]) ? page["rooms"].filter(isRecord) : []))
  const listedBy = new Map<string, string>()
  for (const room of rooms) {
    if (room["room_id"] !== spaceId || !Array.isArray(room["children_state"])) continue
    for (const event of room["children_state"]) {
      if (!isRecord(event) || event["type"] !== "m.space.child") continue
      const content = event["content"]
      const via = isRecord(content) ? content["via"] : undefined
      const childId = event["state_key"]
      const sender = event["sender"]
      if (typeof childId === "string" && typeof sender === "string" && Array.isArray(via) && via.length > 0) listedBy.set(childId, sender)
    }
  }
  const children: SpaceChild[] = []
  for (const room of rooms) {
    const roomId = room["room_id"]
    if (typeof roomId !== "string" || roomId === spaceId) continue
    const by = listedBy.get(roomId)
    if (by === undefined) continue
    children.push({ roomId, name: typeof room["name"] === "string" ? room["name"] : "", listedBy: by })
  }
  return children
}

/** How long the homeserver asked to wait, when `error` is its rate limit; null for any other error. */
export function rateLimitMs(error: unknown): number | null {
  if (!isRecord(error)) return null
  const body = error["body"]
  const errcode = error["errcode"] ?? (isRecord(body) ? body["errcode"] : undefined)
  if (errcode !== "M_LIMIT_EXCEEDED" && error["statusCode"] !== 429) return null
  const wait = error["retryAfterMs"] ?? (isRecord(body) ? body["retry_after_ms"] : undefined)
  return typeof wait === "number" && Number.isFinite(wait) && wait > 0 ? wait : DEFAULT_RATE_LIMIT_MS
}

/** Ends a pass at a rate limit; the next pass starts after the wait. */
class RateLimited extends Error {
  constructor() {
    super("rate limited")
    this.name = "RateLimited"
  }
}

/** The options a wanted room is created with. */
export function createOptions(want: RoomWanted, registry: RoomsResponse, botUserId: string): Record<string, unknown> | null {
  const powerLevels = { users: Object.fromEntries([botUserId, ...registry.owners].map((user) => [user, 100])) }
  const creation = { [REQUEST_STAMP]: want.requestId }
  switch (want.kind) {
    case "space":
      return {
        name: want.name,
        topic: want.topic,
        preset: "private_chat",
        visibility: "private",
        invite: registry.owners,
        creation_content: { ...creation, type: "m.space" },
        power_level_content_override: { ...powerLevels, events_default: 100 },
      }
    case "project":
    case "questions": {
      if (registry.space === null) return null
      return {
        name: want.name,
        topic: want.topic,
        preset: "private_chat",
        visibility: "private",
        creation_content: creation,
        power_level_content_override: powerLevels,
        initial_state: [
          ENCRYPTION,
          { type: "m.space.parent", state_key: registry.space, content: { via: [serverOf(botUserId)], canonical: true } },
          {
            type: "m.room.join_rules",
            state_key: "",
            content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: registry.space }] },
          },
        ],
      }
    }
    case "dm":
      return {
        preset: "trusted_private_chat",
        visibility: "private",
        is_direct: true,
        invite: registry.owners,
        creation_content: creation,
        initial_state: [ENCRYPTION],
      }
  }
}

export function boundNotice(response: Extract<RoomClaimResponse, { state: "bound" }>): string {
  return response.kind === "session"
    ? `Bound to session ${response.label}: what you write here goes to that session, and its final turns come here while you are in this room.`
    : `Bound to project ${response.label}: its questions and permissions come here while you are in this room, and what you write here goes to the coordinator about this project.`
}

export class RoomSync {
  private registry: RoomsResponse | null = null
  private readonly allowed = new Set<string>()
  private readonly reported = new Map<string, OwnerMembership>()
  private readonly stamps = new Map<string, string>()
  private readonly stampScanned = new Set<string>()
  private readonly children = new Set<string>()
  private directDone = ""
  private lastRescan = 0
  private running: Promise<void> | null = null
  private lastError = ""
  private blockedUntil = 0
  private lastDiscovery = Number.NEGATIVE_INFINITY
  /** Space rooms the bot joined or tried to, by the name they had then: tried again only under a new name. */
  private readonly tried = new Map<string, string>()

  constructor(private readonly options: RoomSyncOptions) {}

  /** A registry room this connector may act in. */
  allows(roomId: string): boolean {
    return this.allowed.has(roomId)
  }

  registered(roomId: string): boolean {
    return this.registry?.rooms.some((room) => room.roomId === roomId) === true
  }

  /** One pass, never two at once: a call while one runs waits for it. */
  sync(): Promise<void> {
    this.running ??= this.pass().finally(() => { this.running = null })
    return this.running
  }

  private async pass(): Promise<void> {
    if (this.options.now() < this.blockedUntil) return
    try {
      await this.steps()
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error
    }
  }

  private async steps(): Promise<void> {
    if (!(await this.readRegistry())) return
    const registry = this.registry
    if (registry === null) return
    // One room at a time: each is reported before the next is made, and a rate limit stops the rest.
    let changed = false
    for (const want of registry.wanted) changed = (await this.ensure(want, registry)) || changed
    if (changed && !(await this.readRegistry())) return
    const current = this.registry ?? registry
    await this.ensureChildren(current)
    await this.ensureDirect(current)
    if ((await this.discover(current)) && !(await this.readRegistry())) return
    await this.scanMemberships(this.registry ?? current)
    this.lastError = ""
  }

  private async readRegistry(): Promise<boolean> {
    try {
      this.adopt(await this.options.relay.rooms())
      return true
    } catch (error) {
      this.failed("rooms not read from the relay", error)
      return false
    }
  }

  private adopt(registry: RoomsResponse): void {
    this.registry = registry
    const before = new Set(this.allowed)
    this.allowed.clear()
    for (const room of registry.rooms) if (room.kind !== "space") this.allowed.add(room.roomId)
    for (const roomId of this.allowed) if (!before.has(roomId)) this.options.allowedRoom?.(roomId)
  }

  /** Logged once while it repeats; a rate limit also holds every pass until its wait is over. */
  private failed(what: string, error: unknown): void {
    const wait = rateLimitMs(error)
    if (wait !== null) this.blockedUntil = Math.max(this.blockedUntil, this.options.now() + wait)
    const message = wait === null
      ? `${what}: ${error instanceof Error ? error.message : String(error)}`
      : `${what}: rate limited by the homeserver; trying again in ${Math.ceil(wait / 1000)} s`
    if (message !== this.lastError) this.options.log(`[ROOMS] ${message}`)
    this.lastError = message
  }

  /** In a pass: a rate limit ends it. */
  private passFailed(what: string, error: unknown): void {
    this.failed(what, error)
    if (rateLimitMs(error) !== null) throw new RateLimited()
  }

  /** The room made for `requestId` earlier, found by its stamp among the rooms the bot is in. */
  private async stamped(requestId: string): Promise<string | undefined> {
    const known = this.stamps.get(requestId)
    if (known !== undefined) return known
    for (const roomId of await this.options.matrix.joinedRooms()) {
      if (this.stampScanned.has(roomId)) continue
      const create = await this.options.matrix.stateEvent(roomId, "m.room.create", "")
      this.stampScanned.add(roomId)
      const stamp = create?.[REQUEST_STAMP]
      if (typeof stamp === "string") this.stamps.set(stamp, roomId)
    }
    return this.stamps.get(requestId)
  }

  /** Creates (or finds) the room for one wanted request and reports it; true when the registry changed. */
  private async ensure(want: RoomWanted, registry: RoomsResponse): Promise<boolean> {
    try {
      let roomId = await this.stamped(want.requestId)
      if (roomId === undefined) {
        const options = createOptions(want, registry, this.options.botUserId)
        if (options === null) return false
        roomId = await this.options.matrix.createRoom(options)
        this.stamps.set(want.requestId, roomId)
        this.stampScanned.add(roomId)
        this.options.log(`[ROOMS] created ${want.kind} ${roomId} for ${want.requestId}`)
      }
      await this.options.relay.created(want.requestId, roomId)
      return true
    } catch (error) {
      this.passFailed(`room for ${want.requestId} not made`, error)
      return false
    }
  }

  /** Project rooms and configured rooms are listed in the Space, once each. */
  private async ensureChildren(registry: RoomsResponse): Promise<void> {
    const space = registry.space
    if (space === null) return
    const listed = registry.rooms.filter((room) => room.kind === "project" || room.kind === "questions").map((room) => room.roomId)
    const rooms = [...registry.spaceChildren, ...listed]
    for (const roomId of rooms) {
      const key = `${space}\u0000${roomId}`
      if (this.children.has(key)) continue
      try {
        const existing = await this.options.matrix.stateEvent(space, "m.space.child", roomId)
        if (!Array.isArray(existing?.["via"])) {
          await this.options.matrix.sendState(space, "m.space.child", roomId, { via: [serverOf(this.options.botUserId)] })
        }
        this.children.add(key)
      } catch (error) {
        this.passFailed(`${roomId} not listed in the Space`, error)
      }
    }
  }

  /** The direct chat is in the bot's `m.direct`, under each owner. */
  private async ensureDirect(registry: RoomsResponse): Promise<void> {
    const dm = registry.rooms.find((room) => room.kind === "dm")
    if (!dm || this.directDone === dm.roomId) return
    try {
      const direct = await this.options.matrix.accountData("m.direct")
      let changed = false
      const next: Record<string, unknown> = { ...direct }
      for (const owner of registry.owners) {
        const listed = Array.isArray(direct[owner]) ? direct[owner].filter((id): id is string => typeof id === "string") : []
        if (listed.includes(dm.roomId)) continue
        next[owner] = [...listed, dm.roomId]
        changed = true
      }
      if (changed) await this.options.matrix.setAccountData("m.direct", next)
      this.directDone = dm.roomId
    } catch (error) {
      this.passFailed("the direct chat not marked direct", error)
    }
  }

  /** Every owner's membership in every registry room: new rooms at once, all of them every few minutes. */
  private async scanMemberships(registry: RoomsResponse): Promise<void> {
    const rescan = this.options.now() - this.lastRescan >= MEMBERSHIP_RESCAN_MS
    if (rescan) this.lastRescan = this.options.now()
    for (const room of registry.rooms) {
      for (const owner of registry.owners) {
        if (!rescan && this.reported.has(`${room.roomId}\u0000${owner}`)) continue
        try {
          const member = await this.options.matrix.stateEvent(room.roomId, "m.room.member", owner)
          const membership = member?.["membership"]
          await this.report(room.roomId, owner, isMembership(membership) ? membership : "leave")
        } catch (error) {
          this.passFailed(`membership in ${room.roomId} not read`, error)
        }
      }
    }
  }

  private async report(roomId: string, user: string, membership: OwnerMembership): Promise<void> {
    const key = `${roomId}\u0000${user}`
    if (this.reported.get(key) === membership) return
    await this.options.relay.member(roomId, user, membership)
    this.reported.set(key, membership)
  }

  /** A membership event the connector saw: an owner's, reported; the bot's own leave, the room's end. */
  async memberEvent(roomId: string, event: unknown): Promise<void> {
    if (!isRecord(event) || event["type"] !== "m.room.member" || !this.registered(roomId)) return
    const user = event["state_key"]
    const content = event["content"]
    const membership = isRecord(content) ? content["membership"] : undefined
    if (typeof user !== "string" || !isMembership(membership)) return
    try {
      if (user === this.options.botUserId) {
        if (membership === "leave" || membership === "ban") await this.left(roomId)
        return
      }
      if (this.registry?.owners.includes(user)) await this.report(roomId, user, membership)
    } catch (error) {
      this.failed(`membership in ${roomId} not reported`, error)
    }
  }

  /** The bot is out of a registry room. */
  async left(roomId: string): Promise<void> {
    if (!this.registered(roomId)) return
    this.allowed.delete(roomId)
    try {
      await this.options.relay.gone(roomId)
    } catch (error) {
      this.failed(`${roomId} not reported gone`, error)
    }
    await this.sync()
  }

  /**
   * The bot joined a room an owner invited it to that is neither configured
   * nor in the registry. With named rooms served, it binds by its name or is
   * left with the reason; otherwise nothing changes.
   */
  async invited(roomId: string, inviter: string): Promise<void> {
    if (this.registered(roomId)) return
    if (this.registry === null) await this.sync()
    if (!this.registry?.named) return
    try {
      if (await this.bind(roomId, inviter, "invite")) await this.sync()
    } catch (error) {
      this.failed(`${roomId} not bound`, error)
    }
  }

  /**
   * Rooms an owner listed in the Space whose name the relay may bind: joined
   * as a Space member and claimed, each once per name. True when one bound.
   */
  private async discover(registry: RoomsResponse): Promise<boolean> {
    const space = registry.space
    if (!registry.named || space === null || this.options.now() - this.lastDiscovery < DISCOVERY_MS) return false
    this.lastDiscovery = this.options.now()
    let children: SpaceChild[]
    try {
      children = await this.options.matrix.hierarchy(space)
    } catch (error) {
      this.passFailed("the Space's rooms not read", error)
      return false
    }
    let bound = false
    for (const child of children) {
      if (this.registered(child.roomId) || registry.spaceChildren.includes(child.roomId)) continue
      if (!registry.owners.includes(child.listedBy) || !BINDING_NAME.test(child.name)) continue
      if (this.tried.get(child.roomId) === child.name) continue
      try {
        await this.options.matrix.join(child.roomId, [serverOf(this.options.botUserId)])
      } catch (error) {
        this.passFailed(`${child.roomId} in the Space not joined`, error)
        this.tried.set(child.roomId, child.name)
        continue
      }
      this.tried.set(child.roomId, child.name)
      this.options.log(`[ROOMS] joined ${child.roomId}, listed in the Space`)
      try {
        bound = (await this.bind(child.roomId, child.listedBy, "space")) || bound
      } catch (error) {
        this.passFailed(`${child.roomId} not bound`, error)
      }
    }
    return bound
  }

  /** Claims a room the bot is in by its name: bound, or told why not and left. True when bound. */
  private async bind(roomId: string, owner: string, source: RoomClaimSource): Promise<boolean> {
    const nameEvent = await this.options.matrix.stateEvent(roomId, "m.room.name", "")
    const name = typeof nameEvent?.["name"] === "string" ? nameEvent["name"] : ""
    const encrypted = (await this.options.matrix.stateEvent(roomId, "m.room.encryption", "")) !== null
    const response = await this.options.relay.claim(roomId, owner, name, encrypted, source)
    if (response.state === "bound") {
      this.allowed.add(roomId)
      this.options.allowedRoom?.(roomId)
      await this.options.matrix.notice(roomId, boundNotice(response))
      this.options.log(`[ROOMS] ${roomId} bound by its name to a ${response.kind}`)
      return true
    }
    await this.options.matrix.notice(roomId, `Not bound: ${response.reason}.`)
    await this.options.matrix.leave(roomId)
    this.options.log(`[ROOMS] ${roomId} refused: ${response.reason}`)
    return false
  }
}
