/**
 * The safety controls as an operator actually meets them.
 *
 * Every other suite exercises one piece in isolation. This one drives the
 * composed stack: a chat-bridge.json on disk, the connector's real inbound
 * path, and the ACP client parsing real JSON-RPC bytes. A control that works
 * alone but is not wired up fails here.
 *
 * The config-driven cases run in a child process with its own working
 * directory, because connectors read configuration once at module scope --
 * exactly as they do under `bun connectors/whatsapp.ts`. Running them
 * in-process would test a module that had already captured whichever config
 * some earlier test file happened to load.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { EventEmitter } from "events"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { ACPClient } from "../../src/acp-client"
import { REDACTION_PLACEHOLDER } from "../../src/safe-output"
import { resolveSessionWorkspace } from "../../src/session-utils"
import { WhatsAppConnector } from "../../connectors/whatsapp"
import { MatrixConnector } from "../../connectors/matrix"
import { SlackConnector } from "../../connectors/slack"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

const GROUP = "120363111122223333@g.us"
const OTHER_GROUP = "120363999988887777@g.us"
const OWNER = "15551234567"
const STRANGER = "15559998888"

let workdir = ""
let project = ""

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-safety-"))
  project = path.join(workdir, "pinned-project")
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(project, "AGENTS.md"), "# pinned project\n")

  fs.writeFileSync(path.join(workdir, "chat-bridge.json"), JSON.stringify({
    botName: "opencode",
    trigger: "!oc",
    rateLimitSeconds: 0,
    sessionStorePath: path.join(workdir, "sessions.json"),
    toolMessages: {
      mode: "events",
      showArguments: true,
      showOutputFor: [],
      summaries: {
        allowedTools: ["webfetch"],
        allowedFields: ["url"],
        maxFieldLength: 120,
        unlistedTools: "name",
      },
    },
    safeOutput: { redactSecrets: true, allowRawToolOutput: false },
    permissions: { interactive: true, timeoutSeconds: 180 },
    acp: { command: "opencode", args: ["acp"], backendId: "opencode", sessionCwd: project },
    whatsapp: {
      enabled: true,
      authFolder: path.join(workdir, "wa-auth"),
      allowedUsers: [OWNER],
      allowedGroups: [GROUP],
      respondToOthers: true,
      autoUploadFiles: false,
      logInboundMessages: false,
    },
  }))
})

afterAll(() => {
  if (workdir) fs.rmSync(workdir, { recursive: true, force: true })
})

/**
 * Run a script in a fresh process whose working directory holds the config
 * file, and return whatever it printed after a RESULT: marker.
 */
