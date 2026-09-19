/**
 * Base classes and utilities for chat connectors
 * 
 * Provides standardized session management, rate limiting, event deduplication,
 * active query guarding, session expiry, and command handling
 * that all connectors inherit from.
 */

import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import { ACPClient, type ACPSessionInfo, type ActivityEvent, type LoadedSessionHistoryItem, type OpenCodeCommand, type PermissionRequest, type ToolActivityRevision } from "./acp-client"
import {
  getConfig,
  type ACPConfig,
  type SafeOutputConfig,
  type ToolMessageMode,
  type ToolMessagesConfig,
  type ToolSummariesConfig,
} from "./config"
import { redactSecrets, summarizeToolCall } from "./safe-output"
import {
  PermissionBroker,
  formatPermissionPrompt,
  resolveRejectOption,
} from "./permission-broker"
import { ACPSessionStore } from "./session-store"
import { 
  resolveSessionWorkspace,
  ensureSessionDir, 
  cleanupOldSessions, 
  estimateTokens,
  getSessionStorageInfo,
  copyOpenCodeConfig,
  copyACPProfile,
} from "./session-utils"

// =============================================================================
// Tool message presentation
// =============================================================================

export function resolveToolMessageMode(options: ToolMessagesConfig): ToolMessageMode {
  if (!options.showCalls) return "off"
  return options.mode || "events"
}

/**
 * Summary policy applied when a configuration omits `toolMessages.summaries`.
 * Both allowlists are empty, so an unconfigured deployment reveals tool names
 * and never a single argument value.
 */
export const FAIL_CLOSED_TOOL_SUMMARIES: ToolSummariesConfig = {
  allowedTools: [],
  allowedFields: [],
  maxFieldLength: 120,
  unlistedTools: "name",
}

/**
 * `showArguments: false` is honoured by emptying the field allowlist rather
 * than by bypassing the summarizer, so there is exactly one path from a tool
 * call to chat text.
 */
export function resolveToolSummaries(options: ToolMessagesConfig): ToolSummariesConfig {
  const summaries = options.summaries || FAIL_CLOSED_TOOL_SUMMARIES
  return options.showArguments ? summaries : { ...summaries, allowedFields: [] }
}

/**
 * Format a tool-start event for a chat channel.
 *
 * The ACP-supplied `description` is deliberately ignored: it is built from raw
 * tool arguments, so rendering it would publish values no allowlist approved.
 * The summary is derived from the arguments themselves instead.
 */
export function formatToolCallMessage(
  activity: ActivityEvent,
  options: ToolMessagesConfig,
  supportsEditablePresentation = false
): string | null {
  const mode = resolveToolMessageMode(options)
  if (activity.type !== "tool_start" || mode === "off") return null
  // Connectors without message-edit support safely fall back to event messages.
  if (supportsEditablePresentation && mode !== "events") return null

  return summarizeToolCall(activity.tool || "unknown", activity.details, resolveToolSummaries(options))
}

export interface EditableToolMessageAdapter {
  create(text: string): Promise<string | null>
  update(messageId: string, text: string): Promise<void>
  onError?(error: unknown): void
}

type ToolTraceEntry = {
  id: string
  tool: string
  details: unknown
  status: ToolActivityRevision["status"]
}

/** Maintains one editable status or cumulative trace message for a request. */
export class ToolActivityPresenter {
  private entries = new Map<string, ToolTraceEntry>()
  private messageIds: Array<string | null> = []
  private renderedPages: Array<string | null> = []
  private dirtyPages = new Set<number>()
  private version = 0
  private renderedVersion = 0
  private syncing: Promise<void> | null = null
  private disabled = false

  constructor(
    private options: ToolMessagesConfig,
    private adapter: EditableToolMessageAdapter
  ) {}

  handle(revision: ToolActivityRevision): void {
    const mode = resolveToolMessageMode(this.options)
    if (this.disabled || (mode !== "status" && mode !== "trace")) return

    const existing = this.entries.get(revision.toolCallId)
    const previousPageCount = this.pageCount()
    this.entries.set(revision.toolCallId, {
      id: revision.toolCallId,
      // ACP update titles may become a path or human description. Preserve the
      // canonical tool name from the initial correlated event.
      tool: existing?.tool && existing.tool !== "unknown"
        ? existing.tool
        : revision.tool || "unknown",
      details: revision.details ?? existing?.details,
      status: revision.status,
    })

    if (mode === "status") {
      this.dirtyPages.add(0)
    } else {
      const entryIndex = [...this.entries.keys()].indexOf(revision.toolCallId)
      const pageIndex = Math.floor(entryIndex / this.maxEntries())
      this.dirtyPages.add(pageIndex)
      const currentPageCount = this.pageCount()
      if (currentPageCount !== previousPageCount) {
        for (let page = 0; page < currentPageCount; page++) this.dirtyPages.add(page)
      }
    }
    this.version++
    if (!this.syncing) this.syncing = this.sync()
  }

  async flush(): Promise<void> {
    await this.syncing
  }

  private async sync(): Promise<void> {
    try {
      while (this.renderedVersion !== this.version) {
        const targetVersion = this.version
        const pages = [...this.dirtyPages].sort((a, b) => a - b)
        this.dirtyPages.clear()
        for (const page of pages) {
          const text = this.render(page)
          const messageId = this.messageIds[page]
          if (messageId) {
            if (this.renderedPages[page] === text) continue
            try {
              await this.adapter.update(messageId, text)
              this.renderedPages[page] = text
            } catch (error) {
              // The original message may have expired, been deleted, or become
              // uneditable. Continue the presentation in a replacement message.
              this.adapter.onError?.(error)
              const replacementId = await this.adapter.create(text)
              if (!replacementId) {
                this.disabled = true
                return
              }
              this.messageIds[page] = replacementId
              this.renderedPages[page] = text
            }
          } else {
            const newMessageId = await this.adapter.create(text)
            if (!newMessageId) {
              this.disabled = true
              return
            }
            this.messageIds[page] = newMessageId
            this.renderedPages[page] = text
          }
        }
        this.renderedVersion = targetVersion
      }
    } catch (error) {
      this.disabled = true
      this.adapter.onError?.(error)
    } finally {
      this.syncing = null
      if (!this.disabled && this.renderedVersion !== this.version) {
        this.syncing = this.sync()
      }
    }
  }

  private formatEntry(entry: ToolTraceEntry): string | null {
    const summary = summarizeToolCall(entry.tool, entry.details, resolveToolSummaries(this.options))
    return summary === null ? null : `[${entry.status}] ${summary}`
  }

  private maxEntries(): number {
    return Math.max(1, this.options.maxTraceEntries || 20)
  }

  private pageCount(): number {
    if (resolveToolMessageMode(this.options) === "status") return 1
    return Math.max(1, Math.ceil(this.entries.size / this.maxEntries()))
  }

  private render(page: number): string {
    const entries = [...this.entries.values()]
    const completed = entries.filter((entry) => entry.status === "completed" || entry.status === "failed").length
    const active = [...entries].reverse().find((entry) => entry.status === "pending" || entry.status === "running")

    if (resolveToolMessageMode(this.options) === "status") {
      if (!active) return `Completed ${completed} tool${completed === 1 ? "" : "s"}.`
      const current = this.formatEntry(active)
      return [
        "Working...",
        ...(current ? [`Current: ${current}`] : []),
        `Completed: ${completed} tool${completed === 1 ? "" : "s"}`,
      ].join("\n")
    }

    const maxEntries = this.maxEntries()
    const pageCount = this.pageCount()
    const pageEntries = entries.slice(page * maxEntries, (page + 1) * maxEntries)
    const pageActive = pageEntries.some((entry) => entry.status === "pending" || entry.status === "running")
    const state = pageActive ? "working" : page === pageCount - 1 && !active ? "completed" : "continued"
    const part = pageCount > 1 ? `part ${page + 1}/${pageCount}, ` : ""
    const header = `Tool trace (${part}${state})`
    const lines = pageEntries
      .map((entry) => this.formatEntry(entry))
      .filter((line): line is string => line !== null)
    return [header, "", ...lines].join("\n")
  }
}

export interface ToolActivityControllerOptions {
  sendEvent(message: string): Promise<void>
  onToolStart?(): void
}

