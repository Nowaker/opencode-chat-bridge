/**
 * Unit tests for whatsapp-format.ts
 */

import { describe, test, expect, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { clearConfigCache, loadConfig } from "../../src/config"
import {
  DEFAULT_AI_PREFIX,
  aiPrefix,
  WHATSAPP_MAX_MESSAGE_LENGTH,
  applyAiPrefix,
  buildAiMessageChunks,
  looksLikeBridgeEcho,
} from "../../src/whatsapp-format"

describe("aiPrefix", () => {
  test("defaults to the required marker", () => {
    expect(DEFAULT_AI_PREFIX).toBe("[AI] ")
    expect(aiPrefix()).toBe("[AI] ")
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
      expect(chunk.startsWith(aiPrefix())).toBe(true)
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
      expect(chunk.startsWith(aiPrefix())).toBe(true)
      expect(chunk.length).toBeLessThanOrEqual(200)
    }
  })

  test("preserves the full message body across chunks", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n")
    const chunks = buildAiMessageChunks(body, 60)
    const rejoined = chunks.map((chunk) => chunk.slice(aiPrefix().length)).join("\n")

    expect(rejoined).toBe(body)
  })

  test("prefixes a chunk even when a single line exceeds the budget", () => {
    const chunks = buildAiMessageChunks("z".repeat(500), 100)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith(aiPrefix())).toBe(true)
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

describe("a configured marker", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    clearConfigCache()
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  function loadWhatsAppConfig(whatsapp: Record<string, unknown>): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-prefix-"))
    tempDirs.push(dir)
    const configPath = path.join(dir, "chat-bridge.json")
    fs.writeFileSync(configPath, JSON.stringify({ whatsapp }))
    clearConfigCache()
    loadConfig(configPath)
  }

  test("replaces the default at every call site", () => {
    loadWhatsAppConfig({ aiPrefix: ">> " })

    expect(aiPrefix()).toBe(">> ")
    expect(applyAiPrefix("hello")).toBe(">> hello")
    expect(buildAiMessageChunks("hello")).toEqual([">> hello"])
    expect(looksLikeBridgeEcho(">> done")).toBe(true)
    expect(looksLikeBridgeEcho("[AI] done")).toBe(false)
  })

  test("is refused when blank, which would match every inbound message", () => {
    loadWhatsAppConfig({ aiPrefix: "   " })

    expect(aiPrefix()).toBe(DEFAULT_AI_PREFIX)
    expect(looksLikeBridgeEcho("what is the status?")).toBe(false)
  })

  test("is refused when not a string", () => {
    loadWhatsAppConfig({ aiPrefix: 42 })

    expect(aiPrefix()).toBe(DEFAULT_AI_PREFIX)
  })

  test("keeps chunks inside the platform limit even when longer", () => {
    const marker = "[assistant-via-bridge] "
    loadWhatsAppConfig({ aiPrefix: marker })

    const chunks = buildAiMessageChunks("q".repeat(WHATSAPP_MAX_MESSAGE_LENGTH * 2))

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith(marker)).toBe(true)
      expect(chunk.length).toBeLessThanOrEqual(WHATSAPP_MAX_MESSAGE_LENGTH)
    }
  })
})
