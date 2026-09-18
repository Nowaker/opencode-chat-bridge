/**
 * WhatsApp routes the allowed group to exactly one session.
 *
 * These drive the connector's real inbound path so a regression in keying --
 * a session per message, or a message landing on an unrelated session -- is
 * caught rather than assumed.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { WhatsAppConnector } from "../../connectors/whatsapp"

const GROUP = "120363000000000000@g.us"
const OTHER_GROUP = "120363999999999999@g.us"
const OWNER = "15551234567"

interface Routed {
  chatId: string
  senderId: string
  query: string
}

function buildConnector(): { connector: WhatsAppConnector; routed: Routed[] } {
  const connector = new WhatsAppConnector()
  const routed: Routed[] = []

  // The module-level allowlists come from config at import time; per-instance
  // sets are what isChannelAllowed/isUserAllowed actually consult.
  ;(connector as any).allowedChannels = new Set([GROUP])
  ;(connector as any).allowedUsers = new Set([OWNER])
  ;(connector as any).sock = { sendMessage: async () => ({ key: { id: "x" } }) }
  // Rate limiting is exercised on its own below; it would otherwise swallow
  // the later messages of every multi-message case.
  ;(connector as any).config.rateLimitSeconds = 0
  ;(connector as any).processQuery = async (chatId: string, senderId: string, query: string) => {
    routed.push({ chatId, senderId, query })
  }

  return { connector, routed }
}

function inbound(overrides: Record<string, any> = {}) {
  return {
    key: {
      id: overrides.id || `msg-${Math.random()}`,
      remoteJid: overrides.remoteJid || GROUP,
      participant: overrides.participant || `${OWNER}@s.whatsapp.net`,
      fromMe: overrides.fromMe ?? false,
    },
    message: { conversation: overrides.text || "!oc hello" },
  }
}

describe("WhatsApp session routing", () => {
  let connector: WhatsAppConnector
  let routed: Routed[]

  beforeEach(() => {
    const built = buildConnector()
    connector = built.connector
    routed = built.routed
  })

  async function deliver(msg: any) {
    await (connector as any).handleMessage(msg)
  }

  test("routes every message from the group to one session key", async () => {
    await deliver(inbound({ id: "m1", text: "!oc first" }))
    await deliver(inbound({ id: "m2", text: "!oc second" }))
    await deliver(inbound({ id: "m3", text: "!oc third" }))

    expect(routed).toHaveLength(3)
    expect(new Set(routed.map((entry) => entry.chatId))).toEqual(new Set([GROUP]))
  })

  test("keys the session on the stable group JID", async () => {
    await deliver(inbound({ id: "m1" }))

    expect(routed[0].chatId).toBe(GROUP)
  })

  test("routes nothing from a group that is not allowlisted", async () => {
    await deliver(inbound({ id: "m1", remoteJid: OTHER_GROUP }))

    expect(routed).toHaveLength(0)
  })

  test("routes nothing from a sender who is not allowlisted", async () => {
    await deliver(inbound({ id: "m1", participant: "15559999999@s.whatsapp.net" }))

    expect(routed).toHaveLength(0)
  })

  test("does not start a second turn for a redelivered message", async () => {
    const duplicate = inbound({ id: "retry-1", text: "!oc once" })

    await deliver(duplicate)
    await deliver(duplicate)

    expect(routed).toHaveLength(1)
  })

  test("does not route the bridge's own echoed output", async () => {
    await deliver(inbound({ id: "m1", text: "[AI] here is the answer", fromMe: true }))

    expect(routed).toHaveLength(0)
  })

  test("still routes the owner's own messages in the group", async () => {
    await deliver(inbound({ id: "m1", text: "!oc from my own phone", fromMe: true }))

    expect(routed).toHaveLength(1)
    expect(routed[0].chatId).toBe(GROUP)
  })

  test("rate limits a burst from one sender", async () => {
    ;(connector as any).config.rateLimitSeconds = 60

    await deliver(inbound({ id: "m1", text: "!oc first" }))
    await deliver(inbound({ id: "m2", text: "!oc second" }))

    expect(routed).toHaveLength(1)
  })
})