/** Shared ACP listener controller; connectors only provide send/edit adapters. */
export class ToolActivityController {
  private lastEventMessage = ""
  private presenter: ToolActivityPresenter

  constructor(
    private options: ToolMessagesConfig,
    adapter: EditableToolMessageAdapter,
    private callbacks: ToolActivityControllerOptions
  ) {
    this.presenter = new ToolActivityPresenter(options, adapter)
  }

  handleActivity = async (activity: ActivityEvent): Promise<void> => {
    if (activity.type !== "tool_start") return
    this.callbacks.onToolStart?.()
    const message = formatToolCallMessage(activity, this.options, true)
    if (message && message !== this.lastEventMessage) {
      this.lastEventMessage = message
      await this.callbacks.sendEvent(message)
    }
  }

  handleRevision = (revision: ToolActivityRevision): void => {
    this.presenter.handle(revision)
  }

  async flush(): Promise<void> {
    await this.presenter.flush()
  }
}

/**
 * Whether a tool's RAW output may be forwarded verbatim to chat.
 *
 * `showOutputFor` alone is not sufficient authority in this fork. Raw results
 * are unbounded, unsummarized and unredactable by field, so they stay off
 * until `safeOutput.allowRawToolOutput` opts back in to upstream behaviour.
 */
export function shouldShowToolOutput(
  toolName: string,
  options: ToolMessagesConfig,
  safeOutput: Pick<SafeOutputConfig, "allowRawToolOutput"> = getConfig().safeOutput,
): boolean {
  if (!safeOutput.allowRawToolOutput) return false
  return options.showOutputFor.some((name) => {
    const selector = name.trim()
    return selector === "*" || (selector.length > 0 && toolName.includes(selector))
  })
}

// =============================================================================
// Types
// =============================================================================

/**
 * Base session interface - all connector sessions extend this
 */
export interface BaseSession {
  client: ACPClient
  createdAt: Date
  messageCount: number
  lastActivity: Date
  inputChars: number
  outputChars: number
}

/**
 * Calculated session statistics for /status command
 */
export interface SessionStats {
  age: number           // minutes since creation
  lastActivity: number  // minutes since last activity
  inputTokens: number
  outputTokens: number
  totalTokens: number
  contextPercent: string
}

interface ProjectPickerItem {
  cwd: string
  name: string
  sessionCount: number
}

interface MirrorState {
  session: ACPSessionInfo
  timer: ReturnType<typeof setInterval>
  lastFingerprint: string
  sendFn: (text: string) => Promise<void>
  busy: boolean
}

/**
 * Opaque handle for an in-flight query.
 * Pass it back to markQueryDone() so stale/aborted requests cannot clear newer ones.
 */
export interface ActiveQueryHandle {
  readonly sessionId: string
  readonly id: number
  readonly aborted: boolean
}

/**
 * Configuration for BaseConnector
 */
export interface ConnectorConfig {
  connector: string           // "slack", "matrix", "whatsapp"
  trigger: string             // "!oc"
  botName: string             // "OpenCode Bot"
  rateLimitSeconds: number    // 5
  sessionRetentionDays: number // 7 (startup cleanup)
  sessionRetentionMins?: number // 30 (runtime expiry, optional)
  allowedUsers?: string[]
  /** Stable channel/room/group IDs this connector may serve. */
  allowedChannels?: string[]
}

/**
 * Fail-closed membership test.
 *
 * Upstream treats an empty allowlist as "no restriction". This fork inverts
 * that: an absent or empty allowlist denies every ID, so a half-configured
 * deployment stays silent instead of answering everyone who can reach it.
 */
export function isAllowedId(id: string, allowlist: ReadonlySet<string> | null | undefined): boolean {
  if (!id) return false
  if (!allowlist || allowlist.size === 0) return false
  return allowlist.has(id)
}

export function parseCsvList(value?: string): string[] {
  if (!value) return []
  return value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
}

/**
 * Maximum number of characters appended to a user-facing error message when
 * `verboseErrors` is enabled. ACP/backend error messages can be arbitrarily
 * long, so the detail is collapsed and bounded to keep the result within
 * typical chat-platform message limits (e.g. Discord's 2000-character cap).
 */
export const USER_ERROR_DETAIL_MAX_LENGTH = 500

/**
 * Build a user-facing error message.
 *
 * - When `verbose` is false the original `generic` string is returned
 *   unchanged so the existing friendly UX is preserved.
 * - When `verbose` is true the underlying error detail is appended on a new
 *   line. Whitespace is collapsed and the result is bounded to
 *   `maxLength` characters so backend errors cannot exceed connector
 *   message limits.
 */
export function buildUserErrorMessage(
  generic: string,
  err: unknown,
  verbose: boolean,
  maxLength: number = USER_ERROR_DETAIL_MAX_LENGTH,
): string {
  if (!verbose) return generic
  const detail = err instanceof Error ? err.message : String(err)
  const collapsed = detail.replace(/\s+/g, " ").trim()
  if (!collapsed) return generic
  if (collapsed.length <= maxLength) return `${generic}\n${collapsed}`
  const sliceLength = Math.max(0, maxLength - 3)
  return `${generic}\n${collapsed.slice(0, sliceLength).trimEnd()}...`
}

// =============================================================================
// RateLimiter
// =============================================================================

/**
 * Rate limiter to prevent message spam
 * Tracks last message time per user
 */
export class RateLimiter {
  private lastMessages = new Map<string, number>()
  
  /**
   * Check if user is allowed to send a message
   * @returns true if allowed, false if rate limited
   */
  check(userId: string, limitSeconds: number): boolean {
    const now = Date.now()
    const last = this.lastMessages.get(userId) || 0
    if (now - last < limitSeconds * 1000) {
      return false
    }
    this.lastMessages.set(userId, now)
    return true
  }
  
  /**
   * Clear all rate limit tracking
   */
  clear(): void {
    this.lastMessages.clear()
  }
}

// =============================================================================
// EventDeduplicator
// =============================================================================

/**
 * Prevents duplicate event processing across all connectors.
 * Every chat platform can deliver duplicate events (Slack retries,
 * Matrix sync replays, Discord re-deliveries, Mattermost WebSocket replays).
 * 
 * Tracks recently seen event IDs with timestamps and auto-evicts
 * entries older than maxAgeMs (default 5 minutes).
 */
export class EventDeduplicator {
  private seen = new Map<string, number>()
  private maxAgeMs: number
  
  constructor(maxAgeMs: number = 5 * 60 * 1000) {
    this.maxAgeMs = maxAgeMs
  }
  
  /**
   * Check if an event ID has been seen recently.
   * @returns true if duplicate (already seen), false if new
   */
  isDuplicate(eventId: string): boolean {
    this.evictStale()
    if (this.seen.has(eventId)) return true
    this.seen.set(eventId, Date.now())
    return false
  }
  
  /**
   * Remove entries older than maxAgeMs
   */
  private evictStale(): void {
    const cutoff = Date.now() - this.maxAgeMs
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id)
    }
  }
  
  /**
   * Number of tracked events (for testing)
   */
  get size(): number {
    return this.seen.size
  }
  
  /**
   * Clear all tracking
   */
  clear(): void {
    this.seen.clear()
  }
}

// =============================================================================
// SessionManager
// =============================================================================

/**
 * Manages sessions for a connector
 * Provides CRUD operations and statistics tracking
 */
export class SessionManager<T extends BaseSession> {
  public sessions = new Map<string, T>()
  
  get(id: string): T | undefined {
    return this.sessions.get(id)
  }
  
  set(id: string, session: T): void {
    this.sessions.set(id, session)
  }
  
  delete(id: string): boolean {
    return this.sessions.delete(id)
  }
  
  has(id: string): boolean {
    return this.sessions.has(id)
  }
  
  clear(): void {
    this.sessions.clear()
  }
  
  /**
   * Update session statistics after a message exchange
   */
  trackMessage(id: string, inputChars: number, outputChars: number): void {
    const session = this.get(id)
    if (session) {
      session.messageCount++
      session.lastActivity = new Date()
      session.inputChars += inputChars
      session.outputChars += outputChars
    }
  }
  
