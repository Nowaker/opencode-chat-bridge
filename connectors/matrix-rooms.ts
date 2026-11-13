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
 * - binds a room an owner created and invited the bot to, by its name, when
 *   the relay serves named rooms: the relay checks the name, the inviter and
 *   the room's encryption; a refused room gets the reason and the bot leaves.
 *
 * A registry room's id joins the connector's allowlist once the relay has it;
 * the Space never does, as it carries no messages.
 */

import type { OwnerMembership, RoomClaimResponse, RoomsResponse, RoomWanted } from "../src/relay/types"
import { OWNER_MEMBERSHIPS } from "../src/relay/types"

/** The creation-content key a created room carries its relay request id under. */
export const REQUEST_STAMP = "org.vibeterm.request_id"
/** Every owner's membership in every registry room is read again this often; events keep it current in between. */
const MEMBERSHIP_RESCAN_MS = 5 * 60_000

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
}

export interface RoomsRelayPort {
  rooms(): Promise<RoomsResponse>
  created(requestId: string, roomId: string): Promise<void>
  member(roomId: string, user: string, membership: OwnerMembership): Promise<void>
  claim(roomId: string, inviter: string, name: string, encrypted: boolean): Promise<RoomClaimResponse>
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
    case "project": {
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
    let registry: RoomsResponse
    try {
      registry = await this.options.relay.rooms()
    } catch (error) {
      this.failed("rooms not read from the relay", error)
      return
    }
    this.adopt(registry)
    let changed = false
    for (const want of registry.wanted) changed = (await this.ensure(want, registry)) || changed
    if (changed) {
      try {
        this.adopt(await this.options.relay.rooms())
      } catch (error) {
        this.failed("rooms not read again from the relay", error)
        return
      }
    }
    const current = this.registry ?? registry
    await this.ensureChildren(current)
    await this.ensureDirect(current)
    await this.scanMemberships(current)
    this.lastError = ""
  }

  private adopt(registry: RoomsResponse): void {
    this.registry = registry
    const before = new Set(this.allowed)
    this.allowed.clear()
    for (const room of registry.rooms) if (room.kind !== "space") this.allowed.add(room.roomId)
    for (const roomId of this.allowed) if (!before.has(roomId)) this.options.allowedRoom?.(roomId)
  }

  private failed(what: string, error: unknown): void {
    const message = `${what}: ${error instanceof Error ? error.message : String(error)}`
    if (message !== this.lastError) this.options.log(`[ROOMS] ${message}`)
    this.lastError = message
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
      this.failed(`room for ${want.requestId} not made`, error)
      return false
    }
  }

  /** Project rooms and configured rooms are listed in the Space, once each. */
  private async ensureChildren(registry: RoomsResponse): Promise<void> {
    const space = registry.space
    if (space === null) return
    const rooms = [...registry.spaceChildren, ...registry.rooms.filter((room) => room.kind === "project").map((room) => room.roomId)]
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
        this.failed(`${roomId} not listed in the Space`, error)
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
      this.failed("the direct chat not marked direct", error)
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
          this.failed(`membership in ${room.roomId} not read`, error)
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
      const nameEvent = await this.options.matrix.stateEvent(roomId, "m.room.name", "")
      const name = typeof nameEvent?.["name"] === "string" ? nameEvent["name"] : ""
      const encrypted = (await this.options.matrix.stateEvent(roomId, "m.room.encryption", "")) !== null
      const response = await this.options.relay.claim(roomId, inviter, name, encrypted)
      if (response.state === "bound") {
        this.allowed.add(roomId)
        this.options.allowedRoom?.(roomId)
        await this.options.matrix.notice(roomId, boundNotice(response))
        this.options.log(`[ROOMS] ${roomId} bound by its name to a ${response.kind}`)
        await this.sync()
        return
      }
      await this.options.matrix.notice(roomId, `Not bound: ${response.reason}.`)
      await this.options.matrix.leave(roomId)
      this.options.log(`[ROOMS] ${roomId} refused: ${response.reason}`)
    } catch (error) {
      this.failed(`${roomId} not bound`, error)
    }
  }
}
