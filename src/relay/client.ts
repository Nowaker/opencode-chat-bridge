/**
 * The connector's side of the relay socket.
 */

import type {
  InboundRequest,
  InboundResponse,
  OutboxResponse,
  RelayRoute,
  RoomClaimRequest,
  RoomClaimResponse,
  RoomCreatedRequest,
  RoomGoneRequest,
  RoomMemberRequest,
  RoomsResponse,
  TypingRequest,
} from "./types"

/** `status` is absent when the relay was not reached at all. */
export class RelayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = "RelayError"
  }

  /** A 4xx will be refused again; anything else may succeed on a retry. */
  get retryable(): boolean {
    return this.status === undefined || this.status >= 500
  }
}

export class RelayClient {
  constructor(private readonly socketPath: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`http://relay${path}`, {
        method,
        unix: this.socketPath,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit)
    } catch (error) {
      throw new RelayError(`relay ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const payload = (await response.json().catch(() => null)) as T & { error?: string }
    if (!response.ok) {
      throw new RelayError(`relay ${path}: HTTP ${response.status}${payload?.error ? ` ${payload.error}` : ""}`, response.status)
    }
    return payload
  }

  inbound(request: InboundRequest): Promise<InboundResponse> {
    return this.call("POST", "/v1/inbound", request, 15_000)
  }

  /** `reactions`: this connector posts `reaction` items; without it the relay never offers them. */
  outbox(route: RelayRoute, waitMs: number, options: { reactions?: boolean } = {}): Promise<OutboxResponse> {
    const reactions = options.reactions ? "&reactions=1" : ""
    return this.call("GET", `/v1/outbox?route=${route}&waitMs=${waitMs}${reactions}`, undefined, waitMs + 15_000)
  }

  async ack(outboxId: string, chatEventId: string): Promise<void> {
    await this.call("POST", "/v1/outbox/ack", { outboxId, chatEventId }, 15_000)
  }

  async nack(outboxId: string, error: string, definite: boolean): Promise<void> {
    await this.call("POST", "/v1/outbox/nack", { outboxId, error, definite }, 15_000)
  }

  async typing(request: TypingRequest): Promise<void> {
    await this.call("POST", "/v1/typing", request, 5_000)
  }

  rooms(route: RelayRoute): Promise<RoomsResponse> {
    return this.call("GET", `/v1/rooms?route=${route}`, undefined, 10_000)
  }

  async roomCreated(request: RoomCreatedRequest): Promise<void> {
    await this.call("POST", "/v1/rooms/created", request, 10_000)
  }

  async roomMember(request: RoomMemberRequest): Promise<void> {
    await this.call("POST", "/v1/rooms/member", request, 10_000)
  }

  roomClaim(request: RoomClaimRequest): Promise<RoomClaimResponse> {
    return this.call("POST", "/v1/rooms/claim", request, 15_000)
  }

  async roomGone(request: RoomGoneRequest): Promise<void> {
    await this.call("POST", "/v1/rooms/gone", request, 10_000)
  }

  health(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v1/health", undefined, 10_000)
  }
}