  /**
   * Calculate session statistics for /status command
   */
  getStats(id: string): SessionStats | null {
    const session = this.get(id)
    if (!session) return null
    
    const age = Math.round((Date.now() - session.createdAt.getTime()) / 1000 / 60)
    const lastActivity = Math.round((Date.now() - session.lastActivity.getTime()) / 1000 / 60)
    const inputTokens = estimateTokens(session.inputChars)
    const outputTokens = estimateTokens(session.outputChars)
    const totalTokens = inputTokens + outputTokens
    // Claude context is ~200k tokens
    const contextPercent = ((totalTokens / 200000) * 100).toFixed(2)
    
    return {
      age,
      lastActivity,
      inputTokens,
      outputTokens,
      totalTokens,
      contextPercent,
    }
  }
}

// =============================================================================
// CommandHandler
// =============================================================================

/**
 * Formats standardized command responses
 */
export class CommandHandler {
  /**
   * Format /status response
   */
  static formatStatusMessage(messageCount: number, stats: SessionStats): string {
    return (
      `Session status:\n` +
      `- Messages: ${messageCount}\n` +
      `- Age: ${stats.age} min | Last active: ${stats.lastActivity} min ago\n` +
      `- Tokens (est): ~${stats.totalTokens.toLocaleString()} (${stats.contextPercent}% of 200k)\n` +
      `  Input: ~${stats.inputTokens.toLocaleString()} | Output: ~${stats.outputTokens.toLocaleString()}\n` +
      `Note: OpenCode auto-compacts when context fills`
    )
  }
  
  /**
   * Format /help response
   * @param trigger Bot trigger prefix (e.g., "!oc")
   * @param botName Bot display name
   * @param openCodeCommands Optional list of OpenCode-native commands
   */
  static formatHelpMessage(
    trigger: string, 
    botName: string, 
    openCodeCommands?: { name: string; description: string }[],
    sessionPickerEnabled = false
  ): string {
    let msg = `${botName} - OpenCode Chat Bridge\n\n`
    msg += `Bridge commands:\n`
    msg += `- /h or /help - Show this help\n`
    msg += `- /status - Show current chat session info\n`
    if (sessionPickerEnabled) {
      msg += `- /p - List saved projects/workdirs from the ACP backend\n`
      msg += `- /p <n> - Select a project/workdir\n`
      msg += `- /s - List saved sessions in the selected project\n`
      msg += `- /s <n> - Switch to a saved session and show recent history\n`
      msg += `- /m <n> - Mirror a saved session read-only, checking every ${Math.max(10, Number(getConfig().sessionPicker.mirrorIntervalSeconds) || 60)}s\n`
      msg += `- /m - Stop mirror mode\n`
      msg += `- /r - Reload current session and show recent history\n`
      msg += `- /d - Detach from the current session without deleting it\n`
    }
    msg += `- /clear or /reset - Delete current session history\n`
    
    if (openCodeCommands && openCodeCommands.length > 0) {
      msg += `\nOpenCode commands:\n`
      for (const cmd of openCodeCommands) {
        msg += `- /${cmd.name} - ${cmd.description}\n`
      }
    }
    
    msg += `\nUsage: ${trigger} <your question>`
    return msg
  }
  
  static formatNoSessionMessage(): string {
    return "No active session."
  }
  
  static formatSessionClearedMessage(): string {
    return "Session cleared. Next message will start a fresh session."
  }
  
  static formatUnknownCommandMessage(command: string): string {
    return `Unknown command: ${command}. Try /help`
  }
  
  static formatConnectionErrorMessage(): string {
    return "Sorry, I couldn't connect to the AI service."
  }
  
  static formatProcessingErrorMessage(): string {
    return "Sorry, something went wrong processing your request."
  }
}

// =============================================================================
// BaseConnector
// =============================================================================

/** Default session expiry sweep interval: 60 seconds */
const EXPIRY_SWEEP_INTERVAL_MS = 60_000

/** Permission windows are short, so they are swept far more often than sessions. */
const PERMISSION_SWEEP_INTERVAL_MS = 5_000

const PERMISSION_TITLE_MAX_LENGTH = 160

/**
 * Extra time the ACP client waits past the broker's own window before denying
 * a held request itself. The broker owns the user-facing expiry message, so it
 * must get a full sweep or two to fire first; the client's timeout is only for
 * requests no connector ever presented.
 */
const PERMISSION_HOLD_GRACE_MS = PERMISSION_SWEEP_INTERVAL_MS * 3

/**
 * Parse SESSION_RETENTION_MINS from environment.
 * Returns undefined if not set or invalid (connector uses no runtime expiry).
 */
function parseSessionRetentionMins(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.SESSION_RETENTION_MINS
  if (!raw) return undefined
  const mins = parseInt(raw, 10)
  if (Number.isFinite(mins) && mins > 0) return mins
  return undefined
}

/**
 * Abstract base class for all chat connectors
 * 
 * Provides:
 * - Session management (create, track, cleanup, runtime expiry)
 * - Rate limiting
 * - Event deduplication
 * - Active query guarding
 * - Command handling (/status, /clear, /help)
 * - Standardized logging
 * 
 * Subclasses implement:
 * - start() - Platform-specific initialization
 * - stop() - Platform-specific cleanup
 * - sendMessage() - Platform-specific message sending
 */
export abstract class BaseConnector<TSession extends BaseSession> {
  protected sessionManager: SessionManager<TSession>
  protected rateLimiter: RateLimiter
  protected config: ConnectorConfig
  private eventDeduplicator: EventDeduplicator
  /** Session IDs with an in-flight query -- never evict these */
  protected activeQueries = new Map<string, ActiveQueryHandle & { abort: () => void; aborted: boolean }>()
  private nextActiveQueryId = 0
  private allowedUsers: Set<string>
  private allowedChannels: Set<string>
  private expiryInterval: NodeJS.Timeout | null = null
  private acpConfig: ACPConfig
  private sessionPickerConfig = getConfig().sessionPicker
  private acpSessionStore: ACPSessionStore
  private verboseErrors: boolean
  private pickerProjects = new Map<string, ProjectPickerItem[]>()
  private selectedProjectCwd = new Map<string, string>()
  private pickerSessions = new Map<string, ACPSessionInfo[]>()
  private mirrors = new Map<string, MirrorState>()
  private toolMessagesConfig = getConfig().toolMessages
  private permissionsConfig = getConfig().permissions
  private safeOutputConfig = getConfig().safeOutput
  private permissionBroker: PermissionBroker
  private permissionClients = new Map<string, ACPClient>()
  private permissionExpiryTimer: NodeJS.Timeout | null = null
  
  constructor(config: ConnectorConfig) {
    this.sessionManager = new SessionManager<TSession>()
    this.rateLimiter = new RateLimiter()
    this.config = config
    this.eventDeduplicator = new EventDeduplicator()
    const globalConfig = getConfig()
    this.acpConfig = globalConfig.acp
    this.sessionPickerConfig = globalConfig.sessionPicker
    this.acpSessionStore = new ACPSessionStore(globalConfig.sessionStorePath)
    this.verboseErrors = globalConfig.verboseErrors
    this.toolMessagesConfig = globalConfig.toolMessages
    this.permissionsConfig = globalConfig.permissions
    this.safeOutputConfig = globalConfig.safeOutput
    this.permissionBroker = new PermissionBroker({
      timeoutMs: this.permissionsConfig.timeoutSeconds * 1000,
      authorize: (senderId) => isAllowedId(senderId, this.allowedUsers),
    })
    
    // Apply SESSION_RETENTION_MINS from env if not set in config
    if (this.config.sessionRetentionMins === undefined) {
      this.config.sessionRetentionMins = parseSessionRetentionMins(process.env)
    }

    this.allowedUsers = new Set(this.config.allowedUsers || [])
    this.allowedChannels = new Set(this.config.allowedChannels || [])
  }
  
  /**
   * Get connector name in uppercase for logging
   */
  protected get logPrefix(): string {
    return this.config.connector.toUpperCase()
  }
  
  // ---------------------------------------------------------------------------
  // Abstract methods - must be implemented by subclasses
  // ---------------------------------------------------------------------------
  
  abstract start(): Promise<void>
  abstract stop(): Promise<void>
  abstract sendMessage(id: string, text: string): Promise<void>
  
  // ---------------------------------------------------------------------------
  // Logging - Standardized format
  // ---------------------------------------------------------------------------
  
