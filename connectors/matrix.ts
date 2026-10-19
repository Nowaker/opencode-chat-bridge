#!/usr/bin/env bun
/**
 * Matrix Connector for OpenCode Chat Bridge
 *
 * Bridges Matrix rooms to OpenCode via ACP protocol.
 * Uses matrix-bot-sdk with native Rust crypto for E2EE support.
 *
 * Thread Isolation (configurable via chat-bridge.json matrix.threadIsolation):
 *   When enabled, sessions are keyed on room:threadRootEventId so each
 *   Matrix thread gets its own isolated OpenCode session. Plain replies
 *   within a thread are forwarded automatically.
 *
 * Usage:
 *   bun connectors/matrix.ts
 *
 * Environment variables (see .env.example):
 *   MATRIX_HOMESERVER - Matrix server URL (e.g., https://matrix.org)
 *   MATRIX_ACCESS_TOKEN - Bot access token (or use PASSWORD for auto-login)
 *   MATRIX_PASSWORD - Bot password (will login and save token)
 *   MATRIX_USER_ID - Bot user ID (e.g., @mybot:matrix.org)
 *   MATRIX_TRIGGER - Message prefix to trigger bot (default: !oc)
 */

import fs from "fs"
import path from "path"
import os from "os"

// matrix-bot-sdk with native Rust crypto for E2EE
import {
  AutojoinRoomsMixin,
  LogLevel,
  LogService,
  MatrixAuth,
  MatrixClient,
  MessageEvent,
  RichConsoleLogger,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk"

import { ACPClient, type ImageContent, type PermissionRequest } from "../src"
import { getConfig } from "../src/config"
import { marked } from "marked"
import {
  BaseConnector,
  type BaseSession,
  parseCsvList,
  ToolActivityController,
  shouldShowToolOutput,
  extractImagePaths,
  removeImageMarkers,
  sanitizeServerPaths,
} from "../src"

// =============================================================================
// Configuration
// =============================================================================

const config = getConfig()
const HOMESERVER = config.matrix.homeserver
const ACCESS_TOKEN = config.matrix.accessToken || process.env.MATRIX_ACCESS_TOKEN
const PASSWORD = config.matrix.password || process.env.MATRIX_PASSWORD
const USER_ID = config.matrix.userId || process.env.MATRIX_USER_ID
const TRIGGER = process.env.MATRIX_TRIGGER || config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const FORMAT_HTML = config.matrix.formatHtml || false
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)
const THREAD_ISOLATION = config.matrix.threadIsolation
const ENV_ALLOWED_USERS = parseCsvList(process.env.MATRIX_ALLOWED_USERS)
const ALLOWED_USERS = ENV_ALLOWED_USERS.length > 0 ? ENV_ALLOWED_USERS : config.matrix.allowedUsers
const ENV_ALLOWED_ROOMS = parseCsvList(process.env.MATRIX_ALLOWED_ROOMS)
const ALLOWED_ROOMS = ENV_ALLOWED_ROOMS.length > 0 ? ENV_ALLOWED_ROOMS : config.matrix.allowedRooms
const LOG_INBOUND_MESSAGES = config.matrix.logInboundMessages
const AUTO_UPLOAD_FILES = config.matrix.autoUploadFiles
const IGNORE_ROOMS = new Set(config.matrix.ignoreRooms)

// Storage paths
const STORAGE_PATH = process.env.MATRIX_STORAGE_PATH ||
  path.join(os.homedir(), ".local", "share", "opencode-matrix-bot")
const STATE_STORAGE_PATH = path.join(STORAGE_PATH, "bot-state.json")
const CRYPTO_STORAGE_PATH = path.join(STORAGE_PATH, "crypto")
const TOKEN_FILE_PATH = path.join(STORAGE_PATH, "access_token")

// =============================================================================
// Thread Context Helpers (imported from standalone file for testability)
// =============================================================================

export {
  type MatrixEventContext,
  extractThreadRootId,
  extractBotNameQuery,
  resolveThreadRoot,
  buildMatrixSessionId,
  normalizeMatrixEventContext,
  buildThreadRelation,
  shouldHandleThreadReply,
} from "./matrix-thread-helpers"
import {
  type MatrixEventContext,
  extractThreadRootId,
  extractBotNameQuery,
  normalizeMatrixEventContext,
  buildThreadRelation,
  shouldHandleThreadReply,
} from "./matrix-thread-helpers"
import { diagnoseEmptyResponse } from "../src/acp-response-diagnostics"
import { resolveMatrixAccessToken, writePrivateFileAtomically } from "./matrix-auth"
import { RelayClient, RelayError } from "../src/relay/client"
import type { InboundRequest, OutboxItem } from "../src/relay/types"

