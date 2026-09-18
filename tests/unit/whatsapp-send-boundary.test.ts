/**
 * The WhatsApp send boundary must mark every outbound text.
 *
 * These tests drive the real connector rather than the formatting helper, so
 * they fail if a send path is ever added that bypasses the choke point.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { WhatsAppConnector } from "../../connectors/whatsapp"
import { AI_PREFIX, WHATSAPP_MAX_MESSAGE_LENGTH } from "../../src/whatsapp-format"

interface SentPayload {
  chatId: string
  content: any
}

function attachFakeSocket(connector: WhatsAppConnector): SentPayload[] {
  const sent: SentPayload[] = []
  let counter = 0
  ;(connector as any).sock = {
    sendMessage: async (chatId: string, content: any) => {
      sent.push({ chatId, content })
      return { key: { id: `emitted-${++counter}`, remoteJid: chatId, fromMe: true } }
    },
    sendPresenceUpdate: async () => {},
  }
  return sent
}

function textsOf(sent: SentPayload[]): string[] {
  return sent.filter((item) => typeof item.content.text === "string").map((item) => item.content.text)
}

describe("WhatsApp send boundary", () => {
  let connector: WhatsAppConnector
  let sent: SentPayload[]

  beforeEach(() => {
    connector = new WhatsAppConnector()
    sent = attachFakeSocket(connector)
  })

  test("marks a short answer", async () => {
    await connector.sendMessage("123@g.us", "all done")

    expect(textsOf(sent)).toEqual(["[AI] all done"])
  })

  test("marks EVERY chunk of a multi-chunk answer", async () => {
    const body = "x".repeat(WHATSAPP_MAX_MESSAGE_LENGTH * 3)

    await connector.sendMessage("123@g.us", body)

    const texts = textsOf(sent)
    expect(texts.length).toBeGreaterThan(1)
    for (const text of texts) {
      expect(text.startsWith(AI_PREFIX)).toBe(true)
      expect(text.length).toBeLessThanOrEqual(WHATSAPP_MAX_MESSAGE_LENGTH)
    }
  })

  test("marks every chunk when the answer splits on line boundaries", async () => {
    const body = Array.from({ length: 900 }, (_, i) => `result line ${i} with padding text`).join("\n")

    await connector.sendMessage("123@g.us", body)

    const texts = textsOf(sent)
    expect(texts.length).toBeGreaterThan(1)
    for (const text of texts) {
      expect(text.startsWith(AI_PREFIX)).toBe(true)
    }
  })

  test("marks tool activity notices", async () => {
    await (connector as any).createToolActivityMessage("123@g.us", "[read]")

    expect(textsOf(sent)).toEqual(["[AI] > [read]"])
  })

  test("marks tool activity edits", async () => {
    await (connector as any).updateToolActivityMessage("123@g.us", "emitted-1", "Tool trace")

    const texts = textsOf(sent)
    expect(texts).toHaveLength(1)
    expect(texts[0].startsWith(AI_PREFIX)).toBe(true)
    expect(sent[0].content.edit).toBeDefined()
  })

  test("marks image captions", async () => {
    await (connector as any).sendImageFromBase64("123@g.us", {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from("fake").toString("base64"),
      alt: "chart",
    })

    expect(sent[0].content.caption).toBe("[AI] chart")
  })

  test("sends nothing for blank text rather than a bare marker", async () => {
    await connector.sendMessage("123@g.us", "   \n  ")

    expect(sent).toHaveLength(0)
  })
})

describe("WhatsApp own-message handling", () => {
  let connector: WhatsAppConnector

  beforeEach(() => {
    connector = new WhatsAppConnector()
    attachFakeSocket(connector)
  })

  test("rejects an echo of a message this process emitted", async () => {
    await connector.sendMessage("123@g.us", "all done")

    const echo = { key: { id: "emitted-1", remoteJid: "123@g.us", fromMe: true } }
    expect((connector as any).isOwnEmittedMessage(echo, "[AI] all done")).toBe(true)
  })

  test("rejects a marked own message whose id is no longer tracked", () => {
    const echo = { key: { id: "from-before-restart", remoteJid: "123@g.us", fromMe: true } }

    expect((connector as any).isOwnEmittedMessage(echo, "[AI] older answer")).toBe(true)
  })

  test("processes the human's own messages in the group", () => {
    const human = { key: { id: "human-1", remoteJid: "123@g.us", fromMe: true } }

    expect((connector as any).isOwnEmittedMessage(human, "!oc what is the status?")).toBe(false)
  })

  test("processes a human message that merely mentions the marker", () => {
    const human = { key: { id: "human-2", remoteJid: "123@g.us", fromMe: true } }

    expect((connector as any).isOwnEmittedMessage(human, "why does it print [AI] twice?")).toBe(false)
  })

  test("does not treat another participant's marked text as our own emission", () => {
    const other = { key: { id: "other-1", remoteJid: "123@g.us", fromMe: false } }

    expect((connector as any).isOwnEmittedMessage(other, "[AI] spoofed")).toBe(false)
  })

  test("bounds the emitted-id registry", async () => {
    for (let i = 0; i < 600; i++) {
      await connector.sendMessage("123@g.us", `message ${i}`)
    }

    expect((connector as any).sentMessageIds.size).toBeLessThanOrEqual(500)
  })
})