  protected log(message: string, ...args: any[]): void {
    console.log(`[${this.logPrefix}] ${message}`, ...args)
  }
  
  protected logError(message: string, ...args: any[]): void {
    console.error(`[${this.logPrefix}] ${message}`, ...args)
  }

  /**
   * Build a user-facing error message.
   * When verboseErrors is enabled the original error is appended so the user
   * can see what went wrong; otherwise a generic friendly string is returned.
   */
  protected userErrorMessage(generic: string, err: unknown): string {
    return buildUserErrorMessage(generic, err, this.verboseErrors)
  }

  /**
   * Mask credential shapes in text a connector is about to send.
   *
   * Call this from the connector's own send chokepoint, not from the call sites
   * that reach it: a summary is already redacted field by field, but the final
   * assistant answer is model-authored text that no allowlist has seen.
   */
  protected safeOutboundText(text: string): string {
    return this.safeOutputConfig.redactSecrets ? redactSecrets(text) : text
  }
  
  /**
   * Log startup information
   */
  protected logStartup(): void {
    const storageInfo = getSessionStorageInfo()
    this.log("Starting...")
    console.log(`  Trigger: ${this.config.trigger}`)
    console.log(`  Bot name: ${this.config.botName}`)
    console.log(`  Session storage: ${storageInfo.baseDir}`)
    console.log(`    (${storageInfo.source})`)
    console.log(`  Allowed users: ${Array.from(this.allowedUsers).join(", ") || "(none -- every sender is denied)"}`)
    console.log(`  Allowed channels: ${Array.from(this.allowedChannels).join(", ") || "(none -- every channel is denied)"}`)
    if (this.config.sessionRetentionMins) {
      console.log(`  Session expiry: ${this.config.sessionRetentionMins} min (inactivity)`)
    }
  }

  protected isSessionPickerEnabled(): boolean {
    if (!this.sessionPickerConfig.enabled) return false
    const connectors = this.sessionPickerConfig.connectors || []
    return connectors.length === 0 || connectors.includes(this.config.connector)
  }

  protected isSessionPickerCommandName(name: string): boolean {
    return ["p", "projects", "s", "sessions", "m", "mirror", "r", "reload", "d", "detach"].includes(name)
  }

  protected getMirrorIntervalMs(): number {
    const seconds = Number(this.sessionPickerConfig.mirrorIntervalSeconds) || 60
    return Math.max(10, seconds) * 1000
  }

  protected isUserAllowed(userId: string): boolean {
    const allowed = isAllowedId(userId, this.allowedUsers)
    if (!allowed) {
      this.log(`[IGNORED] Message from non-allowed user: ${userId}`)
    }
    return allowed
  }

  /**
   * The channel id plus whatever human-readable name the connector can supply.
   *
   * A denial is the one message that asks an operator to make a decision - does
   * this channel belong in the allowlist? - and an opaque id answers nothing.
   * A WhatsApp group is a jid like `120363000000000000@g.us`, which appears
   * nowhere in the app, so the log names a channel nobody can identify.
   */
  protected describeChannel(channelId: string): string {
    return channelId
  }

  protected isChannelAllowed(channelId: string): boolean {
    const allowed = isAllowedId(channelId, this.allowedChannels)
    if (!allowed) {
      this.log(`[IGNORED] Message from non-allowed channel: ${this.describeChannel(channelId)}`)
    }
    return allowed
  }
  
  // ---------------------------------------------------------------------------
  // Event Deduplication
  // ---------------------------------------------------------------------------
  
  /**
   * Check if an event has already been processed.
   * Call this before processing any incoming event.
   * The eventId format is platform-specific (e.g., Slack: "channel:ts").
   * @returns true if this event was already seen (skip it), false if new
   */
  protected isDuplicateEvent(eventId: string): boolean {
    const isDup = this.eventDeduplicator.isDuplicate(eventId)
    if (isDup) {
      this.log(`[DEDUP] Skipping duplicate event: ${eventId}`)
    }
    return isDup
  }
  
  // ---------------------------------------------------------------------------
  // Active Query Guard
  // ---------------------------------------------------------------------------
  
  /**
   * Check if a session has an in-flight query.
   */
  protected isQueryActive(sessionId: string): boolean {
    return this.activeQueries.has(sessionId)
  }
  
  /**
   * Mark a session as having an active query.
   * @param sessionId Session ID
   * @param abortFn Optional callback to abort the query
   */
  protected markQueryActive(sessionId: string, abortFn: () => void = () => {}): ActiveQueryHandle {
    const active = {
      sessionId,
      id: ++this.nextActiveQueryId,
      aborted: false,
      abort: abortFn,
    }
    this.activeQueries.set(sessionId, active)
    return active
  }
  
  /**
   * Mark a session query as complete.
   * Pass the handle returned by markQueryActive() to avoid a stale query clearing
   * a newer active query for the same session.
   */
  protected markQueryDone(sessionId: string, handle?: ActiveQueryHandle): void {
    if (!handle) {
      this.activeQueries.delete(sessionId)
      return
    }

    const current = this.activeQueries.get(sessionId)
    if (current?.id === handle.id) {
      this.activeQueries.delete(sessionId)
    }
  }

  /**
   * Check whether a query handle was intentionally aborted.
   */
  protected wasQueryAborted(handle: ActiveQueryHandle): boolean {
    return handle.aborted
  }

  /**
   * Abort an active query for the given session.
   */
  protected abortQuery(sessionId: string): boolean {
    const active = this.activeQueries.get(sessionId)
    if (!active) return false

    active.aborted = true
    try {
      active.abort()
    } catch (err) {
      this.logError(`[ABORT] Failed to abort active query for ${sessionId}:`, err)
    } finally {
      const current = this.activeQueries.get(sessionId)
      if (current?.id === active.id) {
        this.activeQueries.delete(sessionId)
      }
    }

    return true
  }
  
  // ---------------------------------------------------------------------------
  // Session Management - Standardized
  // ---------------------------------------------------------------------------
  
  /**
   * Get or create a session for the given identifier
   * @param id - Channel/room/chat identifier
   * @param createSessionData - Function to create session-specific data
   */
  protected async getOrCreateSession(
    id: string,
    createSessionData: (client: ACPClient) => TSession
  ): Promise<TSession | null> {
    let session = this.sessionManager.get(id)
    
    if (!session) {
      const workspace = this.resolveWorkspace(id)
      if (workspace.pinned && !fs.existsSync(workspace.dir)) {
        this.logError(`Pinned ACP workspace does not exist: ${workspace.dir}`)
        return null
      }
      if (!workspace.pinned) {
        ensureSessionDir(workspace.dir)
        copyOpenCodeConfig(workspace.dir)  // Apply security permissions
        copyACPProfile(workspace.dir, this.acpConfig.profileDir)
      }
      const canonicalDir = fs.realpathSync(workspace.dir)
      const client = this.createACPClient(canonicalDir)
      
      try {
        await client.connect()
        const stored = this.acpSessionStore.get(this.config.connector, id)
        const canResume = stored &&
          stored.cwd === canonicalDir &&
          stored.backendId === this.backendId

        if (canResume) {
          try {
            await client.resumeSession(stored.sessionId)
            this.log(`Resumed session: ${id}`)
          } catch (err) {
            this.logError(`Failed to resume session ${id}; creating a fresh session:`, err)
            await client.createSession()
          }
        } else {
          await client.createSession()
        }

        await this.acpSessionStore.set({
          connector: this.config.connector,
          threadId: id,
          sessionId: client.currentSessionId!,
          cwd: canonicalDir,
          backendId: this.backendId,
          updatedAt: new Date().toISOString(),
        })
        session = createSessionData(client)
        this.sessionManager.set(id, session)
        this.log(`Created session: ${id}`)
        console.log(`  Directory: ${canonicalDir}${workspace.pinned ? " (pinned)" : ""}`)
      } catch (err) {
        this.logError(`Failed to create session:`, err)
        return null
      }
    }
    
    return session
  }

  /**
   * Check whether this connector/thread has a persisted ACP session mapping.
   * This allows connectors to recognize sessions before recreating their
   * in-memory ACP client after a process restart.
   */
  protected hasPersistedACPSession(id: string): boolean {
    return this.acpSessionStore.get(this.config.connector, id) !== null
  }

