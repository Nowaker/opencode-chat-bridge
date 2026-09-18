/**
 * A pinned workspace is the operator's real project.
 *
 * Session expiry deletes a generated workspace recursively, so these tests
 * drive the connector's own cleanup path and assert that a pinned directory
 * and its contents survive it.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import { BaseConnector, type BaseSession } from "../../src/connector-base"
import { loadConfig, clearConfigCache } from "../../src/config"

const originalCwd = process.cwd()
let root: string
let project: string
let sentinel: string

class ExpiringConnector extends BaseConnector<BaseSession> {
  constructor() {
    super({
      connector: "whatsapp",
      trigger: "!oc",
      botName: "Test",
      rateLimitSeconds: 5,
      sessionRetentionDays: 7,
      allowedUsers: ["owner"],
      allowedChannels: ["chat@g.us"],
    })
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(): Promise<void> {}

  public expire(id: string): void {
    ;(this as any).deleteSessionCacheDir(id)
  }

  public workspaceFor(id: string) {
    return (this as any).resolveWorkspace(id)
  }
}

function useConfig(config: Record<string, unknown>): void {
  clearConfigCache()
  const configPath = path.join(root, "chat-bridge.json")
  fs.writeFileSync(configPath, JSON.stringify(config))
  loadConfig(configPath)
}

describe("pinned ACP workspace", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-workspace-"))
    project = path.join(root, "ai-bridge")
    sentinel = path.join(project, "AGENTS.md")
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(sentinel, "# project instructions\n")
  })

  afterEach(() => {
    clearConfigCache()
    process.chdir(originalCwd)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("session expiry never deletes the pinned project", () => {
    useConfig({ acp: { sessionCwd: project } })
    const connector = new ExpiringConnector()

    connector.expire("chat@g.us")

    expect(fs.existsSync(project)).toBe(true)
    expect(fs.readFileSync(sentinel, "utf-8")).toContain("project instructions")
  })

  test("every thread of a pinned connector resolves to the same project", () => {
    useConfig({ acp: { sessionCwd: project } })
    const connector = new ExpiringConnector()

    const first = connector.workspaceFor("chat@g.us")
    const second = connector.workspaceFor("other@g.us")

    expect(first.pinned).toBe(true)
    expect(first.dir).toBe(project)
    expect(second.dir).toBe(project)
  })

  test("an unpinned connector still deletes its own generated workspace", () => {
    const generated = path.join(root, "sessions")
    useConfig({ acp: { sessionCwd: "" } })
    process.env.SESSION_BASE_DIR = generated
    const connector = new ExpiringConnector()

    const workspace = connector.workspaceFor("chat@g.us")
    fs.mkdirSync(workspace.dir, { recursive: true })
    fs.writeFileSync(path.join(workspace.dir, "scratch.txt"), "cache")

    connector.expire("chat@g.us")

    expect(workspace.pinned).toBe(false)
    expect(fs.existsSync(workspace.dir)).toBe(false)
    delete process.env.SESSION_BASE_DIR
  })
})