// Relay mode: this container is transport only. Accepted messages go to
// ai-bridge-relay on the host, which prompts a Vibeterm coordinator session,
// and that session's answers come back through the relay's outbox. No agent
// runs here, and BaseConnector refuses to create one.
const RELAY_SOCKET = process.env.RELAY_SOCKET || ""
const RELAY_INBOUND_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000]
const RELAY_OUTBOX_WAIT_MS = 8_000
const TYPING_TIMEOUT_MS = 30_000
const TYPING_REFRESH_MS = 20_000

// =============================================================================
// Session Type
// =============================================================================

interface RoomSession extends BaseSession {
  /** Track the last event ID sent in each thread for m.in_reply_to fallback */
  lastEventIds: Map<string, string>
}

// =============================================================================
// Matrix Connector
// =============================================================================

export class MatrixConnector extends BaseConnector<RoomSession> {
  private matrix: MatrixClient | null = null
  private threadIsolation: boolean
  private readonly relay: RelayClient | null = RELAY_SOCKET ? new RelayClient(RELAY_SOCKET) : null
  private stopping = false
  private typingRooms = new Map<string, number>()

  constructor() {
    super({
      connector: "matrix",
      trigger: TRIGGER,
      botName: BOT_NAME,
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
      allowedUsers: ALLOWED_USERS,
      allowedChannels: ALLOWED_ROOMS,
    })
    this.threadIsolation = THREAD_ISOLATION
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!ACCESS_TOKEN && !PASSWORD) {
      console.error("Error: Either MATRIX_ACCESS_TOKEN or MATRIX_PASSWORD must be set")
      console.error("Password-based login will save the token for future use.")
      process.exit(1)
    }

    this.log("Starting...")
    console.log(`  Homeserver: ${HOMESERVER}`)
    console.log(`  User: ${USER_ID}`)
    console.log(`  Storage: ${STORAGE_PATH}`)
    console.log(`  E2EE: enabled (Rust crypto with SQLite)`)
    this.logStartup()
    console.log(`  Thread isolation: ${this.threadIsolation ? "on (per-thread sessions)" : "off (per-room sessions)"}`)
    if (this.relay) {
      console.log(`  Backend: ai-bridge-relay at ${RELAY_SOCKET} (transport only; no agent runs in this container)`)
    } else {
      await this.cleanupSessions()
    }

    fs.mkdirSync(STORAGE_PATH, { recursive: true })
    fs.mkdirSync(CRYPTO_STORAGE_PATH, { recursive: true })

    let accessToken = await this.getOrCreateAccessToken()
    if (!accessToken) {
      console.error("Error: Could not obtain access token")
      process.exit(1)
    }

    LogService.setLogger(new RichConsoleLogger())
    LogService.setLevel(LogLevel.INFO)
    LogService.muteModule("Metrics")

    const stateStorage = new SimpleFsStorageProvider(STATE_STORAGE_PATH)
    const cryptoStorage = new RustSdkCryptoStorageProvider(CRYPTO_STORAGE_PATH)

    this.matrix = new MatrixClient(HOMESERVER, accessToken, stateStorage, cryptoStorage)
    AutojoinRoomsMixin.setupOnClient(this.matrix)

    this.matrix.on("room.failed_decryption", async (roomId: string, event: any, error: Error) => {
      this.log(`[CRYPTO] Failed to decrypt in ${roomId}: ${error.message}`)
    })

    this.matrix.on("room.message", this.handleRoomMessage.bind(this))
    await this.matrix.start()