  /**
   * Discard the current ACP client and persisted backend session mapping.
   * The workspace is deliberately preserved because it may contain uploads
   * and user-owned files.
   */
  protected async invalidateACPSession(id: string): Promise<void> {
    const existing = this.sessionManager.get(id)
    await this.acpSessionStore.delete(this.config.connector, id)
    this.sessionManager.delete(id)
    if (existing) {
      try {
        await existing.client.disconnect()
      } catch (err) {
        this.logError(`Failed to disconnect invalidated ACP session ${id}:`, err)
      }
    }
  }

  /**
   * Discard the current ACP client and persisted backend session mapping, then
   * create a new ACP process and session for the same connector thread.
   */
  protected async recreateACPSession(
    id: string,
    createSessionData: (client: ACPClient) => TSession,
  ): Promise<TSession | null> {
    await this.invalidateACPSession(id)
    return this.getOrCreateSession(id, createSessionData)
  }
  
  private get backendId(): string {
    if (this.acpConfig.backendId) return this.acpConfig.backendId
    const commandIdentity = JSON.stringify([
      this.acpConfig.command,
      ...this.acpConfig.args,
    ])
    return `command-sha256:${createHash("sha256").update(commandIdentity).digest("hex")}`
  }

  private resolveWorkspace(id: string) {
    return resolveSessionWorkspace(this.config.connector, id, this.acpConfig.sessionCwd)
  }

  private createACPClient(cwd: string): ACPClient {
    return new ACPClient({
      cwd,
      command: this.acpConfig.command,
      args: this.acpConfig.args,
      interactivePermissions: this.permissionsConfig.interactive,
      permissionTimeoutMs: this.permissionsConfig.timeoutSeconds * 1000 + PERMISSION_HOLD_GRACE_MS,
    })
  }

  // ---------------------------------------------------------------------------
  // Permission round trip
  // ---------------------------------------------------------------------------

  /**
   * Post a held permission request into a thread and arm its expiry.
   *
   * The title is agent-supplied and derived from tool input -- a URL, a path,
   * a command -- so it is summarized, redacted and bounded exactly like any
   * other tool detail rather than echoed.
   */
  protected async presentPermissionRequest(
    threadId: string,
    request: PermissionRequest,
    client: ACPClient,
    sendFn: (text: string) => Promise<void>,
  ): Promise<void> {
    const pending = this.permissionBroker.create({
      requestId: request.requestId,
      title: this.describePermission(request),
      threadId,
      options: request.options,
    })

    this.permissionClients.set(pending.token, client)
    this.armPermissionExpiry(sendFn)
    await sendFn(formatPermissionPrompt(pending, this.config.trigger))
  }

  private describePermission(request: PermissionRequest): string {
    const summary = summarizeToolCall(
      request.toolName || request.permission,
      request.input,
      resolveToolSummaries(this.toolMessagesConfig),
    )
    const title = redactSecrets(String(request.permission || "unknown")).replace(/\s+/g, " ").trim()
    const bounded = title.length > PERMISSION_TITLE_MAX_LENGTH
      ? `${title.slice(0, PERMISSION_TITLE_MAX_LENGTH - 3)}...`
      : title
    return summary ? `${bounded} -- ${summary}` : bounded
  }

  /**
   * Classify an inbound message as a permission reply.
   *
   * Returns true when the message was consumed, so the caller must not also
   * forward it to the agent as a prompt.
   */
  protected async handlePermissionReply(
    threadId: string,
    senderId: string,
    text: string,
    sendFn: (text: string) => Promise<void>,
  ): Promise<boolean> {
    const outcome = this.permissionBroker.resolveReply({ text, senderId, threadId })

    switch (outcome.status) {
      case "no_token":
        return false

      case "accepted": {
        const client = this.permissionClients.get(outcome.pending.token)
        this.permissionClients.delete(outcome.pending.token)
        const delivered = client?.respondToPermission(outcome.pending.requestId, outcome.optionId)
        const choice = outcome.pending.options.find((option) => option.optionId === outcome.optionId)
        await sendFn(delivered
          ? `Permission ${outcome.pending.token}: ${choice?.name || outcome.optionId}.`
          : `Permission ${outcome.pending.token} could not be delivered; the request is no longer open.`)
        return true
      }

      case "unknown_token":
        await sendFn("That permission request is no longer open.")
        return true

      case "expired":
        await sendFn(`Permission ${outcome.pending.token} already expired and was denied.`)
        return true

      case "wrong_thread":
        await sendFn(`Permission ${outcome.pending.token} must be answered in the thread that asked for it.`)
        return true

      case "wrong_sender":
        this.log(`[PERMISSION] Reply to ${outcome.pending.token} from non-allowed sender: ${senderId}`)
        return true

      case "ambiguous":
        await sendFn(
          `Permission ${outcome.pending.token} needs an option number, e.g. ` +
          `"${this.config.trigger} ${outcome.pending.token} 1". Nothing was approved.`,
        )
        return true
    }
  }

  /**
   * Answer every request whose window closed with its reject option.
   *
   * The agent is blocked on the held JSON-RPC request, so an unanswered
   * request must be refused rather than abandoned.
   */
  private armPermissionExpiry(sendFn: (text: string) => Promise<void>): void {
    if (this.permissionExpiryTimer) return

    this.permissionExpiryTimer = setInterval(() => {
      const expired = this.permissionBroker.takeExpired()
      if (this.permissionBroker.size === 0) this.disarmPermissionExpiry()

      for (const pending of expired) {
        const client = this.permissionClients.get(pending.token)
        this.permissionClients.delete(pending.token)
        client?.respondToPermission(pending.requestId, resolveRejectOption(pending.options))
        this.log(`[PERMISSION] ${pending.token} expired without a reply; denied`)
        void sendFn(`Permission ${pending.token} expired without a reply and was denied.`)
          .catch((err) => this.logError("Failed to announce permission expiry:", err))
      }
    }, PERMISSION_SWEEP_INTERVAL_MS)
    // A request nobody is around to answer must not keep the process alive.
    this.permissionExpiryTimer.unref?.()
  }

  private disarmPermissionExpiry(): void {
    if (this.permissionExpiryTimer) {
      clearInterval(this.permissionExpiryTimer)
      this.permissionExpiryTimer = null
    }
  }

  /**
   * Create a new session object with default values
   * Helper for subclasses to use with getOrCreateSession
   */
  protected createBaseSession(client: ACPClient): BaseSession {
    return {
      client,
      createdAt: new Date(),
      messageCount: 0,
      lastActivity: new Date(),
      inputChars: 0,
      outputChars: 0,
    }
  }

  /**
   * Create a connector-specific session object for sessions opened by bridge
   * commands such as /s <n>. Connectors with extra per-session fields should
   * override this method.
   */
  protected createManagedSession(client: ACPClient): TSession {
    return this.createBaseSession(client) as TSession
  }
  
  /**
   * Cleanup old session directories on startup (days-based).
   * For runtime expiry (minutes-based), use startSessionExpiryLoop().
   */
  protected async cleanupSessions(): Promise<void> {
    this.log("Cleaning up old sessions...")
    const cleaned = cleanupOldSessions(
      this.config.connector,
      this.config.sessionRetentionDays
    )
    if (cleaned > 0) {
      console.log(`  Cleaned ${cleaned} session(s) older than ${this.config.sessionRetentionDays} days`)
    } else {
      console.log(`  No old sessions to clean`)
    }
  }
  
  /**
   * Disconnect all sessions on shutdown
   */
  protected async disconnectAllSessions(): Promise<void> {
    this.stopSessionExpiryLoop()
    this.disarmPermissionExpiry()
    for (const pending of this.permissionBroker.takeAll()) {
      const client = this.permissionClients.get(pending.token)
      this.permissionClients.delete(pending.token)
      client?.respondToPermission(pending.requestId, resolveRejectOption(pending.options))
    }
    for (const [id, session] of this.sessionManager.sessions) {
      try {
        await session.client.disconnect()
        this.log(`Disconnected session: ${id}`)
      } catch (err) {
        this.logError(`Failed to disconnect session ${id}:`, err)
      }
    }
    this.sessionManager.clear()
    this.activeQueries.clear()
  }
  
