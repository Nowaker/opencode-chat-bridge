/**
 * Integration tests for config.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import { loadConfig, getConfig, clearConfigCache } from "../../src/config"

describe("config", () => {
  const testDir = path.join(os.tmpdir(), "config-test-" + Date.now())
  const originalCwd = process.cwd()
  const originalEnv = { ...process.env }

  beforeEach(() => {
    clearConfigCache()
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    clearConfigCache()
    process.chdir(originalCwd)
    // Restore env vars
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
    
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe("loadConfig", () => {
    test("returns defaults when no config file exists", () => {
      process.chdir(testDir)
      
      const config = loadConfig()
      
      expect(config.botName).toBe("oc")
      expect(config.trigger).toBe("!oc")
      expect(config.rateLimitSeconds).toBe(5)
      expect(config.toolMessages).toEqual({
        mode: "events",
        showCalls: true,
        showArguments: false,
        showOutputFor: ["bash"],
        maxTraceEntries: 20,
        summaries: {
          allowedTools: [],
          allowedFields: [],
          maxFieldLength: 120,
          unlistedTools: "name",
        },
      })
      expect(config.matrix.enabled).toBe(false)
      expect(config.matrix.respondToThreadReplies).toBe(true)
      expect(config.mattermost.respondToThreadReplies).toBe(true)
      expect(config.slack.respondToThreadReplies).toBe(true)
      expect(config.telegram.respondToImplicitTopicReplies).toBe(true)
      expect(config.whatsapp.enabled).toBe(false)
    })

    test("loads config from chat-bridge.json", () => {
      const configContent = {
        botName: "custom-bot",
        trigger: "!bot",
        rateLimitSeconds: 10,
        matrix: { respondToThreadReplies: false },
        mattermost: { respondToThreadReplies: false },
        slack: { respondToThreadReplies: false },
        telegram: { respondToImplicitTopicReplies: false },
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.botName).toBe("custom-bot")
      expect(config.trigger).toBe("!bot")
      expect(config.rateLimitSeconds).toBe(10)
      expect(config.matrix.respondToThreadReplies).toBe(false)
      expect(config.mattermost.respondToThreadReplies).toBe(false)
      expect(config.slack.respondToThreadReplies).toBe(false)
      expect(config.telegram.respondToImplicitTopicReplies).toBe(false)
    })

    test("migrates legacy streamTools into toolMessages", () => {
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify({ streamTools: ["bash", "weather"] })
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.toolMessages).toEqual({
        mode: "events",
        showCalls: true,
        showArguments: false,
        showOutputFor: ["bash", "weather"],
        maxTraceEntries: 20,
        summaries: {
          allowedTools: [],
          allowedFields: [],
          maxFieldLength: 120,
          unlistedTools: "name",
        },
      })
      expect("streamTools" in config).toBe(false)
    })

    test("merges with defaults for partial config", () => {
      const configContent = {
        botName: "partial-bot"
        // Other fields should come from defaults
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.botName).toBe("partial-bot")
      expect(config.trigger).toBe("!oc") // From default
      expect(config.rateLimitSeconds).toBe(5) // From default
    })

    test("deep merges nested objects", () => {
      const configContent = {
        matrix: {
          enabled: true,
          homeserver: "https://custom.server.org"
          // Other matrix fields should come from defaults
        }
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.matrix.enabled).toBe(true)
      expect(config.matrix.homeserver).toBe("https://custom.server.org")
      expect(config.matrix.deviceId).toBe("OPENCODE_BRIDGE") // From default
      expect(config.matrix.autoJoin).toBe(true) // From default
    })

    test("normalizes invalid tool message settings", () => {
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify({
          toolMessages: {
            mode: "future-mode",
            maxTraceEntries: 0,
          },
        })
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.toolMessages.mode).toBe("events")
      expect(config.toolMessages.maxTraceEntries).toBe(20)
    })

    test("merges and normalizes Web attachment limits", () => {
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify({
          web: {
            attachments: {
              enabled: true,
              maxFileBytes: 123456,
              maxFilesPerMessage: 0,
              allowedMimeTypes: ["image/png", "image/svg+xml"],
            },
          },
        })
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.web.attachments.enabled).toBe(true)
      expect(config.web.attachments.maxFileBytes).toBe(123456)
      expect(config.web.attachments.maxFilesPerMessage).toBe(1)
      expect(config.web.attachments.maxPixels).toBe(20_000_000)
      expect(config.web.attachments.allowedMimeTypes).toEqual(["image/png"])
    })

    test("loads from custom path", () => {
      const customPath = path.join(testDir, "custom-config.json")
      const configContent = { botName: "custom-path-bot" }
      fs.writeFileSync(customPath, JSON.stringify(configContent))

      const config = loadConfig(customPath)

      expect(config.botName).toBe("custom-path-bot")
    })

    test("substitutes environment variables", () => {
      process.env.TEST_BOT_NAME = "env-bot"
      process.env.TEST_TRIGGER = "!test"
      
      const configContent = {
        botName: "{env:TEST_BOT_NAME}",
        trigger: "{env:TEST_TRIGGER}"
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.botName).toBe("env-bot")
      expect(config.trigger).toBe("!test")
    })

    test("substitutes undefined env vars as empty string", () => {
      delete process.env.UNDEFINED_VAR
      
      const configContent = {
        botName: "{env:UNDEFINED_VAR}"
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.botName).toBe("")
    })

    test("substitutes env vars in nested objects", () => {
      process.env.MATRIX_SERVER = "https://env-server.org"
      
      const configContent = {
        matrix: {
          homeserver: "{env:MATRIX_SERVER}"
        }
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.matrix.homeserver).toBe("https://env-server.org")
    })

    test("substitutes env vars in arrays", () => {
      process.env.ALLOWED_NUM = "1234567890"
      
      const configContent = {
        whatsapp: {
          allowedUsers: ["{env:ALLOWED_NUM}", "0987654321"]
        }
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.whatsapp.allowedUsers).toContain("1234567890")
      expect(config.whatsapp.allowedUsers).toContain("0987654321")
    })
  })

  describe("getConfig", () => {
    test("returns same config on multiple calls (caching)", () => {
      const configContent = { botName: "cached-bot" }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config1 = getConfig()
      const config2 = getConfig()

      expect(config1).toBe(config2) // Same object reference
    })
  })

  describe("clearConfigCache", () => {
    test("allows reloading config", () => {
      // Load initial config
      const configContent1 = { botName: "first-bot" }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent1)
      )
      process.chdir(testDir)

      const config1 = loadConfig()
      expect(config1.botName).toBe("first-bot")

      // Change config file and clear cache
      const configContent2 = { botName: "second-bot" }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent2)
      )
      clearConfigCache()

      const config2 = loadConfig()
      expect(config2.botName).toBe("second-bot")
    })
  })

  describe("error handling", () => {
    test("handles invalid JSON gracefully", () => {
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        "{ invalid json }"
      )
      process.chdir(testDir)

      // Should return defaults instead of throwing
      const config = loadConfig()
      expect(config.botName).toBe("oc")
    })
  })

  describe("safety controls", () => {
    const writeConfig = (content: unknown) => {
      fs.writeFileSync(path.join(testDir, "chat-bridge.json"), JSON.stringify(content))
      process.chdir(testDir)
    }

    test("defaults every channel allowlist to empty so nothing is allowed", () => {
      process.chdir(testDir)
      const config = loadConfig()

      expect(config.slack.allowedChannels).toEqual([])
      expect(config.matrix.allowedRooms).toEqual([])
      expect(config.whatsapp.allowedGroups).toEqual([])
    })

    test("defaults file upload and inbound body logging to off", () => {
      process.chdir(testDir)
      const config = loadConfig()

      expect(config.whatsapp.autoUploadFiles).toBe(false)
      expect(config.whatsapp.logInboundMessages).toBe(false)
      expect(config.slack.autoUploadFiles).toBe(false)
      expect(config.slack.logInboundMessages).toBe(false)
    })

    test("defaults safeOutput to redacting secrets and withholding raw tool output", () => {
      process.chdir(testDir)
      const config = loadConfig()

      expect(config.safeOutput).toEqual({ redactSecrets: true, allowRawToolOutput: false })
    })

    test("keeps configured allowlist entries and drops blank ones", () => {
      writeConfig({
        slack: { allowedChannels: ["C0C2U4Q51HP", "  ", "C1234567890"] },
        matrix: { allowedRooms: ["!room:example.org"] },
        whatsapp: { allowedGroups: ["1234567890@g.us"] },
      })

      const config = loadConfig()

      expect(config.slack.allowedChannels).toEqual(["C0C2U4Q51HP", "C1234567890"])
      expect(config.matrix.allowedRooms).toEqual(["!room:example.org"])
      expect(config.whatsapp.allowedGroups).toEqual(["1234567890@g.us"])
    })

    test("resolves non-boolean safeOutput flags to the safe default", () => {
      writeConfig({ safeOutput: { redactSecrets: "false", allowRawToolOutput: "true" } })

      const config = loadConfig()

      expect(config.safeOutput.redactSecrets).toBe(true)
      expect(config.safeOutput.allowRawToolOutput).toBe(false)
    })

    test("rejects an invalid unlistedTools presentation", () => {
      writeConfig({ toolMessages: { summaries: { unlistedTools: "everything" } } })

      const config = loadConfig()

      expect(config.toolMessages.summaries?.unlistedTools).toBe("name")
    })

    test("rejects a non-positive permission timeout", () => {
      writeConfig({ permissions: { interactive: true, timeoutSeconds: 0 } })

      const config = loadConfig()

      expect(config.permissions.timeoutSeconds).toBe(180)
    })

    test("loads a pinned ACP session workspace", () => {
      writeConfig({ acp: { sessionCwd: "/home/example/projects/ai-bridge" } })

      const config = loadConfig()

      expect(config.acp.sessionCwd).toBe("/home/example/projects/ai-bridge")
    })

    test("defaults the ACP session workspace to upstream per-thread behaviour", () => {
      process.chdir(testDir)
      const config = loadConfig()

      expect(config.acp.sessionCwd).toBe("")
    })
  })
})
