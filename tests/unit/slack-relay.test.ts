import { describe, expect, test } from "bun:test"
import { SlackConnector } from "../../connectors/slack"
import type { InboundRequest, InboundResponse, OutboxItem, OutboxResponse } from "../../src/relay/types"

const OWNER = "U0OWNER"
const CHANNEL = "C0CHANNEL"

class FakeRelay {
  inbound_: InboundRequest[] = []
  acks: Array<[string, string]> = []
  nacks: Array<[string, string, boolean]> = []
  async inbound(request: InboundRequest): Promise<InboundResponse> {
    this.inbound_.push(request)
    return { state: "accepted", relayId: "rly_x" }
  }
  async outbox(): Promise<OutboxResponse> {
    return { items: [], typingRooms: [] }
  }
  async ack(outboxId: string, chatEventId: string): Promise<void> {
    this.acks.push([outboxId, chatEventId])
  }
  async nack(outboxId: string, error: string, definite: boolean): Promise<void> {
    this.nacks.push([outboxId, error, definite])
  }
  async health(): Promise<Record<string, unknown>> {
    return {}
  }
}

function setup() {
  const relay = new FakeRelay()
  const connector = new SlackConnector({ relay })
  ;(connector as any).allowedUsers = new Set([OWNER])
  ;(connector as any).allowedChannels = new Set([CHANNEL])
  const handlers: Record<string, any> = {}
  connector.registerHandlers({
    event: (_name: string, fn: any) => { handlers.mention = fn },
    message: (first: any, second?: any) => {
      if (typeof first === "function") handlers.thread = first
      else handlers.trigger = second
    },
  } as any)
  const posts: any[] = []
  const client = { chat: { postMessage: async (payload: any) => { posts.push(payload); return { ts: "1794.000200" } } } }
  return { relay, connector, handlers, client, posts }
}

describe("Slack relay mode", () => {
  test("a trigger message, a mention and a thread reply reach the relay, never an agent", async () => {
    const { relay, handlers, client } = setup()
    await handlers.trigger({ message: { text: "!oc status please", user: OWNER, channel: CHANNEL, ts: "1794.000100" }, body: {}, client })
    await handlers.mention({ event: { text: "<@UBOT> hello", user: OWNER, channel: CHANNEL, ts: "1794.000101", thread_ts: "1794.000100" }, body: {}, client })
    await handlers.thread({ message: { text: "2", user: OWNER, channel: CHANNEL, ts: "1794.000102", thread_ts: "1794.000050" }, body: {}, client })
    expect(relay.inbound_.map(({ eventId, roomId, threadRootId, text, implicit }) => ({ eventId, roomId, threadRootId, text, implicit }))).toEqual([
      { eventId: "1794.000100", roomId: CHANNEL, threadRootId: "", text: "status please", implicit: false },
      { eventId: "1794.000101", roomId: CHANNEL, threadRootId: "1794.000100", text: "hello", implicit: false },
      { eventId: "1794.000102", roomId: CHANNEL, threadRootId: "1794.000050", text: "2", implicit: true },
    ])
    expect(relay.inbound_[0]!.postedAt).toBe(1_794_000)
  })

  test("a sender or channel off the allowlist never reaches the relay", async () => {
    const { relay, handlers, client } = setup()
    await handlers.trigger({ message: { text: "!oc hi", user: "U0STRANGER", channel: CHANNEL, ts: "1794.000300" }, body: {}, client })
    await handlers.trigger({ message: { text: "!oc hi", user: OWNER, channel: "C0OTHER", ts: "1794.000301" }, body: {}, client })
    expect(relay.inbound_).toEqual([])
  })

  test("a post goes into its thread and is acknowledged with its ts; a Slack refusal is definite", async () => {
    const { relay, connector, client, posts } = setup()
    const item: OutboxItem = { outboxId: "obx_1", txnId: "aibr-obx_1", roomId: CHANNEL, threadRootId: "1794.000100", replyToEventId: "1794.000100", text: "done", kind: "reply" }
    await connector.deliverRelayItem(client, item)
    expect(posts[0]).toMatchObject({ channel: CHANNEL, text: "done", thread_ts: "1794.000100" })
    expect(relay.acks).toEqual([["obx_1", "1794.000200"]])

    await connector.deliverRelayItem(client, { ...item, outboxId: "obx_2", threadRootId: "", kind: "attention" })
    expect(posts[1].thread_ts).toBeUndefined()

    const refusing = { chat: { postMessage: async () => { throw Object.assign(new Error("not_in_channel"), { code: "slack_webapi_platform_error" }) } } }
    await connector.deliverRelayItem(refusing, { ...item, outboxId: "obx_3" })
    const flaky = { chat: { postMessage: async () => { throw new Error("socket hang up") } } }
    await connector.deliverRelayItem(flaky, { ...item, outboxId: "obx_4" })
    expect(relay.nacks.map(([id, , definite]) => [id, definite])).toEqual([["obx_3", true], ["obx_4", false]])
  })
})