  // ---------------------------------------------------------------------------
  // Session Expiry - Runtime background sweep
  // ---------------------------------------------------------------------------
  
  /**
   * Start the background session expiry loop.
   * Call this from start() after the connector is ready.
   * Only runs if sessionRetentionMins is configured.
   */
  protected startSessionExpiryLoop(): void {
    if (this.expiryInterval) return
    if (!this.config.sessionRetentionMins) return
    
    this.expiryInterval = setInterval(() => {
      this.expireStaleSessions().catch((err) => {
        this.logError("[SESSION_EXPIRY] Sweep failed:", err)
      })
    }, EXPIRY_SWEEP_INTERVAL_MS)
  }
  
  /**
   * Stop the background session expiry loop.
   * Called automatically by disconnectAllSessions().
   */
  protected stopSessionExpiryLoop(): void {
    if (this.expiryInterval) {
      clearInterval(this.expiryInterval)
      this.expiryInterval = null
    }
  }
  
  /**
   * Expire sessions that have been inactive longer than sessionRetentionMins.
   * Sessions with active in-flight queries are never evicted.
   */
  private async expireStaleSessions(): Promise<void> {
    const retentionMins = this.config.sessionRetentionMins
    if (!retentionMins) return
    
    const now = Date.now()
    const staleIds: string[] = []
    
    for (const [id, session] of this.sessionManager.sessions) {
      if (this.activeQueries.has(id)) continue
      const inactiveMins = (now - session.lastActivity.getTime()) / 60_000
      if (inactiveMins >= retentionMins) staleIds.push(id)
    }
    
    for (const id of staleIds) {
      try {
        await this.invalidateACPSession(id)
        this.deleteSessionCacheDir(id)
        this.log(`[SESSION_EXPIRY] ${id} expired after ${retentionMins}m inactivity`)
      } catch (err) {
        this.logError(`[SESSION_EXPIRY] Failed to expire ${id}:`, err)
      }
    }
  }
  
  /**
   * Delete the on-disk session cache directory for an expired session.
   */
  private deleteSessionCacheDir(id: string): void {
    const workspace = this.resolveWorkspace(id)
    // A pinned workspace is the operator's own project, not a cache this
    // bridge created. Expiry must never recursively delete it.
    if (workspace.pinned) return

    try {
      if (fs.existsSync(workspace.dir)) {
        fs.rmSync(workspace.dir, { recursive: true, force: true })
      }
    } catch (err) {
      this.logError(`[SESSION_EXPIRY] Failed to clean cache for ${id}:`, err)
    }
  }
  
  // ---------------------------------------------------------------------------
  // Rate Limiting - Standardized
  // ---------------------------------------------------------------------------
  
  /**
   * Check if user is rate limited
   */
  protected checkRateLimit(userId: string): boolean {
    const allowed = this.rateLimiter.check(userId, this.config.rateLimitSeconds)
    if (!allowed) {
      this.log(`Rate limited: ${userId}`)
    }
    return allowed
  }
  
  // ---------------------------------------------------------------------------
  // Command Handling - Standardized
  // ---------------------------------------------------------------------------
  