    if (this.relay) {
      await this.logRelayHealth()
      void this.runRelayOutbox()
    } else {
      this.startSessionExpiryLoop()
    }
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    this.stopping = true
    await this.updateTyping([])
    await this.disconnectAllSessions()
    if (this.matrix) this.matrix.stop()
    this.log("Stopped.")
  }

  async sendMessage(roomId: string, rawText: string): Promise<void> {
    try {
      const text = this.safeOutboundText(rawText)
      if (FORMAT_HTML) {
        const html = await marked.parse(text)
        await this.matrix!.sendMessage(roomId, {
          msgtype: "m.text",
          body: text,
          format: "org.matrix.custom.html",
          formatted_body: html,
        })
      } else {
        await this.matrix!.sendText(roomId, text)
      }
    } catch (err) {
      this.logError(`Failed to send message to ${roomId}:`, err)
    }
  }

  /**
   * Send a reply, respecting threadIsolation config.
   * When true: send as thread reply with m.relates_to.
   * When false: send plain message to room.
   * Returns the event ID of the sent message (for tracking lastEventId).
   */
  private async sendReply(context: MatrixEventContext, rawText: string): Promise<string | null> {
    try {
      const text = this.safeOutboundText(rawText)
      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
        const relation = buildThreadRelation(context.replyThreadRootId, lastEventId)

        let content: any
        if (FORMAT_HTML) {
          const html = await marked.parse(text)
          content = {
            msgtype: "m.text",
            body: text,
            format: "org.matrix.custom.html",
            formatted_body: html,
            "m.relates_to": relation,
          }
        } else {
          content = {
            msgtype: "m.text",
            body: text,
            "m.relates_to": relation,
          }
        }

        const eventId = await this.matrix!.sendMessage(context.roomId, content)
        // Track for next m.in_reply_to
        if (session && eventId) {
          session.lastEventIds.set(context.replyThreadRootId, eventId)
        }
        return eventId
      } else {
        await this.sendMessage(context.roomId, text)
        return null
      }
    } catch (err) {
      this.logError(`Failed to send reply to ${context.roomId}:`, err)
      return null
    }
  }

  /**
   * Send a notice (for tool activity), respecting thread isolation.
   */
  private async sendNoticeReply(context: MatrixEventContext, rawText: string): Promise<void> {
    try {
      const text = this.safeOutboundText(rawText)
      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
        const relation = buildThreadRelation(context.replyThreadRootId, lastEventId)

        const eventId = await this.matrix!.sendMessage(context.roomId, {
          msgtype: "m.notice",
          body: text,
          "m.relates_to": relation,
        })
        if (session && eventId) {
          session.lastEventIds.set(context.replyThreadRootId, eventId)
        }
      } else {
        await this.matrix!.sendNotice(context.roomId, text)
      }
    } catch (err) {
      this.logError(`Failed to send notice to ${context.roomId}:`, err)
    }
  }

  private async createToolActivityMessage(context: MatrixEventContext, text: string): Promise<string | null> {
    if (!this.matrix) return null
    const content: Record<string, unknown> = {
      msgtype: "m.notice",
      body: this.safeOutboundText(`> ${text}`),
    }
    if (this.threadIsolation) {
      const session = this.sessionManager.get(context.sessionId)
      const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
      content["m.relates_to"] = buildThreadRelation(context.replyThreadRootId, lastEventId)
    }
    const eventId = await this.matrix.sendMessage(context.roomId, content)
    const session = this.sessionManager.get(context.sessionId)
    if (this.threadIsolation && session && eventId) {
      session.lastEventIds.set(context.replyThreadRootId, eventId)
    }
    return eventId || null
  }

  private async updateToolActivityMessage(context: MatrixEventContext, eventId: string, text: string): Promise<void> {
    if (!this.matrix) return
    const body = this.safeOutboundText(`> ${text}`)
    await this.matrix.sendMessage(context.roomId, {
      msgtype: "m.notice",
      body: `* ${body}`,
      "m.new_content": {
        msgtype: "m.notice",
        body,
      },
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: eventId,
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  private async getOrCreateAccessToken(): Promise<string | null> {
    let savedToken = ""
    try {
      if (fs.existsSync(TOKEN_FILE_PATH)) {
        savedToken = fs.readFileSync(TOKEN_FILE_PATH, "utf-8").trim()
      }
    } catch (err) {
      this.logError("Failed to read saved Matrix access token:", err)
      throw err
    }

    return resolveMatrixAccessToken({
      explicitToken: ACCESS_TOKEN || "",
      savedToken,
      passwordConfigured: Boolean(PASSWORD),
      expectedUserId: USER_ID || "",
    }, {
      validateToken: async (token) => {
        const client = new MatrixClient(HOMESERVER, token)
        const whoami = await client.getWhoAmI()
        return { userId: whoami.user_id }
      },
      loginWithPassword: () => this.loginWithPassword(),
      saveToken: (token) => this.saveAccessToken(token),
      log: (message) => this.log(message),
    })
  }

  private saveAccessToken(accessToken: string): void {
    writePrivateFileAtomically(TOKEN_FILE_PATH, accessToken)
  }

  private async loginWithPassword(): Promise<string | null> {
    this.log("Logging in with password...")
    try {
      const auth = new MatrixAuth(HOMESERVER)
      const username = USER_ID!.split(":")[0].replace("@", "")
      const client = await auth.passwordLogin(username, PASSWORD!, "OpenCode Chat Bridge")
      const accessToken = client.accessToken
      this.log("Password login successful")
      return accessToken
    } catch (err: any) {
      this.logError("Password login failed:", err.message || err)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  /**
   * Log an inbound message without writing its body to stdout by default.
   * This connector decrypts an E2EE room to work, so printing the body would
   * put in the process log exactly what the room's encryption keeps off the
   * wire. Every inbound handler routes through here.
   */
  private logInbound(label: string, sender: string, sessionId: string, text: string): void {
    const detail = LOG_INBOUND_MESSAGES ? text : `${text.length} chars`
    this.log(`[${label}] ${sender} in ${sessionId}: ${detail}`)
  }

  private async handleRoomMessage(roomId: string, event: any): Promise<void> {
    const message = new MessageEvent(event)

    if (message.messageType !== "m.text") return

    if (!this.isChannelAllowed(roomId)) return
    if (IGNORE_ROOMS.has(roomId)) {
      this.log(`[IGNORED] Message from ignored room: ${roomId}`)
      return
    }

    const myUserId = await this.matrix!.getUserId()
    if (message.sender === myUserId) return
    if (!this.isUserAllowed(message.sender)) return

    const body = message.textBody.trim()
    if (!body) return

    // Deduplicate events (Matrix sync replays)
    if (this.isDuplicateEvent(event.event_id || `${roomId}:${Date.now()}`)) return

    const threadRootEventId = extractThreadRootId(event)

    const context = normalizeMatrixEventContext({
      roomId,
      sender: message.sender,
      text: body,
      eventId: event.event_id,
      threadRootEventId,
    }, this.threadIsolation)

    // Touch session activity
    const existingSession = this.sessionManager.get(context.sessionId)
    if (existingSession) existingSession.lastActivity = new Date()

    // Check if this is a DM
    const members = await this.matrix!.getJoinedRoomMembers(roomId)
    const isDM = members.length === 2

    // Extract query
    let query = ""
    let implicit = false
    const botNameQuery = extractBotNameQuery(body, BOT_NAME)
    if (body.startsWith(TRIGGER + " ")) {
      query = body.slice(TRIGGER.length + 1).trim()
    } else if (body.startsWith(TRIGGER)) {
      query = body.slice(TRIGGER.length).trim()
    } else if (body.includes(myUserId)) {
      query = body.replace(myUserId, "").trim()
    } else if (botNameQuery !== null) {
      query = botNameQuery
    } else if (isDM) {
      query = body
    } else if (this.threadIsolation && shouldHandleThreadReply({
      enabled: config.matrix.respondToThreadReplies,
      text: body,
      threadRootEventId,
      trigger: TRIGGER,
      botUserId: myUserId,
    }) && (this.relay !== null || this.sessionManager.has(context.sessionId))) {
      // Implicit thread follow-up. In relay mode the relay knows which
      // threads it serves; there is no local session to ask.
      query = body
      implicit = true
      this.logInbound("THREAD", message.sender, context.sessionId, body)
    } else {
      return
    }

    query = query.replace(/^[:\s]+/, "").trim()
    if (!query) return

    if (this.relay) {
      if (!implicit) this.logInbound("MSG", message.sender, context.sessionId, body)
      await this.forwardToRelay(context, event, query, implicit)
      return
    }

    // Before anything that could start a turn or be rate limited: a permission
    // reply answers the turn already waiting, it does not open a new one.
    const permissionReply = async (text: string) => { await this.sendReply(context, text) }
    if (await this.handlePermissionReply(context.sessionId, message.sender, query, permissionReply)) return

    this.logInbound("MSG", message.sender, context.sessionId, body)

    await this.stopMirrorForUserActivity(context.sessionId, query, async (text) => {
      await this.sendNoticeReply(context, text)
    })

    // Handle commands
    if (query.startsWith("/")) {
      const cmdName = query.slice(1).split(" ")[0].toLowerCase()
      const bridgeCommands = ["status", "clear", "reset", "help", "h", "p", "projects", "s", "sessions", "m", "mirror", "r", "reload", "d", "detach"]
      if (bridgeCommands.includes(cmdName)) {
        const openCodeCommands = existingSession?.client.availableCommands || []
        await this.handleCommand(context.sessionId, query, async (text) => {
          await this.sendNoticeReply(context, text)
        }, { openCodeCommands })
        return
      }

      this.logInbound("CMD", message.sender, context.sessionId, query)
      if (!this.checkRateLimit(message.sender)) return
      await this.processQuery(context, query)
      return
    }

    if (!this.checkRateLimit(message.sender)) return
    await this.processQuery(context, query)
  }

  // ---------------------------------------------------------------------------
  // Relay mode
  // ---------------------------------------------------------------------------

  private async logRelayHealth(): Promise<void> {
    try {
      const health = await this.relay!.health()
      const routes = (health.routes ?? {}) as Record<string, { enabled?: boolean; sessionID?: string }>
      const route = routes["matrix"]
      this.log(`[RELAY] reachable; matrix route ${route?.enabled ? `-> ${route.sessionID}` : "is not enabled there"}`)
    } catch (err) {
      this.logError(`[RELAY] not reachable yet: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The relay dedupes on the event id, so a retry after a lost answer is never a second prompt. */
  private async forwardToRelay(context: MatrixEventContext, event: any, query: string, implicit: boolean): Promise<void> {
    const request: InboundRequest = {
      route: "matrix",
      eventId: context.eventId,
      roomId: context.roomId,
      threadRootId: context.threadRootEventId,
      sender: context.sender,
      postedAt: typeof event?.origin_server_ts === "number" ? event.origin_server_ts : Date.now(),
      text: query,
      implicit,
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.relay!.inbound(request)
        const detail = [result.relayId, result.reason].filter(Boolean).join(": ")
        this.log(`[RELAY] ${result.state}${detail ? ` ${detail}` : ""} [${context.sessionId}]`)
        return
      } catch (err) {
        const retryable = !(err instanceof RelayError) || err.retryable
        const delay = RELAY_INBOUND_DELAYS_MS[attempt]
        if (!retryable || delay === undefined || this.stopping) {
          this.logError(`[RELAY] inbound failed [${context.sessionId}]: ${err instanceof Error ? err.message : String(err)}`)
          await this.sendNoticeReply(context, "⚠ The relay did not take this message, so it was not delivered. Resend it once the relay is back.")
          return
        }
        await Bun.sleep(delay)
      }
    }
  }

  private async runRelayOutbox(): Promise<void> {
    let lastError = ""
    while (!this.stopping) {
      try {
        const batch = await this.relay!.outbox("matrix", RELAY_OUTBOX_WAIT_MS)
        if (lastError) {
          this.log("[RELAY] outbox reachable again")
          lastError = ""
        }
        await this.updateTyping(batch.typingRooms)
        for (const item of batch.items) {
          if (this.stopping) return
          await this.deliverRelayItem(item)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message !== lastError) this.logError(`[RELAY] outbox unavailable: ${message}`)
        lastError = message
        await Bun.sleep(5_000)
      }
    }
  }

  private async deliverRelayItem(item: OutboxItem): Promise<void> {
    let chatEventId: string
    try {
      chatEventId = await this.sendRelayItem(item)
    } catch (err) {
      const status = (err as { statusCode?: unknown })?.statusCode
      // A 4xx other than rate limiting is a refusal that a retry cannot fix.
      // Anything else may have landed; the relay offers it again under the
      // same transaction id, which the homeserver deduplicates.
      const definite = typeof status === "number" && status >= 400 && status < 500 && status !== 429
      const message = err instanceof Error ? err.message : String(err)
      this.logError(`[RELAY] post ${item.outboxId} failed${definite ? " (refused)" : ""}: ${message}`)
      await this.relay!.nack(item.outboxId, message, definite)
        .catch((nackErr) => this.logError(`[RELAY] nack of ${item.outboxId} failed:`, nackErr))
      return
    }
    this.log(`[RELAY] posted ${item.outboxId} as ${chatEventId}`)
    await this.relay!.ack(item.outboxId, chatEventId)
      .catch((ackErr) => this.logError(`[RELAY] ack of ${item.outboxId} failed; it will be offered again under the same transaction id:`, ackErr))
  }

  /**
   * matrix-bot-sdk's `sendEvent`, but with the relay's transaction id. The
   * homeserver deduplicates a repeated id per access token, so posting an item
   * again after a lost acknowledgement returns the first event; the SDK mints a
   * fresh id on every call, which would make that retry a second message.
   */
  private async sendRelayItem(item: OutboxItem): Promise<string> {
    const matrix = this.matrix!
    const body = this.safeOutboundText(item.text)
    const content: Record<string, unknown> = { msgtype: item.kind === "notice" ? "m.notice" : "m.text", body }
    if (FORMAT_HTML) {
      content.format = "org.matrix.custom.html"
      content.formatted_body = await marked.parse(body)
    }
    if (item.threadRootId) {
      content["m.relates_to"] = buildThreadRelation(item.threadRootId, item.replyToEventId || item.threadRootId)
    }
    let eventType = "m.room.message"
    let payload: unknown = content
    if (await matrix.crypto?.isRoomEncrypted(item.roomId)) {
      payload = await matrix.crypto.encryptRoomEvent(item.roomId, eventType, content)
      eventType = "m.room.encrypted"
    }
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(item.roomId)}/send/` +
      `${encodeURIComponent(eventType)}/${encodeURIComponent(item.txnId)}`
    const response = await matrix.doRequest("PUT", path, null, payload)
    const eventId = response?.event_id
    if (typeof eventId !== "string" || !eventId) throw new Error("the homeserver answered without an event id")
    return eventId
  }

  private async updateTyping(rooms: string[]): Promise<void> {
    if (!this.matrix) return
    const now = Date.now()
    const next = new Map<string, number>()
    for (const room of rooms.filter((r) => this.isChannelAllowedQuietly(r))) {
      const refreshedAt = this.typingRooms.get(room)
      if (refreshedAt !== undefined && now - refreshedAt < TYPING_REFRESH_MS) {
        next.set(room, refreshedAt)
        continue
      }
      await this.matrix.setTyping(room, true, TYPING_TIMEOUT_MS)
        .catch((err) => this.logError(`[RELAY] typing on in ${room} failed:`, err))
      next.set(room, now)
    }
    for (const room of this.typingRooms.keys()) {
      if (next.has(room)) continue
      await this.matrix.setTyping(room, false)
        .catch((err) => this.logError(`[RELAY] typing off in ${room} failed:`, err))
    }
    this.typingRooms = next
  }

  // ---------------------------------------------------------------------------
  // Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(context: MatrixEventContext, query: string): Promise<void> {
    if (this.isQueryActive(context.sessionId)) {
      await this.sendReply(context, "A request is already running. Please wait for it to finish.")
      return
    }

    let activeClient: ACPClient | null = null
    const activeQuery = this.markQueryActive(context.sessionId, () => activeClient?.cancel())
    const startTime = Date.now()
    const initialSession = await this.getOrCreateSession(
      context.sessionId,
      (client) => this.createSession(client),
    )
    if (!initialSession) {
      try {
        await this.sendReply(context, "Sorry, I couldn't connect to the AI service.")
      } finally {
        this.markQueryDone(context.sessionId, activeQuery)
      }
      return
    }
    activeClient = initialSession.client

    const runAttempt = async (session: RoomSession) => {
      const client = session.client
      activeClient = client
      let responseBuffer = ""
      let chunkCount = 0
      let toolResultsBuffer = ""
      let toolCallCount = 0
      let hadToolActivity = false
      let imageCount = 0
      const sentToolOutputs = new Set<string>()
      const toolActivity = new ToolActivityController(config.toolMessages, {
        create: (text) => this.createToolActivityMessage(context, text),
        update: (eventId, text) => this.updateToolActivityMessage(context, eventId, text),
        onError: (error) => this.logError("Failed to update tool activity:", error),
      }, {
        sendEvent: (message) => this.sendNoticeReply(context, `> ${message}`),
        onToolStart: () => {
          hadToolActivity = true
          toolCallCount++
        },
      })

      const chunkHandler = (chunk: string) => {
        chunkCount++
        responseBuffer += chunk
      }
      client.on("chunk", chunkHandler)

      const updateHandler = async (update: any) => {
        if (update.type === "tool_result" && update.toolResult) {
          hadToolActivity = true
          toolResultsBuffer += update.toolResult

          const toolName = update.toolName || ""
          if (!shouldShowToolOutput(toolName, config.toolMessages)) {
            this.log(`[RESULT] Skipping ${toolName} result (not in toolMessages.showOutputFor)`)
            return
          }

          const maxLen = 2000
          const result = update.toolResult.length > maxLen
            ? update.toolResult.slice(0, maxLen) + "\n... (truncated)"
            : update.toolResult
          const trimmed = result.trim()
          if (!trimmed) return

          const contentHash = trimmed.slice(0, 100)
          if (sentToolOutputs.has(contentHash)) return
          sentToolOutputs.add(contentHash)
          try {
            await this.sendReply(context, trimmed)
          } catch (err) {
            this.log(`[RESULT] Error sending: ${err}`)
          }
        }

        if (update.type === "tool_output_delta" && update.partialOutput) {
          hadToolActivity = true
          const toolName = update.toolName || ""
          if (shouldShowToolOutput(toolName, config.toolMessages)) {
            const output = update.partialOutput.trim()
            if (output) {
              const contentHash = output.slice(0, 100)
              if (!sentToolOutputs.has(contentHash)) {
                sentToolOutputs.add(contentHash)
                await this.sendReply(context, output)
                this.log(`[STREAM] Sent ${toolName} output (${output.length} chars)`)
              }
            }
          }
        }
      }
      client.on("update", updateHandler)

      const imageHandler = async (image: ImageContent) => {
        imageCount++
        this.log(`Received image: ${image.mimeType}`)
        await this.sendImageFromBase64(context, image)
      }
      client.on("image", imageHandler)

      const permissionHandler = async (event: { permission: string; path: string | null; message: string }) => {
        hadToolActivity = true
        this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
        await this.sendNoticeReply(context, `> ${event.message}`)
      }
      client.on("permission_rejected", permissionHandler)

      // context.sessionId is this connector's session key -- room:threadRoot
      // under thread isolation, bare room without it. The reply interception in
      // handleRoomMessage resolves the same expression, so the broker's
      // wrong-thread check compares two ids from one namespace.
      const permissionRequestHandler = async (request: PermissionRequest) => {
        hadToolActivity = true
        await this.presentPermissionRequest(
          context.sessionId,
          request,
          client,
          async (text) => { await this.sendReply(context, text) },
        )
      }
      client.on("permission_requested", permissionRequestHandler)
      client.on("activity", toolActivity.handleActivity)
      client.on("tool_activity", toolActivity.handleRevision)

      try {
        const acpResponse = await client.prompt(query)
        return {
          acpResponse,
          responseBuffer,
          chunkCount,
          toolCallCount,
          hadToolActivity,
          imageCount,
          toolResultsBuffer,
        }
      } finally {
        await toolActivity.flush()
        client.off("activity", toolActivity.handleActivity)
        client.off("tool_activity", toolActivity.handleRevision)
        client.off("chunk", chunkHandler)
        client.off("update", updateHandler)
        client.off("image", imageHandler)
        client.off("permission_rejected", permissionHandler)
        client.off("permission_requested", permissionRequestHandler)
      }
    }

    try {
      let session = initialSession
      session.messageCount++
      session.inputChars += query.length
      session.lastEventIds.set(context.replyThreadRootId, context.eventId)

      let attempt = await runAttempt(session)
      let cleanResponse = sanitizeServerPaths(removeImageMarkers(attempt.responseBuffer))
      let diagnostic = diagnoseEmptyResponse(attempt.acpResponse, attempt.responseBuffer, cleanResponse)

      if (diagnostic?.source === "bridge-capture-lost") {
        this.log(
          `[ACP] Captured response recovery source=${diagnostic.source} ` +
          `acpChars=${diagnostic.acpChars} bridgeChars=${diagnostic.bridgeChars} ` +
          `cleanChars=${diagnostic.cleanChars} chunks=${attempt.chunkCount} [${context.sessionId}]`,
        )
        attempt.responseBuffer = attempt.acpResponse
        cleanResponse = sanitizeServerPaths(removeImageMarkers(attempt.responseBuffer))
        diagnostic = diagnoseEmptyResponse(attempt.acpResponse, attempt.responseBuffer, cleanResponse)
      }

      if (diagnostic) {
        this.log(
          `[ACP] Empty response attempt=1 source=${diagnostic.source} ` +
          `acpChars=${diagnostic.acpChars} bridgeChars=${diagnostic.bridgeChars} ` +
          `cleanChars=${diagnostic.cleanChars} chunks=${attempt.chunkCount} ` +
          `tools=${attempt.toolCallCount} toolActivity=${attempt.hadToolActivity} ` +
          `images=${attempt.imageCount} [${context.sessionId}]`,
        )

        if (!attempt.hadToolActivity && attempt.imageCount === 0) {
          this.log(`[ACP] Retrying once with a fresh client/session [${context.sessionId}]`)
          const retrySession = await this.recreateACPSession(
            context.sessionId,
            (client) => this.createSession(client),
          )
          if (!retrySession) throw new Error("Failed to create a fresh ACP session for retry")
          session = retrySession
          session.messageCount++
          session.inputChars += query.length
          session.lastEventIds.set(context.replyThreadRootId, context.eventId)
          attempt = await runAttempt(session)
          cleanResponse = sanitizeServerPaths(removeImageMarkers(attempt.responseBuffer))
          diagnostic = diagnoseEmptyResponse(attempt.acpResponse, attempt.responseBuffer, cleanResponse)

          if (diagnostic?.source === "bridge-capture-lost") {
            this.log(
              `[ACP] Captured response recovery attempt=2 source=${diagnostic.source} ` +
              `acpChars=${diagnostic.acpChars} bridgeChars=${diagnostic.bridgeChars} ` +
              `cleanChars=${diagnostic.cleanChars} chunks=${attempt.chunkCount} [${context.sessionId}]`,
            )
            attempt.responseBuffer = attempt.acpResponse
            cleanResponse = sanitizeServerPaths(removeImageMarkers(attempt.responseBuffer))
            diagnostic = diagnoseEmptyResponse(attempt.acpResponse, attempt.responseBuffer, cleanResponse)
          }

          if (diagnostic) {
            this.log(
              `[ACP] Empty response attempt=2 source=${diagnostic.source} ` +
              `acpChars=${diagnostic.acpChars} bridgeChars=${diagnostic.bridgeChars} ` +
              `cleanChars=${diagnostic.cleanChars} chunks=${attempt.chunkCount} ` +
              `tools=${attempt.toolCallCount} toolActivity=${attempt.hadToolActivity} ` +
              `images=${attempt.imageCount} [${context.sessionId}]`,
            )
          }
        }
      }

      if (diagnostic) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        this.log(
          `[FAIL] ${elapsed}s empty ACP response source=${diagnostic.source} ` +
          `acpChars=${diagnostic.acpChars} bridgeChars=${diagnostic.bridgeChars} ` +
          `cleanChars=${diagnostic.cleanChars} [${context.sessionId}]`,
        )
        await this.sendReply(
          context,
          "Sorry, the ACP backend completed without returning a usable response. Please try again.",
        )
        return
      }

      await this.uploadDetectedFiles(context, attempt.toolResultsBuffer, attempt.responseBuffer)

      session.outputChars += cleanResponse.length
      await this.sendReply(context, cleanResponse)

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const tools = attempt.toolCallCount > 0
        ? `, ${attempt.toolCallCount} tool${attempt.toolCallCount > 1 ? "s" : ""}`
        : ""
      this.log(`[DONE] ${elapsed}s (${cleanResponse.length} chars${tools}) [${context.sessionId}]`)
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      this.logError(`[FAIL] ${elapsed}s [${context.sessionId}]:`, err)
      await this.sendReply(context, "Sorry, something went wrong processing your request.")
    } finally {
      const session = this.sessionManager.get(context.sessionId)
      if (session) session.lastActivity = new Date()
      this.markQueryDone(context.sessionId, activeQuery)
    }
  }

  protected createManagedSession(client: ACPClient): RoomSession {
    return this.createSession(client)
  }

  private createSession(client: ACPClient): RoomSession {
    return {
      ...this.createBaseSession(client),
      lastEventIds: new Map(),
    }
  }

  // ---------------------------------------------------------------------------
  // Image sending (thread-aware)
  // ---------------------------------------------------------------------------

  /**
   * Upload files whose paths were named in tool results or in the model's own
   * text.
   *
   * The bridge itself opens these paths, so the agent's tool permissions never
   * see the read: naming a path that happens to exist is enough to move the
   * file. `toolMessages` does not constrain it either -- the buffers are
   * filled before the show/hide decision, which only suppresses printing.
   */
  private async uploadDetectedFiles(
    context: MatrixEventContext,
    toolResultsBuffer: string,
    responseBuffer: string,
  ): Promise<void> {
    if (!AUTO_UPLOAD_FILES) return

    const uploaded = new Set<string>()
    for (const imagePath of [...extractImagePaths(toolResultsBuffer), ...extractImagePaths(responseBuffer)]) {
      if (uploaded.has(imagePath)) continue
      if (!fs.existsSync(imagePath)) continue
      uploaded.add(imagePath)
      this.log(`Uploading image: ${imagePath}`)
      await this.sendImageFromFile(context, imagePath)
    }
  }

  private async sendImageFromBase64(context: MatrixEventContext, image: ImageContent): Promise<void> {
    if (!AUTO_UPLOAD_FILES) return

    try {
      const buffer = Buffer.from(image.data, "base64")
      const mxcUrl = await this.matrix!.uploadContent(buffer, image.mimeType, image.alt || "image.png")

      const content: any = {
        msgtype: "m.image",
        body: this.safeOutboundText(image.alt || "Image"),
        url: mxcUrl,
        info: { mimetype: image.mimeType, size: buffer.length },
      }

      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
        content["m.relates_to"] = buildThreadRelation(context.replyThreadRootId, lastEventId)
      }

      const eventId = await this.matrix!.sendMessage(context.roomId, content)
      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        if (session && eventId) {
          session.lastEventIds.set(context.replyThreadRootId, eventId)
        }
      }

      this.log(`Sent image to ${context.roomId}: ${mxcUrl}`)
    } catch (err) {
      this.logError(`Failed to send image to ${context.roomId}:`, err)
      await this.sendReply(context, `[Image: ${image.alt || "Unable to display"}]`)
    }
  }

  private async sendImageFromFile(context: MatrixEventContext, filePath: string): Promise<void> {
    // Both senders check the flag themselves, so every path to uploadContent
    // is covered no matter which call site reaches it.
    if (!AUTO_UPLOAD_FILES) return

    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Image file not found: ${filePath}`)
        return
      }

      const buffer = fs.readFileSync(filePath)
      const fileName = path.basename(filePath)
      const mxcUrl = await this.matrix!.uploadContent(buffer, "image/png", fileName)

      const content: any = {
        msgtype: "m.image",
        body: this.safeOutboundText(fileName),
        url: mxcUrl,
        info: { mimetype: "image/png", size: buffer.length },
      }

      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
        content["m.relates_to"] = buildThreadRelation(context.replyThreadRootId, lastEventId)
      }

      const eventId = await this.matrix!.sendMessage(context.roomId, content)
      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        if (session && eventId) {
          session.lastEventIds.set(context.replyThreadRootId, eventId)
        }
      }

      this.log(`Sent image from file to ${context.roomId}: ${mxcUrl}`)
    } catch (err) {
      this.logError(`Failed to send image from file to ${context.roomId}:`, err)
    }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new MatrixConnector()
  process.on("SIGINT", async () => { await connector.stop(); process.exit(0) })
  process.on("SIGTERM", async () => { await connector.stop(); process.exit(0) })
  await connector.start()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err)
    process.exit(1)
  })
}
