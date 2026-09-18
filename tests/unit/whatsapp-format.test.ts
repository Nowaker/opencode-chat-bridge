/**
 * Unit tests for whatsapp-format.ts
 */

import { describe, test, expect } from "bun:test"
import {
  AI_PREFIX,
  WHATSAPP_MAX_MESSAGE_LENGTH,
  applyAiPrefix,
  buildAiMessageChunks,
  looksLikeBridgeEcho,
} from "../../src/whatsapp-format"

describe("AI_PREFIX", () => {
  test("is exactly the required marker", () => {
    expect(AI_PREFIX).toBe("[AI] ")
  })
})

describe("applyAiPrefix", () => {
  test("prefixes text", () => {
    expect(applyAiPrefix("hello")).toBe("[AI] hello")
  })
})

describe("buildAiMessageChunks", () => {
  test("returns a single prefixed chunk for short text", () => {
    expect(buildAiMessageChunks("hello")).toEqual(["[AI] hello"])
  })

  test("returns nothing for blank input", () => {
    expect(buildAiMessageChunks("")).toEqual([])
    expect(buildAiMessageChunks("   \n  ")).toEqual([])
  })

  test("prefixes EVERY chunk of a multi-chunk message", () => {
    const body = "x".repeat(WHATSAPP_MAX_MESSAGE_LENGTH * 3)
    const chunks = buildAiMessageChunks(body)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith(AI_PREFIX)).toBe(true)
    }
  })

  test("keeps every chunk within the platform limit once prefixed", () => {
    const body = "y".repeat(WHATSAPP_MAX_MESSAGE_LENGTH * 3)
    const chunks = buildAiMessageChunks(body)

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(WHATSAPP_MAX_MESSAGE_LENGTH)
    }
  })

  test("prefixes every chunk when splitting on line boundaries", () => {
    const line = "line content here"
    const body = Array.from({ length: 600 }, () => line).join("\n")
    const chunks = buildAiMessageChunks(body, 200)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith(AI_PREFIX)).toBe(true)
      expect(chunk.length).toBeLessThanOrEqual(200)
    }
  })

  test("preserves the full message body across chunks", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n")
    const chunks = buildAiMessageChunks(body, 60)
    const rejoined = chunks.map((chunk) => chunk.slice(AI_PREFIX.length)).join("\n")

    expect(rejoined).toBe(body)
  })

  test("prefixes a chunk even when a single line exceeds the budget", () => {
    const chunks = buildAiMessageChunks("z".repeat(500), 100)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith(AI_PREFIX)).toBe(true)
      expect(chunk.length).toBeLessThanOrEqual(100)
    }
  })
})

describe("looksLikeBridgeEcho", () => {
  test("recognises the bridge's own marker", () => {
    expect(looksLikeBridgeEcho("[AI] done")).toBe(true)
  })

  test("does not claim a human message is an echo", () => {
    expect(looksLikeBridgeEcho("what is the status?")).toBe(false)
    expect(looksLikeBridgeEcho("!oc build it")).toBe(false)
  })

  test("does not treat a mention of the marker mid-text as an echo", () => {
    expect(looksLikeBridgeEcho("why does it print [AI] twice?")).toBe(false)
  })
})