  /**
   * Handle a command (starts with /)
   * @param id - Channel/room/chat identifier
   * @param command - The command string (e.g., "/status")
   * @param sendFn - Function to send response
   * @param options - Optional: OpenCode commands and forward callback
   * @returns true if command was handled, false if it should be forwarded to OpenCode
   */
  protected async handleCommand(
    id: string,
    command: string,
    sendFn: (text: string) => Promise<void>,
    options?: {
      openCodeCommands?: OpenCodeCommand[]
      forwardToOpenCode?: (command: string) => Promise<void>
    }
  ): Promise<boolean> {
    const original = command.trim()
    const cmd = original.toLowerCase()
    const cmdName = cmd.replace(/^\//, "").split(" ")[0]  // Extract command name without /
    const args = original.split(/\s+/).slice(1)
    
    // Bridge-local commands
    if (cmd === "/status") {
      return await this.handleStatusCommand(id, sendFn)
    }
    
    if (cmd === "/clear" || cmd === "/reset") {
      return await this.handleClearCommand(id, sendFn)
    }
    
    if (cmd === "/help" || cmd === "/h") {
      return await this.handleHelpCommand(sendFn, options?.openCodeCommands)
    }

    if (this.isSessionPickerCommandName(cmdName) && !this.isSessionPickerEnabled()) {
      await sendFn(CommandHandler.formatUnknownCommandMessage(command))
      return true
    }

    if (cmdName === "p" || cmdName === "projects") {
      return await this.handleProjectCommand(id, args, sendFn)
    }

    if (cmdName === "s" || cmdName === "sessions") {
      return await this.handleSessionPickerCommand(id, args, sendFn)
    }

    if (cmdName === "m" || cmdName === "mirror") {
      return await this.handleMirrorCommand(id, args, sendFn)
    }

    if (cmdName === "r" || cmdName === "reload") {
      return await this.handleReloadCommand(id, sendFn)
    }

    if (cmdName === "d" || cmdName === "detach") {
      return await this.handleDetachCommand(id, sendFn)
    }
    
    // Check if this is an OpenCode command
    const openCodeCommands = options?.openCodeCommands || []
    const isOpenCodeCmd = openCodeCommands.some(c => c.name === cmdName)
    
    if (isOpenCodeCmd && options?.forwardToOpenCode) {
      // Forward to OpenCode - return false to indicate caller should process as prompt
      await options.forwardToOpenCode(command)
      return true
    }
    
    await sendFn(CommandHandler.formatUnknownCommandMessage(command))
    return true
  }
  
  private async handleProjectCommand(
    id: string,
    args: string[],
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    if (args.length > 0) {
      const index = Number.parseInt(args[0], 10)
      const projects = this.pickerProjects.get(id) || []
      if (!Number.isFinite(index) || index < 1 || index > projects.length) {
        await sendFn("Unknown project number. Run /p again.")
        return true
      }

      const project = projects[index - 1]
      this.selectedProjectCwd.set(id, project.cwd)
      this.pickerSessions.delete(id)
      const sessionsMessage = await this.buildSessionListMessage(id, project.cwd)
      await sendFn(
        `Selected project: ${project.name}\n` +
        `${project.cwd}\n\n` +
        sessionsMessage
      )
      return true
    }

    const client = this.createACPClient(process.cwd())
    try {
      await client.connect()
      const sessions = await client.listAllSessions()
      if (sessions.length === 0) {
        await sendFn("No saved ACP sessions found.")
        return true
      }

      const grouped = new Map<string, number>()
      for (const session of sessions) {
        if (!session.cwd) continue
        grouped.set(session.cwd, (grouped.get(session.cwd) || 0) + 1)
      }

      const projects = Array.from(grouped.entries())
        .map(([cwd, sessionCount]) => ({
          cwd,
          name: path.basename(cwd) || cwd,
          sessionCount,
        }))
        .sort((a, b) => b.sessionCount - a.sessionCount || a.cwd.localeCompare(b.cwd))
        .slice(0, 20)

      this.pickerProjects.set(id, projects)

      let message = "Projects:\n"
      projects.forEach((project, i) => {
        message += `${i + 1}. ${project.name}\n`
        message += `   ${project.cwd}\n`
        message += `   ${project.sessionCount} session${project.sessionCount === 1 ? "" : "s"}\n`
      })
      message += "\nUse /p <number> to select a project."
      await sendFn(message)
    } catch (err) {
      this.logError("Failed to list ACP projects:", err)
      await sendFn(this.userErrorMessage("Could not list saved ACP sessions.", err))
    } finally {
      try {
        await client.disconnect()
      } catch {}
    }

    return true
  }

  private async handleSessionPickerCommand(
    id: string,
    args: string[],
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    const selectedCwd = this.selectedProjectCwd.get(id)
    if (!selectedCwd) {
      await sendFn("No project selected. Run /p first, then /p <number>.")
      return true
    }

    if (args.length > 0) {
      if (this.isQueryActive(id)) {
        await sendFn("A request is still running in this thread. Wait for it to finish, then run /s <number> again.")
        return true
      }

      const index = Number.parseInt(args[0], 10)
      const sessions = this.pickerSessions.get(id) || []
      if (!Number.isFinite(index) || index < 1 || index > sessions.length) {
        await sendFn("Unknown session number. Run /s again.")
        return true
      }

      const selected = sessions[index - 1]
      const existing = this.sessionManager.get(id)
      const stored = this.acpSessionStore.get(this.config.connector, id)
      const isReloadingCurrent = stored?.sessionId === selected.sessionId && stored?.cwd === selected.cwd

      if (existing && isReloadingCurrent) {
        return await this.handleReloadCommand(id, sendFn)
      }

      const client = this.createACPClient(selected.cwd)
      try {
        await client.connect()
        let history: LoadedSessionHistoryItem[] = []
        let historyUnavailable = false
        try {
          history = await client.loadSession(selected.sessionId)
        } catch (err) {
          this.logError(`Failed to load selected session history ${id}; trying resume:`, err)
          historyUnavailable = true
          await client.resumeSession(selected.sessionId)
        }

        if (existing) {
          try {
            await existing.client.closeSession()
          } catch (err) {
            this.logError(`Failed to close previous session ${id}:`, err)
          }
          try {
            await existing.client.disconnect()
          } catch {}
          this.sessionManager.delete(id)
        }

        const session = this.createManagedSession(client)
        this.sessionManager.set(id, session)
        await this.acpSessionStore.set({
          connector: this.config.connector,
          threadId: id,
          sessionId: selected.sessionId,
          cwd: selected.cwd,
          backendId: this.backendId,
          updatedAt: new Date().toISOString(),
        })

        await sendFn(this.formatSessionAttachedMessage(selected, history, historyUnavailable))
      } catch (err) {
        this.logError(`Failed to load selected session ${id}:`, err)
        try {
          await client.disconnect()
        } catch {}
        const keepCurrent = existing ? " Keeping the current session attached." : ""
        await sendFn(this.userErrorMessage(`Could not load selected session.${keepCurrent}`, err))
      }

      return true
    }

    await sendFn(await this.buildSessionListMessage(id, selectedCwd))
    return true
  }

  private async buildSessionListMessage(id: string, selectedCwd: string): Promise<string> {
    const client = this.createACPClient(selectedCwd)
    try {
      await client.connect()
      const sessions = (await client.listAllSessions(selectedCwd)).slice(0, 20)
      if (sessions.length === 0) {
        return "No saved sessions found for this project."
      }

      this.pickerSessions.set(id, sessions)
      const name = path.basename(selectedCwd) || selectedCwd
      let message = `Sessions in ${name}:\n`
      sessions.forEach((session, i) => {
        message += `${i + 1}. ${session.title || "(untitled session)"}\n`
        message += `   ${session.sessionId.slice(0, 8)}\n`
      })
      message += "\nUse /s <number> to switch interactively."
      message += "\nUse /m <number> to mirror read-only."
      return message
    } catch (err) {
      this.logError("Failed to list ACP sessions:", err)
      return this.userErrorMessage("Could not list saved sessions for this project.", err)
    } finally {
      try {
        await client.disconnect()
      } catch {}
    }
  }

  private async handleMirrorCommand(
    id: string,
    args: string[],
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    if (args.length === 0) {
      if (this.stopMirror(id)) {
        await sendFn("Mirror mode stopped.")
      } else {
        await sendFn("Mirror mode is not running.")
      }
      return true
    }

    const selectedCwd = this.selectedProjectCwd.get(id)
    if (!selectedCwd) {
      await sendFn("No project selected. Run /p first, then /p <number>.")
      return true
    }

    const index = Number.parseInt(args[0], 10)
    const sessions = this.pickerSessions.get(id) || []
    if (!Number.isFinite(index) || index < 1 || index > sessions.length) {
      await sendFn("Unknown session number. Run /s again.")
      return true
    }

    const session = sessions[index - 1]
    const snapshot = await this.loadMirrorSnapshot(session)
    if (!snapshot.ok) {
      await sendFn("Mirror mode not started: session history could not be loaded.")
      return true
    }

    this.stopMirror(id)
    const state: MirrorState = {
      session,
      timer: setInterval(() => {
        this.pollMirror(id).catch((err) => this.logError(`Mirror poll failed for ${id}:`, err))
      }, this.getMirrorIntervalMs()),
      lastFingerprint: snapshot.fingerprint,
      sendFn,
      busy: false,
    }
    this.mirrors.set(id, state)

    await sendFn(
      `Mirror mode on: ${session.title || "(untitled session)"}\n` +
      `Project: ${session.cwd}\n` +
      `Session: ${session.sessionId}\n\n` +
      `Checking every ${Math.round(this.getMirrorIntervalMs() / 1000)}s. Any message here stops mirroring.\n\n` +
      this.formatMirrorTail(snapshot.history)
    )
    return true
  }

  protected async stopMirrorForUserActivity(
    id: string,
    text: string,
    sendFn: (text: string) => Promise<void>
  ): Promise<void> {
    const trimmed = text.trim().toLowerCase()
    if (!this.mirrors.has(id)) return
    if (trimmed === "/m" || trimmed === "/mirror") return
    if (this.stopMirror(id)) {
      await sendFn("Mirror mode stopped.")
    }
  }

  private stopMirror(id: string): boolean {
    const state = this.mirrors.get(id)
    if (!state) return false
    clearInterval(state.timer)
    this.mirrors.delete(id)
    return true
  }

  private async pollMirror(id: string): Promise<void> {
    const state = this.mirrors.get(id)
    if (!state || state.busy) return
    state.busy = true
    try {
      const snapshot = await this.loadMirrorSnapshot(state.session)
      if (!snapshot.ok) {
        this.stopMirror(id)
        await state.sendFn("Mirror mode stopped: session history could not be loaded.")
        return
      }
      if (snapshot.fingerprint === state.lastFingerprint) return
      const previous = state.lastFingerprint
      state.lastFingerprint = snapshot.fingerprint
      const update = this.formatMirrorUpdate(snapshot.history)
      if (update && previous) await state.sendFn(update)
    } finally {
      state.busy = false
    }
  }

  private async loadMirrorSnapshot(session: ACPSessionInfo): Promise<{ ok: true; fingerprint: string; history: LoadedSessionHistoryItem[] } | { ok: false }> {
    const client = this.createACPClient(session.cwd)
    try {
      await client.connect()
      const history = await client.loadSession(session.sessionId)
      const normalized = history
        .map(item => `${item.role}:${item.content.trim()}`)
        .filter(Boolean)
        .join("\n---\n")
      return { ok: true, fingerprint: createHash("sha256").update(normalized).digest("hex"), history }
    } catch (err) {
      this.logError(`Failed to load mirror snapshot for ${session.sessionId}:`, err)
      return { ok: false }
    } finally {
      try {
        await client.closeSession()
      } catch {}
      try {
        await client.disconnect()
      } catch {}
    }
  }

  private formatMirrorUpdate(history: LoadedSessionHistoryItem[]): string {
    return this.formatMirrorHistoryBlock("Mirror update", history)
  }

  private formatMirrorTail(history: LoadedSessionHistoryItem[]): string {
    return this.formatMirrorHistoryBlock("Current tail", history) || "Current tail: no conversational messages found."
  }

  private formatMirrorHistoryBlock(title: string, history: LoadedSessionHistoryItem[]): string {
    const useful = this.compactMirrorHistory(history).slice(-6)

    if (useful.length === 0) return ""

    let message = `${title}:\n`
    for (const item of useful) {
      const label = item.role === "user" ? "User" : item.role === "assistant" ? "Assistant" : "Tool"
      message += `${label}: ${this.truncateMirrorItem(item.role, item.content)}\n`
    }
    if (message.length > 4000) message = message.slice(0, 3900).trimEnd() + "\n... [mirror update truncated]"
    return message
  }

  private async handleReloadCommand(
    id: string,
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    if (this.isQueryActive(id)) {
      await sendFn("A request is still running in this thread. Wait for it to finish, then run /r again.")
      return true
    }

    const stored = this.acpSessionStore.get(this.config.connector, id)
    if (!stored || stored.backendId !== this.backendId) {
      await sendFn("No saved session is bound to this thread. Use /p and /s <number> first.")
      return true
    }

    const existing = this.sessionManager.get(id)
    if (existing) {
      try {
        await existing.client.closeSession()
      } catch (err) {
        this.logError(`Failed to close current session before reload ${id}:`, err)
      }
      try {
        await existing.client.disconnect()
      } catch {}
      this.sessionManager.delete(id)
    }

    const client = this.createACPClient(stored.cwd)
    try {
      await client.connect()
      let history: LoadedSessionHistoryItem[] = []
      let historyUnavailable = false
      try {
        history = await client.loadSession(stored.sessionId)
      } catch (err) {
        this.logError(`Failed to reload session history ${id}; trying resume:`, err)
        historyUnavailable = true
        await client.resumeSession(stored.sessionId)
      }

      const session = this.createManagedSession(client)
      this.sessionManager.set(id, session)
      await this.acpSessionStore.set({
        ...stored,
        updatedAt: new Date().toISOString(),
      })
      await sendFn(this.formatSessionAttachedMessage({
        sessionId: stored.sessionId,
        cwd: stored.cwd,
        title: "current session",
      }, history, historyUnavailable).replace(/^Attached to session:/, "Reloaded session:"))
    } catch (err) {
      this.logError(`Failed to reload current session ${id}:`, err)
      try {
        await client.disconnect()
      } catch {}
      await sendFn(this.userErrorMessage("Could not reload current session.", err))
    }

    return true
  }

  private async handleDetachCommand(
    id: string,
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    if (this.isQueryActive(id)) {
      await sendFn("A request is still running in this thread. Wait for it to finish, then run /d again.")
      return true
    }

    const session = this.sessionManager.get(id)
    if (!session) {
      await this.acpSessionStore.delete(this.config.connector, id)
      await sendFn("No active session.")
      return true
    }

    try {
      await session.client.closeSession()
    } catch (err) {
      this.logError(`Failed to close session ${id}:`, err)
    }
    try {
      await session.client.disconnect()
    } catch {}

    this.sessionManager.delete(id)
    await this.acpSessionStore.delete(this.config.connector, id)
    await sendFn("Detached from current session. The saved backend session was not deleted.")
    return true
  }

  private formatSessionAttachedMessage(session: ACPSessionInfo, history: LoadedSessionHistoryItem[], historyUnavailable = false): string {
    const title = session.title || "(untitled session)"
    let message = `Attached to session: ${title}\n`
    message += `Project: ${session.cwd}\n`
    message += `Session: ${session.sessionId}\n\n`

    const useful = history
      .map(item => ({ role: item.role, content: item.content.trim() }))
      .filter(item => item.content.length > 0)
      .slice(-6)

    if (historyUnavailable) {
      message += "Recent history: unavailable for this session; attached without replay."
      return message
    }

    if (useful.length === 0) {
      message += "Recent history: no conversational messages found."
      return message
    }

    message += "Recent history:\n"
    for (const item of useful) {
      const label = item.role === "user" ? "User" : item.role === "assistant" ? "Assistant" : "Tool"
      const text = this.truncateHistoryItem(item.content)
      message += `${label}: ${text}\n`
    }

    if (message.length > 6000) {
      message = message.slice(0, 5900).trimEnd() + "\n... [history truncated]"
    }
    return message
  }

  private compactMirrorHistory(history: LoadedSessionHistoryItem[]): { role: string; content: string }[] {
    const output: { role: string; content: string }[] = []
    const toolGroups = new Map<string, { name: string; target: string; count: number; result: string }>()

    const flushTools = () => {
      for (const group of toolGroups.values()) {
        const count = group.count > 1 ? ` x${group.count}` : ""
        const target = group.target ? ` ${group.target}` : ""
        const result = group.result ? ` -> ${group.result}` : ""
        output.push({ role: "tool", content: `${group.name}${target}${count}${result}` })
      }
      toolGroups.clear()
    }

    for (const item of history) {
      const content = item.content.trim()
      if (!content) continue
      if (item.role !== "tool") {
        flushTools()
        output.push({ role: item.role, content })
        continue
      }

      const name = item.toolName || content.split(/\s+/, 1)[0] || "tool"
      const target = this.toolTargetFromArgs(item.toolArgs) || this.toolTargetFromContent(content)
      const key = `${name}\0${target}`
      const current = toolGroups.get(key) || { name, target, count: 0, result: "" }
      current.count++
      if (item.toolResult) current.result = this.firstMirrorResultLine(item.toolResult)
      else current.result = this.firstMirrorResultLine(content)
      toolGroups.set(key, current)
    }
    flushTools()
    return output
  }

  private toolTargetFromArgs(args: any): string {
    if (!args || typeof args !== "object") return ""
    const target = args.path || args.filepath || args.filePath || args.directory || args.dir || args.command
    return target ? String(target) : ""
  }

  private toolTargetFromContent(content: string): string {
    const match = content.match(/\b(?:[\w.-]+\/)*[\w.-]+\.(?:txt|md|json|toml|ts|js|py|rs|sh|yaml|yml)\b/)
    return match?.[0] || ""
  }

  private firstMirrorResultLine(text: string): string {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (["outcome:", "status:", "output_incomplete:", "output_error:", "termination_error:", "containment:", "residual_descendants:", "stdout:", "stderr:"].some(prefix => trimmed.startsWith(prefix))) continue
      return trimmed.length > 160 ? trimmed.slice(0, 157) + "..." : trimmed
    }
    return ""
  }

