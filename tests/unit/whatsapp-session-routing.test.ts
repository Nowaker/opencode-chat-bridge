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

describe("a denied group names itself", () => {
  function withSocket(groupMetadata?: () => Promise<{ subject: string }>) {
    const built = buildConnector()
    const lines: string[] = []
    ;(built.connector as any).log = (message: string) => void lines.push(message)
    ;(built.connector as any).logError = (message: string) => void lines.push(message)
    ;(built.connector as any).sock = {
      sendMessage: async () => ({ key: { id: "x" } }),
      ...(groupMetadata ? { groupMetadata } : {}),
    }
    return { ...built, lines }
  }

  const settle = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }

  async function deny(connector: WhatsAppConnector, id: string) {
    await (connector as any).handleMessage(inbound({ id, remoteJid: OTHER_GROUP }))
  }

  test("asks the socket once however many messages the group sends", async () => {
    let calls = 0
    const { connector, lines } = withSocket(async () => {
      calls += 1
      return { subject: "Vibeterm AI" }
    })

    await deny(connector, "d1")
    await deny(connector, "d2")
    await settle()

    expect(calls).toBe(1)
    expect(lines.some((line) => line.includes('is named "Vibeterm AI"'))).toBe(true)
  })

  test("carries the name inline once it is known", async () => {
    const { connector, lines } = withSocket(async () => ({ subject: "Vibeterm AI" }))

    await deny(connector, "d1")
    await settle()
    lines.length = 0
    await deny(connector, "d2")

    expect(lines.some((line) => line.includes(`${OTHER_GROUP} ("Vibeterm AI")`))).toBe(true)
  })

  test("asks again after a failed lookup rather than staying silent forever", async () => {
    let calls = 0
    const { connector } = withSocket(async () => {
      calls += 1
      throw new Error("not a participant")
    })

    await deny(connector, "d1")
    await settle()
    await deny(connector, "d2")
    await settle()

    expect(calls).toBe(2)
  })

  test("still refuses the message when the socket cannot name the group", async () => {
    const { connector, routed, lines } = withSocket()

    await deny(connector, "d1")

    expect(routed).toHaveLength(0)
    expect(lines.some((line) => line.includes(OTHER_GROUP))).toBe(true)
  })
})

describe("an allowlist matching nothing names the groups it can see", () => {
  type Roster = Record<string, { subject?: string }>

  function withRoster(groups: Roster | (() => Promise<Roster>), extra: Record<string, unknown> = {}) {
    const built = buildConnector()
    const lines: string[] = []
    ;(built.connector as any).log = (message: string) => void lines.push(message)
    ;(built.connector as any).logError = (message: string) => void lines.push(message)
    ;(built.connector as any).sock = {
      sendMessage: async () => ({ key: { id: "x" } }),
      groupFetchAllParticipating: typeof groups === "function" ? groups : async () => groups,
      ...extra,
    }
    return { ...built, lines }
  }

  const survey = (connector: WhatsAppConnector) => (connector as any).surveyGroups()

  test("prints every jid with its subject when none of them is allowlisted", async () => {
    const { connector, lines } = withRoster({
      [OTHER_GROUP]: { subject: "Vibeterm AI" },
      "120363111111111111@g.us": { subject: "Weekend plans" },
    })

    await survey(connector)

    expect(lines.some((line) => line.includes(OTHER_GROUP) && line.includes("Vibeterm AI"))).toBe(true)
    expect(lines.some((line) => line.includes("Weekend plans"))).toBe(true)
  })

  test("stays silent once one of them is allowlisted", async () => {
    const { connector, lines } = withRoster({
      [GROUP]: { subject: "Vibeterm AI" },
      [OTHER_GROUP]: { subject: "Weekend plans" },
    })

    await survey(connector)

    expect(lines.some((line) => line.includes(OTHER_GROUP))).toBe(false)
  })

  test("seeds the subject cache so a later denial needs no second query", async () => {
    let metadataCalls = 0
    const { connector, lines } = withRoster(
      { [OTHER_GROUP]: { subject: "Vibeterm AI" } },
      {
        groupMetadata: async () => {
          metadataCalls += 1
          return { subject: "Vibeterm AI" }
        },
      },
    )

    await survey(connector)
    lines.length = 0
    await (connector as any).handleMessage(inbound({ id: "d1", remoteJid: OTHER_GROUP }))

    expect(metadataCalls).toBe(0)
    expect(lines.some((line) => line.includes(`${OTHER_GROUP} ("Vibeterm AI")`))).toBe(true)
  })

  test("survives a socket that cannot list groups", async () => {
    const { connector, lines } = withRoster(async () => {
      throw new Error("not authorized")
    })

    await survey(connector)

    expect(lines.some((line) => line.includes("not authorized"))).toBe(true)
  })
})