function runInConfiguredProcess(body: string): any {
  const script = path.join(workdir, `drive-${Math.random().toString(36).slice(2)}.ts`)
  fs.writeFileSync(script, `
    const REPO = ${JSON.stringify(REPO_ROOT)}
    const GROUP = ${JSON.stringify(GROUP)}
    const OTHER_GROUP = ${JSON.stringify(OTHER_GROUP)}
    const OWNER = ${JSON.stringify(OWNER)}
    const STRANGER = ${JSON.stringify(STRANGER)}
    const { WhatsAppConnector } = await import(REPO + "/connectors/whatsapp.ts")

    const chat = []
    const routed = []
    const connector = new WhatsAppConnector()
    let counter = 0
    connector.sock = {
      sendMessage: async (_chatId, content) => {
        if (typeof content.text === "string") chat.push(content.text)
        return { key: { id: "emitted-" + ++counter, fromMe: true } }
      },
      sendPresenceUpdate: async () => {},
    }
    connector.processQuery = async (chatId, _sender, query) => { routed.push(chatId + "|" + query) }

    const inbound = (text, opts = {}) => ({
      key: {
        id: opts.id || "msg-" + Math.random().toString(36).slice(2),
        remoteJid: opts.chatId || GROUP,
        participant: (opts.sender || OWNER) + "@s.whatsapp.net",
        fromMe: false,
      },
      message: { conversation: text },
    })
    const deliver = (msg) => connector.handleMessage(msg)

    ${body}
  `)

  const result = spawnSync("bun", [script], {
    cwd: workdir,
    encoding: "utf-8",
    timeout: 60_000,
  })

  const marker = (result.stdout || "").split("RESULT:")[1]
  if (!marker) {
    throw new Error(`driver produced no result\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
  return JSON.parse(marker.trim())
}

describe("inbound gating driven by a real config file", () => {
  test("serves only the allowlisted sender in the allowlisted chat", () => {
    const result = runInConfiguredProcess(`
      await deliver(inbound("!oc from an unlisted chat", { chatId: OTHER_GROUP }))
      const afterUnlistedChat = routed.length

      await deliver(inbound("!oc from an unlisted sender", { sender: STRANGER }))
      const afterUnlistedSender = routed.length

      await deliver(inbound("!oc hello"))
      const afterAllowed = routed.length

      await deliver(inbound("!oc retry", { id: "dup-1" }))
      await deliver(inbound("!oc retry", { id: "dup-1" }))
      const afterRetry = routed.length

      console.log("RESULT:" + JSON.stringify({
        afterUnlistedChat, afterUnlistedSender, afterAllowed, afterRetry, routed,
      }))
    `)

    expect(result.afterUnlistedChat).toBe(0)
    expect(result.afterUnlistedSender).toBe(0)
    expect(result.afterAllowed).toBe(1)
    expect(result.routed[0]).toBe(`${GROUP}|hello`)
    expect(result.afterRetry).toBe(2)
  })

  test("marks every chunk of an answer long enough to split", () => {
    const result = runInConfiguredProcess(`
      await connector.sendMessage(GROUP, "x".repeat(9000))
      console.log("RESULT:" + JSON.stringify({
        chunks: chat.length,
        allMarked: chat.every((text) => text.startsWith("[AI] ")),
      }))
    `)

    expect(result.chunks).toBeGreaterThan(1)
    expect(result.allMarked).toBe(true)
  })

  test("keeps inbound message bodies out of the log by default", () => {
    const result = runInConfiguredProcess(`
      const lines = []
      const original = console.log
      console.log = (...args) => { lines.push(args.join(" ")) }
      await deliver(inbound("!oc a very distinctive private sentence"))
      console.log = original
      console.log("RESULT:" + JSON.stringify({
        routed: routed.length,
        leaked: lines.some((line) => line.includes("distinctive private sentence")),
      }))
    `)

    expect(result.routed).toBe(1)
    expect(result.leaked).toBe(false)
  })
})

/** An ACP client whose child process is replaced by in-memory stdio. */
function buildACPClient(extra: { permissionTimeoutMs?: number } = {}) {
  const client = new ACPClient({ cwd: project, interactivePermissions: true, ...extra })
  const agentSaw: string[] = []
  const stdout = new EventEmitter()

  ;(client as any).acp = {
    stdout,
    stderr: new EventEmitter(),
    killed: false,
    kill: () => {},
    on: () => {},
    stdin: { write: (line: string) => { agentSaw.push(line); return true }, destroyed: false },
  }
  stdout.on("data", (data: Buffer) => (client as any).handleData(data))

  const emitRequest = (id: number, params: any) => {
    stdout.emit("data", Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id, method: "session/request_permission", params,
    }) + "\n"))
  }

  return { client, agentSaw, emitRequest }
}

const WEBFETCH_REQUEST = {
  sessionId: "ses_x",
  permission: "webfetch",
  toolCall: {
    toolCallId: "call-1",
    title: "https://example.invalid/report",
    kind: "webfetch",
    rawInput: {
      url: "https://example.invalid/report",
      header: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    },
  },
  options: [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ],
}

describe("permission round trip over real JSON-RPC bytes", () => {
  async function present() {
    const chat: string[] = []
    const connector = new WhatsAppConnector()
    let counter = 0

    ;(connector as any).sock = {
      sendMessage: async (_chatId: string, content: any) => {
        if (typeof content.text === "string") chat.push(content.text)
        return { key: { id: `emitted-${++counter}`, fromMe: true } }
      },
    }
    ;(connector as any).allowedUsers = new Set([OWNER])
    ;(connector as any).allowedChannels = new Set([GROUP])
    ;(connector as any).toolMessagesConfig = {
      mode: "events",
      showCalls: true,
      showArguments: true,
      showOutputFor: [],
      summaries: {
        allowedTools: ["webfetch"],
        allowedFields: ["url"],
        maxFieldLength: 120,
        unlistedTools: "name",
      },
    }

    const { client, agentSaw, emitRequest } = buildACPClient()

    client.on("permission_requested", async (request: any) => {
      await (connector as any).presentPermissionRequest(
        GROUP, request, client, (text: string) => connector.sendMessage(GROUP, text),
      )
    })

    emitRequest(41, WEBFETCH_REQUEST)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const prompt = chat.join("\n")
    const token = prompt.match(/\b[A-Z2-9]{6}\b/)?.[0] || ""

    const reply = (text: string, opts: { sender?: string; threadId?: string } = {}) =>
      (connector as any).handlePermissionReply(
        opts.threadId || GROUP,
        opts.sender || OWNER,
        text,
        (t: string) => connector.sendMessage(GROUP, t),
      )

    return { prompt, token, agentSaw, reply }
  }

  test("posts a marked, numbered prompt and keeps the agent waiting", async () => {
    const { prompt, token, agentSaw } = await present()

    expect(prompt.startsWith("[AI] ")).toBe(true)
    expect(prompt).toMatch(/\b1\.\s/)
    expect(token).toHaveLength(6)
    expect(agentSaw).toEqual([])
  })

  test("renders allowlisted argument fields and withholds the rest", async () => {
    const { prompt } = await present()

    expect(prompt).toContain("example.invalid")
    expect(prompt).not.toContain("header=")
    expect(prompt).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
  })

  test("refuses a reply from a sender who is not allowlisted", async () => {
    const { token, agentSaw, reply } = await present()

    await reply(`${token} 1`, { sender: STRANGER })

    expect(agentSaw).toEqual([])
  })

  test("refuses a reply posted in a different thread", async () => {
    const { token, agentSaw, reply } = await present()

    await reply(`${token} 1`, { threadId: OTHER_GROUP })

    expect(agentSaw).toEqual([])
  })

  test("refuses ambiguous prose and a bare token", async () => {
    const { token, agentSaw, reply } = await present()

    await reply("yes go ahead")
    await reply(`${token}`)

    expect(agentSaw).toEqual([])
  })

  test("delivers the selected option for a correlated, authenticated reply", async () => {
    const { token, agentSaw, reply } = await present()

    await reply(`${token} 1`)

    expect(agentSaw).toHaveLength(1)
    const answer = JSON.parse(agentSaw[0])
    expect(answer.id).toBe(41)
    expect(answer.result.outcome).toEqual({ outcome: "selected", optionId: "once" })
  })

  test("cannot be replayed once settled", async () => {
    const { token, agentSaw, reply } = await present()

    await reply(`${token} 1`)
    await reply(`${token} 2`)

    expect(agentSaw).toHaveLength(1)
  })

  test("denies a still-held request on shutdown instead of abandoning it", async () => {
    const { client, agentSaw, emitRequest } = buildACPClient()

    emitRequest(77, {
      sessionId: "s",
      permission: "bash",
      toolCall: { title: "rm -rf /", kind: "bash", rawInput: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(agentSaw).toEqual([])

    client.rejectHeldPermissions()

    expect(agentSaw).toHaveLength(1)
    const answer = JSON.parse(agentSaw[0])
    expect(answer.id).toBe(77)
    expect(answer.result.outcome.optionId).toBe("reject")
  })
})

describe("pinned workspace", () => {
  test("resolves to the configured project", () => {
    const workspace = resolveSessionWorkspace("whatsapp", GROUP, project)

    expect(workspace.dir).toBe(project)
    expect(workspace.pinned).toBe(true)
  })

  test("survives the session expiry sweep", () => {
    const connector = new WhatsAppConnector()
    ;(connector as any).acpConfig = { ...(connector as any).acpConfig, sessionCwd: project }

    ;(connector as any).deleteSessionCacheDir(GROUP)

    expect(fs.existsSync(path.join(project, "AGENTS.md"))).toBe(true)
  })
})

// =============================================================================
// Presenting a held permission in every connector that keys sessions by thread
// =============================================================================

/**
 * The permission round trip has to be wired per connector, and a connector that
 * holds a request without presenting it stalls the turn with no way to settle
 * it. These drive each connector's real query path and real inbound handlers,
 * so the listener registration itself is under test rather than assumed.
 */

const MATRIX_ROOM = "!vibeterm:desktop.ts.nowaker.net"
const MATRIX_ROOT = "$root-event"
const MATRIX_OTHER_ROOT = "$other-event"
const MATRIX_BOT = "@bridge:desktop.ts.nowaker.net"
const MATRIX_OWNER = "@nowaker:desktop.ts.nowaker.net"
const MATRIX_STRANGER = "@stranger:desktop.ts.nowaker.net"

const SLACK_CHANNEL = "C0C2U4Q51HP"
const SLACK_ROOT_TS = "1700000000.000100"
const SLACK_OTHER_TS = "1700000000.000900"
const SLACK_OWNER = "U01OWNER"
const SLACK_STRANGER = "U01STRANGER"

const PERMISSION_TOOL_MESSAGES = {
  mode: "events",
  showCalls: true,
  showArguments: true,
  showOutputFor: [],
  summaries: {
    allowedTools: ["webfetch"],
    allowedFields: ["url"],
    maxFieldLength: 120,
    unlistedTools: "name",
  },
}

/** An ACP client whose prompt stays in flight until the test releases it. */
function buildDrivableClient() {
  const built = buildACPClient()
  const prompts: string[] = []
  let release: () => void = () => {}
  const inFlight = new Promise<void>((resolve) => { release = resolve })

  ;(built.client as any).prompt = async (text: string) => {
    prompts.push(text)
    await inFlight
    built.client.emit("chunk", "done")
    return "done"
  }

  return { ...built, prompts, release }
}

interface HeldTurn {
  chat: string[]
  agentSaw: string[]
  prompts: string[]
  token: string
  threadId: string
  pending: () => number
  reply: (text: string, opts?: { sender?: string; otherThread?: boolean }) => Promise<void>
  finish: () => Promise<void>
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function tokenIn(chat: string[]): string {
  return chat.join("\n").match(/\b[A-Z2-9]{6}\b/)?.[0] || ""
}

async function matrixHeldTurn(): Promise<HeldTurn> {
  const chat: string[] = []
  const connector = new MatrixConnector()
  const { client, agentSaw, emitRequest, prompts, release } = buildDrivableClient()
  let events = 0

  ;(connector as any).matrix = {
    sendMessage: async (_roomId: string, content: any) => {
      if (typeof content.body === "string") chat.push(content.body)
      return `$sent-${++events}`
    },
    sendNotice: async (_roomId: string, text: string) => { chat.push(text) },
    sendText: async (_roomId: string, text: string) => { chat.push(text) },
    getUserId: async () => MATRIX_BOT,
    getJoinedRoomMembers: async () => [MATRIX_BOT, MATRIX_OWNER, MATRIX_STRANGER],
  }
  ;(connector as any).allowedUsers = new Set([MATRIX_OWNER])
  ;(connector as any).allowedChannels = new Set([MATRIX_ROOM])
  ;(connector as any).toolMessagesConfig = PERMISSION_TOOL_MESSAGES

  const threadId = `${MATRIX_ROOM}:${MATRIX_ROOT}`
  ;(connector as any).sessionManager.set(threadId, {
    client,
    createdAt: new Date(),
    lastActivity: new Date(),
    messageCount: 0,
    inputChars: 0,
    outputChars: 0,
    lastEventIds: new Map<string, string>(),
  })

  const inbound = (body: string, opts: { sender?: string; root?: string } = {}) => ({
    type: "m.room.message",
    event_id: `$in-${++events}`,
    sender: opts.sender || MATRIX_OWNER,
    content: {
      msgtype: "m.text",
      body,
      ...(opts.root ? { "m.relates_to": { rel_type: "m.thread", event_id: opts.root } } : {}),
    },
  })

  const root = inbound("!oc fetch the report")
  root.event_id = MATRIX_ROOT
  const turn = (connector as any).handleRoomMessage(MATRIX_ROOM, root)
  await tick()

  emitRequest(41, WEBFETCH_REQUEST)
  await tick()

  return {
    chat,
    agentSaw,
    prompts,
    token: tokenIn(chat),
    threadId,
    pending: () => (connector as any).permissionBroker.size,
    reply: async (text, opts = {}) => {
      await (connector as any).handleRoomMessage(MATRIX_ROOM, inbound(text, {
        sender: opts.sender,
        root: opts.otherThread ? MATRIX_OTHER_ROOT : MATRIX_ROOT,
      }))
    },
    finish: async () => { release(); await turn },
  }
}

async function slackHeldTurn(): Promise<HeldTurn> {
  const chat: string[] = []
  const connector = new SlackConnector()
  const { client, agentSaw, emitRequest, prompts, release } = buildDrivableClient()
  let events = 0

  const handlers: Record<string, any> = {}
  connector.registerHandlers({
    event: (_name: string, fn: any) => { handlers.mention = fn },
    message: (first: any, second?: any) => {
      if (typeof first === "function") handlers.thread = first
      else handlers.trigger = second
    },
  } as any)

  const slackClient = {
    chat: {
      postMessage: async (payload: any) => {
        if (typeof payload.text === "string") chat.push(payload.text)
        return { ts: `ts-sent-${++events}` }
      },
      update: async () => {},
    },
  }

  ;(connector as any).allowedUsers = new Set([SLACK_OWNER])
  ;(connector as any).allowedChannels = new Set([SLACK_CHANNEL])
  ;(connector as any).toolMessagesConfig = PERMISSION_TOOL_MESSAGES

  const threadId = `${SLACK_CHANNEL}:${SLACK_ROOT_TS}`
  ;(connector as any).sessionManager.set(threadId, {
    client,
    createdAt: new Date(),
    lastActivity: new Date(),
    messageCount: 0,
    inputChars: 0,
    outputChars: 0,
  })

  const deliver = (text: string, opts: { sender?: string; threadTs?: string } = {}) =>
    handlers.trigger({
      message: {
        text,
        user: opts.sender || SLACK_OWNER,
        channel: SLACK_CHANNEL,
        ts: `${Date.now()}.${++events}`,
        thread_ts: opts.threadTs || SLACK_ROOT_TS,
      },
      body: { team_id: "T04FXV713" },
      client: slackClient,
    })

  const turn = handlers.trigger({
    message: {
      text: "!oc fetch the report",
      user: SLACK_OWNER,
      channel: SLACK_CHANNEL,
      ts: SLACK_ROOT_TS,
    },
    body: { team_id: "T04FXV713" },
    client: slackClient,
  })
  await tick()

  emitRequest(41, WEBFETCH_REQUEST)
  await tick()

  return {
    chat,
    agentSaw,
    prompts,
    token: tokenIn(chat),
    threadId,
    pending: () => (connector as any).permissionBroker.size,
    reply: async (text, opts = {}) => {
      await deliver(text, {
        sender: opts.sender,
        threadTs: opts.otherThread ? SLACK_OTHER_TS : SLACK_ROOT_TS,
      })
    },
    finish: async () => { release(); await turn },
  }
}

const CONNECTOR_TURNS: Array<[string, () => Promise<HeldTurn>, string]> = [
  ["matrix", matrixHeldTurn, `${MATRIX_ROOM}:${MATRIX_ROOT}`],
  ["slack", slackHeldTurn, `${SLACK_CHANNEL}:${SLACK_ROOT_TS}`],
]

for (const [name, openTurn, expectedThreadId] of CONNECTOR_TURNS) {
  describe(`${name} permission round trip`, () => {
    test("presents the held request under the connector's own session key", async () => {
      const turn = await openTurn()
      try {
        expect(turn.threadId).toBe(expectedThreadId)
        expect(turn.token).toMatch(/^[A-Z2-9]{6}$/)
        expect(turn.chat.join("\n")).toContain("Permission requested")
        expect(turn.chat.join("\n")).toMatch(/\b1\.\s/)
        expect(turn.pending()).toBe(1)
      } finally {
        await turn.finish()
      }
    })

    test("renders the allowlisted field and withholds the credential", async () => {
      const turn = await openTurn()
      try {
        const prompt = turn.chat.join("\n")
        expect(prompt).toContain("url=https://example.invalid/report")
        expect(prompt).not.toContain("header")
        expect(prompt).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
      } finally {
        await turn.finish()
      }
    })

    test("keeps the agent waiting until somebody answers", async () => {
      const turn = await openTurn()
      try {
        expect(turn.agentSaw).toHaveLength(0)
      } finally {
        await turn.finish()
      }
    })

    test("leaves the request pending for a sender who is not allowlisted", async () => {
      const turn = await openTurn()
      try {
        await turn.reply(`!oc ${turn.token} 1`, { sender: "stranger" })

        expect(turn.agentSaw).toHaveLength(0)
        expect(turn.pending()).toBe(1)
      } finally {
        await turn.finish()
      }
    })

    test("leaves the request pending for a reply in a different thread", async () => {
      const turn = await openTurn()
      try {
        await turn.reply(`!oc ${turn.token} 1`, { otherThread: true })

        expect(turn.agentSaw).toHaveLength(0)
        expect(turn.pending()).toBe(1)
      } finally {
        await turn.finish()
      }
    })

    test("leaves the request pending for ambiguous prose", async () => {
      const turn = await openTurn()
      try {
        await turn.reply(`!oc ${turn.token} yes go ahead`)

        expect(turn.agentSaw).toHaveLength(0)
        expect(turn.pending()).toBe(1)
      } finally {
        await turn.finish()
      }
    })

    test("settles on a correlated reply and does not also prompt the agent", async () => {
      const turn = await openTurn()
      try {
        expect(turn.prompts).toHaveLength(1)

        await turn.reply(`!oc ${turn.token} 1`)

        expect(turn.agentSaw).toHaveLength(1)
        const answer = JSON.parse(turn.agentSaw[0])
        expect(answer.id).toBe(41)
        expect(answer.result.outcome.optionId).toBe("once")
        expect(turn.pending()).toBe(0)
        // The reply settled the waiting turn; it must not have started another.
        expect(turn.prompts).toHaveLength(1)
      } finally {
        await turn.finish()
      }
    })
  })
}

// =============================================================================
// A request nobody presented
// =============================================================================

describe("held requests nobody presented", () => {
  test("are denied so the turn ends instead of hanging", async () => {
    const { agentSaw, emitRequest } = buildACPClient({ permissionTimeoutMs: 30 })

    emitRequest(51, WEBFETCH_REQUEST)
    expect(agentSaw).toHaveLength(0)

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(agentSaw).toHaveLength(1)
    expect(JSON.parse(agentSaw[0]).result.outcome.optionId).toBe("reject")
  })

  test("are answered exactly once even if something answers late", async () => {
    const { client, agentSaw, emitRequest } = buildACPClient({ permissionTimeoutMs: 30 })

    emitRequest(52, WEBFETCH_REQUEST)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(client.respondToPermission(52, "once")).toBe(false)
    expect(agentSaw).toHaveLength(1)
  })
})

// =============================================================================
// safeOutput.redactSecrets at each connector's own send chokepoint
// =============================================================================

/**
 * The final assistant answer is model-authored text that no allowlist has
 * inspected, so each connector must redact at its own send chokepoint. These
 * drive the real query path rather than calling the chokepoint directly, so a
 * send site added outside it is caught.
 */

// Assembled at runtime so no source line is itself a credential for scanners.
const SENSITIVE_FIELD = ["DEPLOY", "TOKEN"].join("_")
const PLACEHOLDER_VALUE = "not-a-real-credential-0123456789"
const SECRET_BEARING_ANSWER = `Deploy finished. ${SENSITIVE_FIELD}=${PLACEHOLDER_VALUE} is set.`

/** An ACP client whose prompt answers immediately with fixed text. */
function buildAnsweringClient(answer: string) {
  const { client } = buildACPClient()
  ;(client as any).prompt = async () => {
    client.emit("chunk", answer)
    return answer
  }
  return client
}

type AnswerDriver = (answer: string, opts: { redactSecrets: boolean }) => Promise<string[]>

const matrixAnswerTurn: AnswerDriver = async (answer, opts) => {
  const sent: string[] = []
  const connector = new MatrixConnector()
  const client = buildAnsweringClient(answer)
  let events = 0

  ;(connector as any).matrix = {
    sendMessage: async (_roomId: string, content: any) => {
      if (typeof content.body === "string") sent.push(content.body)
      return `$sent-${++events}`
    },
    sendNotice: async (_roomId: string, text: string) => { sent.push(text) },
    sendText: async (_roomId: string, text: string) => { sent.push(text) },
    getUserId: async () => MATRIX_BOT,
    getJoinedRoomMembers: async () => [MATRIX_BOT, MATRIX_OWNER, MATRIX_STRANGER],
  }
  ;(connector as any).allowedUsers = new Set([MATRIX_OWNER])
  ;(connector as any).allowedChannels = new Set([MATRIX_ROOM])
  ;(connector as any).safeOutputConfig = {
    redactSecrets: opts.redactSecrets,
    allowRawToolOutput: false,
  }
  ;(connector as any).sessionManager.set(`${MATRIX_ROOM}:${MATRIX_ROOT}`, {
    client,
    createdAt: new Date(),
    lastActivity: new Date(),
    messageCount: 0,
    inputChars: 0,
    outputChars: 0,
    lastEventIds: new Map<string, string>(),
  })

  await (connector as any).handleRoomMessage(MATRIX_ROOM, {
    type: "m.room.message",
    event_id: MATRIX_ROOT,
    sender: MATRIX_OWNER,
    content: { msgtype: "m.text", body: "!oc deploy it" },
  })

  return sent
}

const slackAnswerTurn: AnswerDriver = async (answer, opts) => {
  const sent: string[] = []
  const connector = new SlackConnector()
  const client = buildAnsweringClient(answer)
  let events = 0

  const handlers: Record<string, any> = {}
  connector.registerHandlers({
    event: (_name: string, fn: any) => { handlers.mention = fn },
    message: (first: any, second?: any) => {
      if (typeof first === "function") handlers.thread = first
      else handlers.trigger = second
    },
  } as any)

  const slackClient = {
    chat: {
      postMessage: async (payload: any) => {
        if (typeof payload.text === "string") sent.push(payload.text)
        return { ts: `ts-sent-${++events}` }
      },
      update: async (payload: any) => {
        if (typeof payload.text === "string") sent.push(payload.text)
      },
    },
  }

  ;(connector as any).allowedUsers = new Set([SLACK_OWNER])
  ;(connector as any).allowedChannels = new Set([SLACK_CHANNEL])
  ;(connector as any).safeOutputConfig = {
    redactSecrets: opts.redactSecrets,
    allowRawToolOutput: false,
  }
  ;(connector as any).sessionManager.set(`${SLACK_CHANNEL}:${SLACK_ROOT_TS}`, {
    client,
    createdAt: new Date(),
    lastActivity: new Date(),
    messageCount: 0,
    inputChars: 0,
    outputChars: 0,
  })

  await handlers.trigger({
    message: {
      text: "!oc deploy it",
      user: SLACK_OWNER,
      channel: SLACK_CHANNEL,
      ts: SLACK_ROOT_TS,
    },
    body: { team_id: "T04FXV713" },
    client: slackClient,
  })

  return sent
}

const ANSWER_DRIVERS: Array<[string, AnswerDriver]> = [
  ["matrix", matrixAnswerTurn],
  ["slack", slackAnswerTurn],
]

for (const [name, drive] of ANSWER_DRIVERS) {
  describe(`${name} outbound redaction`, () => {
    test("masks a credential shape in the final answer", async () => {
      const delivered = (await drive(SECRET_BEARING_ANSWER, { redactSecrets: true })).join("\n")

      expect(delivered).toContain("Deploy finished.")
      expect(delivered).not.toContain(PLACEHOLDER_VALUE)
      expect(delivered).toContain(REDACTION_PLACEHOLDER)
    })

    test("passes the answer through unchanged when the flag is off", async () => {
      const delivered = (await drive(SECRET_BEARING_ANSWER, { redactSecrets: false })).join("\n")

      expect(delivered).toContain(PLACEHOLDER_VALUE)
      expect(delivered).not.toContain(REDACTION_PLACEHOLDER)
    })

    test("leaves an answer with nothing secret-shaped alone", async () => {
      const answer = "All three services are healthy."
      const delivered = (await drive(answer, { redactSecrets: true })).join("\n")

      expect(delivered).toContain(answer)
    })
  })
}

// =============================================================================
// Inbound message bodies stay out of the process log
// =============================================================================

/**
 * `logInboundMessages` is read once at module scope, exactly as it is under
 * `bun connectors/slack.ts`. An in-process test cannot tell a connector that
 * consults the flag from one that ignores it, so these run the real connector
 * in a process whose chat-bridge.json sets it, drive its real inbound
 * handlers, and assert on everything the process printed -- not on the logging
 * helper. A log site that bypasses the gate fails them wherever it lives.
 */

const INBOUND_MARKER = ["DEPLOY", "TOKEN"].join("_") + "=zzz-synthetic-inbound-marker"

interface InboundLogRun {
  output: string
  labels: string[]
}

function driveInboundLogging(
  connector: "slack" | "matrix",
  logInboundMessages: boolean,
): InboundLogRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-inbound-${connector}-`))
  fs.writeFileSync(path.join(dir, "chat-bridge.json"), JSON.stringify({
    trigger: "!oc",
    rateLimitSeconds: 0,
    sessionStorePath: path.join(dir, "sessions.json"),
    [connector]: { logInboundMessages },
  }))

  const preamble = connector === "slack"
    ? `
    const { SlackConnector } = await import(REPO + "/connectors/slack.ts")
    const connector = new SlackConnector()
    connector.allowedUsers = new Set([${JSON.stringify(SLACK_OWNER)}])
    connector.allowedChannels = new Set([${JSON.stringify(SLACK_CHANNEL)}])
    connector.processQuery = async () => {}

    const handlers = {}
    connector.registerHandlers({
      event: (_name, fn) => { handlers.mention = fn },
      message: (first, second) => {
        if (typeof first === "function") handlers.thread = first
        else handlers.trigger = second
      },
    })

    const slackClient = {
      chat: { postMessage: async () => ({ ts: "ts-1" }), update: async () => {} },
    }
    connector.sessionManager.set(${JSON.stringify(SLACK_CHANNEL)} + ":" + ${JSON.stringify(SLACK_ROOT_TS)}, {
      client: {}, createdAt: new Date(), lastActivity: new Date(),
      messageCount: 0, inputChars: 0, outputChars: 0,
    })

    const envelope = (text, ts, threadTs) => ({
      message: { text, user: ${JSON.stringify(SLACK_OWNER)}, channel: ${JSON.stringify(SLACK_CHANNEL)}, ts, ...(threadTs ? { thread_ts: threadTs } : {}) },
      body: { team_id: "T04FXV713" },
      client: slackClient,
    })

    await handlers.mention({
      event: { channel: ${JSON.stringify(SLACK_CHANNEL)}, user: ${JSON.stringify(SLACK_OWNER)}, text: "<@U0BOT> " + MARKER, ts: "1700000000.000201" },
      body: { team_id: "T04FXV713" },
      client: slackClient,
    })
    await handlers.trigger(envelope("!oc " + MARKER, "1700000000.000202"))
    await handlers.thread(envelope("plain follow-up " + MARKER, "1700000000.000203", ${JSON.stringify(SLACK_ROOT_TS)}))
  `
    : `
    const { MatrixConnector } = await import(REPO + "/connectors/matrix.ts")
    const connector = new MatrixConnector()
    connector.matrix = {
      getUserId: async () => ${JSON.stringify(MATRIX_BOT)},
      getJoinedRoomMembers: async () => [${JSON.stringify(MATRIX_BOT)}, ${JSON.stringify(MATRIX_OWNER)}, ${JSON.stringify(MATRIX_STRANGER)}],
      sendMessage: async () => "$sent",
      sendNotice: async () => {},
      sendText: async () => {},
    }
    connector.allowedUsers = new Set([${JSON.stringify(MATRIX_OWNER)}])
    connector.allowedChannels = new Set([${JSON.stringify(MATRIX_ROOM)}])
    connector.processQuery = async () => {}
    connector.sessionManager.set(${JSON.stringify(MATRIX_ROOM)} + ":" + ${JSON.stringify(MATRIX_ROOT)}, {
      client: {}, createdAt: new Date(), lastActivity: new Date(),
      messageCount: 0, inputChars: 0, outputChars: 0, lastEventIds: new Map(),
    })

    let seq = 0
    const deliver = (body, root) => connector.handleRoomMessage(${JSON.stringify(MATRIX_ROOM)}, {
      type: "m.room.message",
      event_id: "$in-" + ++seq,
      sender: ${JSON.stringify(MATRIX_OWNER)},
      content: {
        msgtype: "m.text",
        body,
        ...(root ? { "m.relates_to": { rel_type: "m.thread", event_id: root } } : {}),
      },
    })

    await deliver("!oc " + MARKER)
    await deliver("!oc /init " + MARKER)
    await deliver("plain follow-up " + MARKER, ${JSON.stringify(MATRIX_ROOT)})
  `

  const script = path.join(dir, "drive.ts")
  fs.writeFileSync(script, `
    const REPO = ${JSON.stringify(REPO_ROOT)}
    const MARKER = ${JSON.stringify(INBOUND_MARKER)}

    const seen = []
    for (const stream of ["log", "error"]) {
      const original = console[stream].bind(console)
      console[stream] = (...args) => {
        seen.push(args.map(String).join(" "))
        original(...args)
      }
    }

    ${preamble}

    const labels = [...new Set(
      seen.flatMap((line) => line.match(/\\[(MENTION|MSG|THREAD|CMD)\\]/g) || [])
        .map((tag) => tag.slice(1, -1)),
    )]
    console.log("RESULT:" + JSON.stringify({ labels }))
  `)

  const result = spawnSync("bun", [script], { cwd: dir, encoding: "utf-8", timeout: 60_000 })
  const payload = (result.stdout || "").split("RESULT:")[1]
  if (!payload) {
    throw new Error(`driver produced no result\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }

  return {
    output: `${result.stdout || ""}\n${result.stderr || ""}`,
    labels: JSON.parse(payload.trim()).labels,
  }
}

describe("inbound message bodies in the process log", () => {
  test("slack logs every inbound path, so the assertions below are not vacuous", () => {
    const run = driveInboundLogging("slack", false)

    expect(run.labels.sort()).toEqual(["MENTION", "MSG", "THREAD"])
  })

  test("slack withholds the body by default", () => {
    const run = driveInboundLogging("slack", false)

    expect(run.output).not.toContain(INBOUND_MARKER)
    expect(run.output).toMatch(/\[MSG\][^\n]*\d+ chars/)
  })

  test("slack writes the body when the flag asks for it", () => {
    const run = driveInboundLogging("slack", true)

    expect(run.output).toContain(INBOUND_MARKER)
  })

  test("matrix logs every inbound path, so the assertions below are not vacuous", () => {
    const run = driveInboundLogging("matrix", false)

    expect(run.labels.sort()).toEqual(["CMD", "MSG", "THREAD"])
  })

  test("matrix withholds the decrypted body by default", () => {
    const run = driveInboundLogging("matrix", false)

    expect(run.output).not.toContain(INBOUND_MARKER)
    expect(run.output).toMatch(/\[MSG\][^\n]*\d+ chars/)
  })

  test("matrix writes the decrypted body when the flag asks for it", () => {
    const run = driveInboundLogging("matrix", true)

    expect(run.output).toContain(INBOUND_MARKER)
  })
})