  private truncateHistoryItem(text: string): string {
    const singleLine = text.replace(/\s+/g, " ").trim()
    if (singleLine.length <= 800) return singleLine
    return singleLine.slice(0, 797) + "..."
  }

  private truncateMirrorItem(role: string, text: string): string {
    const singleLine = text.replace(/\s+/g, " ").trim()
    const max = role === "tool" ? 500 : 800
    if (singleLine.length <= max) return singleLine
    return singleLine.slice(0, max - 3) + "..."
  }

  private async handleStatusCommand(
    id: string,
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    const session = this.sessionManager.get(id)
    if (session) {
      const stats = this.sessionManager.getStats(id)!
      const message = CommandHandler.formatStatusMessage(session.messageCount, stats)
      await sendFn(message)
    } else {
      await sendFn(CommandHandler.formatNoSessionMessage())
    }
    return true
  }
  
  private async handleClearCommand(
    id: string,
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    const session = this.sessionManager.get(id)
    const stored = this.acpSessionStore.get(this.config.connector, id)

    if (session) {
      try {
        await session.client.deleteSession()
      } catch (err) {
        this.logError(`Failed to delete backend session ${id}:`, err)
      }
      try {
        await session.client.disconnect()
      } catch {}
      this.sessionManager.delete(id)
      await this.acpSessionStore.delete(this.config.connector, id)
      await sendFn(CommandHandler.formatSessionClearedMessage())
    } else if (stored) {
      const workspace = this.resolveWorkspace(id)
      if (workspace.pinned && !fs.existsSync(workspace.dir)) {
        await this.acpSessionStore.delete(this.config.connector, id)
        await sendFn(CommandHandler.formatSessionClearedMessage())
        return true
      }
      if (!workspace.pinned) {
        ensureSessionDir(workspace.dir)
        copyOpenCodeConfig(workspace.dir)
        copyACPProfile(workspace.dir, this.acpConfig.profileDir)
      }
      const expectedDir = fs.realpathSync(workspace.dir)
      if (stored.cwd === expectedDir && stored.backendId === this.backendId) {
        const client = this.createACPClient(expectedDir)
        try {
          await client.connect()
          await client.resumeSession(stored.sessionId)
          await client.deleteSession()
        } catch (err) {
          this.logError(`Failed to delete persisted backend session ${id}:`, err)
        } finally {
          try {
            await client.disconnect()
          } catch {}
        }
      }
      await this.acpSessionStore.delete(this.config.connector, id)
      await sendFn(CommandHandler.formatSessionClearedMessage())
    } else {
      await sendFn(CommandHandler.formatNoSessionMessage())
    }
    return true
  }
  
  private async handleHelpCommand(
    sendFn: (text: string) => Promise<void>,
    openCodeCommands?: OpenCodeCommand[]
  ): Promise<boolean> {
    const message = CommandHandler.formatHelpMessage(
      this.config.trigger,
      this.config.botName,
      openCodeCommands,
      this.isSessionPickerEnabled()
    )
    await sendFn(message)
    return true
  }
}
