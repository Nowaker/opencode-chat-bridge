/**
 * Configuration loader for chat-bridge
 * 
 * Loads settings from chat-bridge.json with environment variable substitution.
 */

import * as fs from "fs"
import * as path from "path"

export interface MatrixConfig {
  enabled: boolean
  homeserver: string
  userId: string
  accessToken: string
  password: string  // For password-based login (auto-generates tokens)
  deviceId: string
  encryption: {
    enabled: boolean
    storePath: string
  }
  autoJoin: boolean
  triggerPatterns: string[]
  ignoreRooms: string[]
  ignoreUsers: string[]
  allowedUsers: string[]
  /** Fail-closed room allowlist. Stable room IDs only ("!room:server").
   *  Empty denies every room. */
  allowedRooms: string[]
  formatHtml: boolean
  threadIsolation: boolean  // true: per-thread sessions + thread replies, false: per-room
  respondToThreadReplies: boolean // Forward plain replies in active threads
  /** Write inbound message bodies to stdout. The connector must decrypt an
   *  E2EE room to work at all, so without this the plaintext lands in the
   *  process log that encryption exists to avoid. */
  logInboundMessages: boolean
}

export interface MattermostConfig {
  enabled: boolean
  url: string            // Mattermost server URL (e.g., https://mattermost.example.com)
  token: string          // Bot access token
  teamName: string       // Team to connect to (URL slug, e.g., "myteam")
  respondToMentions: boolean // Respond when @mentioned (in addition to trigger)
  respondToThreadReplies: boolean // Forward plain replies in active threads
  ignoreChannels: string[] // Channel IDs to ignore
  ignoreUsers: string[]    // User IDs to ignore
  allowedUsers: string[]
  threadIsolation: boolean // true: per-thread sessions + thread replies, false: per-channel
}

export interface WhatsAppConfig {
  enabled: boolean
  authFolder: string
  allowedUsers: string[]
  /** Fail-closed group allowlist. Stable group JIDs only ("...@g.us").
   *  Empty denies every chat. */
  allowedGroups: string[]
  respondToOthers: boolean
  /** Upload files whose paths appear in tool results or model text. */
  autoUploadFiles: boolean
  /** Write inbound message bodies to stdout. */
  logInboundMessages: boolean
}

export interface SlackConfig {
  enabled: boolean
  allowedUsers: string[]
  /** Fail-closed channel allowlist. Stable channel IDs only ("C...").
   *  Empty denies every channel. */
  allowedChannels: string[]
  threadIsolation: boolean  // true: per-thread sessions + thread replies, false: per-channel
  respondToThreadReplies: boolean // Forward plain replies in active threads
  /** Upload files whose paths appear in tool results or model text. */
  autoUploadFiles: boolean
  /** Write inbound message bodies to stdout. */
  logInboundMessages: boolean
}

export interface DiscordConfig {
  enabled: boolean
  allowedUsers: string[]
}

export interface TelegramAttachmentsConfig {
  enabled: boolean
  maxFileBytes: number
  maxFilesPerMessage: number
}

export interface TelegramConfig {
  enabled: boolean
  /** Bot token from @BotFather -- env: TELEGRAM_BOT_TOKEN */
  token: string
  /** Respond when @-mentioned in groups (in addition to trigger) */
  respondToMentions: boolean
  /** Per-topic sessions in forum supergroups (chatId:messageThreadId).
   *  When false, all messages in a chat share one session. */
  threadIsolation: boolean
  /** Forward plain messages and attachment-only messages in active topics. */
  respondToImplicitTopicReplies: boolean
  /** Respond when the user replies (swipe-reply) to a message from this bot,
   *  even when the message doesn't start with the trigger or @mention.
   *  Always on in DMs (no-op), and in groups/topic replies the connector
   *  requires an active session for the same chat/topic first so the bot
   *  doesn't pick up stale replies from days-old conversations. */
  respondToReplies: boolean
  /** Download incoming Telegram media into the session workspace for the LLM. */
  attachments: TelegramAttachmentsConfig
  /** Comma-separated Telegram numeric chat IDs and/or user IDs to ignore */
  ignoreChats: string[]
  /** Comma-separated Telegram numeric user IDs to ignore */
  ignoreUsers: string[]
  allowedUsers: string[]
}


export interface WebAttachmentsConfig {
  enabled: boolean
  maxFileBytes: number
  maxFilesPerMessage: number
  maxWidth: number
  maxHeight: number
  maxPixels: number
  resizeMaxDimension: number
  allowedMimeTypes: string[]
}

export interface WebConfig {
  enabled: boolean
  port: number
  host: string
  allowedOrigins: string[]  // CORS origins, ["*"] = any
  publicUrl: string         // Override for logs/snippets (e.g. behind reverse proxy)
  attachments: WebAttachmentsConfig
}

export interface ACPConfig {
  command: string
  args: string[]
  backendId: string
  profileDir: string
  /** Pin every bridge-started session to this working directory so it inherits
   *  that project's AGENTS.md. Empty keeps the upstream behaviour of one
   *  generated workspace per thread. See docs/FORK_DEVIATIONS.md for the
   *  project-hash collision this trades away. */
  sessionCwd: string
}

export interface SessionPickerConfig {
  enabled: boolean
  connectors: string[]
  mirrorIntervalSeconds: number
}

export type ToolMessageMode = "off" | "events" | "status" | "trace"

export type UnlistedToolPresentation = "name" | "hide"

export interface ToolSummariesConfig {
  /** Fail-closed tool-name allowlist. Entries match exactly or as "prefix*".
   *  Only these tools may contribute argument fields to a chat summary. */
  allowedTools: string[]
  /** Argument field names that may appear in a summary. Every other field is
   *  dropped, so an unanticipated argument can never reach chat. */
  allowedFields: string[]
  maxFieldLength: number
  unlistedTools: UnlistedToolPresentation
}

export interface SafeOutputConfig {
  /** Mask credential-shaped substrings in everything the bridge sends. */
  redactSecrets: boolean
  /** Forward raw tool results for tools listed in toolMessages.showOutputFor.
   *  Upstream always forwards them; this fork requires opting back in. */
  allowRawToolOutput: boolean
}

export interface PermissionsConfig {
  /** Render permission requests into chat and wait for an authenticated reply.
   *  When false the bridge keeps upstream's immediate auto-reject. */
  interactive: boolean
  /** Seconds a pending request is held before it is answered with its reject
   *  option. The agent blocks for this long, so keep it short. */
  timeoutSeconds: number
}

export interface ToolMessagesConfig {
  /** Tool-call presentation. Defaults to one immutable message per call. */
  mode?: ToolMessageMode
  /** Legacy switch for tool call notices. False always resolves to mode "off". */
  showCalls: boolean
  /** Include compact tool arguments in call notices. */
  showArguments: boolean
  /** Tool name substrings whose output is forwarded to chat. */
  showOutputFor: string[]
  /** Maximum tool calls retained in an editable trace message. */
  maxTraceEntries?: number
  summaries?: ToolSummariesConfig
}

export interface ChatBridgeConfig {
  botName: string
  trigger: string
  rateLimitSeconds: number
  sessionStorePath: string
  defaultAgent: string | null
  toolMessages: ToolMessagesConfig
  safeOutput: SafeOutputConfig
  permissions: PermissionsConfig
  verboseErrors: boolean  // Send detailed error messages to the user
  sessionPicker: SessionPickerConfig
  acp: ACPConfig
  matrix: MatrixConfig
  mattermost: MattermostConfig
  whatsapp: WhatsAppConfig
  slack: SlackConfig
  discord: DiscordConfig
  telegram: TelegramConfig
  web: WebConfig
}

// Default configuration
const defaultConfig: ChatBridgeConfig = {
  botName: "oc",
  trigger: "!oc",
  rateLimitSeconds: 5,
  sessionStorePath: "./.opencode/chat-sessions.json",
  defaultAgent: null,
  verboseErrors: false,
  toolMessages: {
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
  },
  safeOutput: {
    redactSecrets: true,
    allowRawToolOutput: false,
  },
  permissions: {
    interactive: true,
    timeoutSeconds: 180,
  },
  sessionPicker: {
    enabled: false,
    connectors: [],
    mirrorIntervalSeconds: 60,
  },
  acp: {
    command: "opencode",
    args: ["acp"],
    backendId: "",
    profileDir: "",
    sessionCwd: "",
  },
  matrix: {
    enabled: false,
    homeserver: "https://matrix.org",
    userId: "",
    accessToken: "",
    password: "",  // For password-based login
    deviceId: "OPENCODE_BRIDGE",
    encryption: {
      enabled: false,
      storePath: "./matrix-store/"
    },
    autoJoin: true,
    triggerPatterns: ["!oc "],
    ignoreRooms: [],
    ignoreUsers: [],
    allowedUsers: [],
    allowedRooms: [],
    formatHtml: false,
    threadIsolation: true,  // Per-thread sessions by default
    respondToThreadReplies: true,
    logInboundMessages: false,
  },
  mattermost: {
    enabled: false,
    url: "",
    token: "",
    teamName: "",
    respondToMentions: true,
    respondToThreadReplies: true,
    ignoreChannels: [],
    ignoreUsers: [],
    allowedUsers: [],
    threadIsolation: true,  // Per-thread sessions by default
  },
  whatsapp: {
    enabled: false,
    authFolder: "./.whatsapp-auth",
    allowedUsers: [],
    allowedGroups: [],
    respondToOthers: true,
    autoUploadFiles: false,
    logInboundMessages: false,
  },
  slack: {
    enabled: false,
    allowedUsers: [],
    allowedChannels: [],
    threadIsolation: true,  // Per-thread sessions by default
    respondToThreadReplies: true,
    autoUploadFiles: false,
    logInboundMessages: false,
  },
  discord: {
    enabled: false,
    allowedUsers: [],
  },
  telegram: {
    enabled: false,
    token: "",
    respondToMentions: true,
    threadIsolation: true,
    respondToImplicitTopicReplies: true,
    respondToReplies: true,
    attachments: {
      enabled: true,
      maxFileBytes: 20 * 1024 * 1024,
      maxFilesPerMessage: 4,
    },
    ignoreChats: [],
    ignoreUsers: [],
    allowedUsers: [],
  },
  web: {
    enabled: false,
    port: 3420,
    host: "0.0.0.0",
    allowedOrigins: ["*"],
    publicUrl: "",
    attachments: {
      enabled: false,
      maxFileBytes: 5 * 1024 * 1024,
      maxFilesPerMessage: 1,
      maxWidth: 4096,
      maxHeight: 4096,
      maxPixels: 20_000_000,
      resizeMaxDimension: 2048,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    },
  }
}

/**
 * Replace {env:VAR_NAME} patterns with environment variables
 */
function substituteEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars)
  }
  if (obj && typeof obj === "object") {
    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVars(value)
    }
    return result
  }
  return obj
}

/**
 * Deep merge two objects
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key in source) {
    const sourceValue = source[key]
    const targetValue = (target as any)[key]
    
    if (sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) &&
        targetValue && typeof targetValue === "object" && !Array.isArray(targetValue)) {
      (result as any)[key] = deepMerge(targetValue, sourceValue)
    } else if (sourceValue !== undefined) {
      (result as any)[key] = sourceValue
    }
  }
  return result
}

const TOOL_MESSAGE_MODES = new Set<ToolMessageMode>(["off", "events", "status", "trace"])

function normalizeToolMessages(config: ChatBridgeConfig): void {
  const mode = config.toolMessages.mode
  if (!mode || !TOOL_MESSAGE_MODES.has(mode)) {
    if (mode) console.warn(`[CONFIG] Invalid toolMessages.mode "${mode}"; using "events"`)
    config.toolMessages.mode = "events"
  }

  const maxEntries = config.toolMessages.maxTraceEntries
  if (!Number.isInteger(maxEntries) || (maxEntries || 0) < 1) {
    console.warn("[CONFIG] Invalid toolMessages.maxTraceEntries; using 20")
    config.toolMessages.maxTraceEntries = 20
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map(entry => entry.trim())
    .filter(Boolean)
}

function normalizeToolSummaries(config: ChatBridgeConfig): void {
  const defaults = defaultConfig.toolMessages.summaries!
  const summaries = config.toolMessages.summaries
  if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)) {
    config.toolMessages.summaries = {
      ...defaults,
      allowedTools: [...defaults.allowedTools],
      allowedFields: [...defaults.allowedFields],
    }
    return
  }

  summaries.allowedTools = normalizeStringList(summaries.allowedTools)
  summaries.allowedFields = normalizeStringList(summaries.allowedFields)
  if (!Number.isInteger(summaries.maxFieldLength) || summaries.maxFieldLength < 1) {
    summaries.maxFieldLength = defaults.maxFieldLength
  }
  if (summaries.unlistedTools !== "name" && summaries.unlistedTools !== "hide") {
    summaries.unlistedTools = defaults.unlistedTools
  }
}

function normalizeSafeOutput(config: ChatBridgeConfig): void {
  const defaults = defaultConfig.safeOutput
  if (!config.safeOutput || typeof config.safeOutput !== "object" || Array.isArray(config.safeOutput)) {
    config.safeOutput = { ...defaults }
    return
  }
  // Both flags weaken the output boundary, so anything that is not an explicit
  // boolean resolves to the safe default rather than being coerced.
  if (typeof config.safeOutput.redactSecrets !== "boolean") {
    config.safeOutput.redactSecrets = defaults.redactSecrets
  }
  if (typeof config.safeOutput.allowRawToolOutput !== "boolean") {
    config.safeOutput.allowRawToolOutput = defaults.allowRawToolOutput
  }
}

function normalizePermissions(config: ChatBridgeConfig): void {
  const defaults = defaultConfig.permissions
  if (!config.permissions || typeof config.permissions !== "object" || Array.isArray(config.permissions)) {
    config.permissions = { ...defaults }
    return
  }
  if (typeof config.permissions.interactive !== "boolean") {
    config.permissions.interactive = defaults.interactive
  }
  const timeout = config.permissions.timeoutSeconds
  if (!Number.isInteger(timeout) || timeout < 1) {
    config.permissions.timeoutSeconds = defaults.timeoutSeconds
  }
}

function normalizeAllowlists(config: ChatBridgeConfig): void {
  config.slack.allowedChannels = normalizeStringList(config.slack.allowedChannels)
  config.matrix.allowedRooms = normalizeStringList(config.matrix.allowedRooms)
  config.whatsapp.allowedGroups = normalizeStringList(config.whatsapp.allowedGroups)
}

const WEB_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])

function normalizeWebAttachments(config: ChatBridgeConfig): void {
  const defaults = defaultConfig.web.attachments
  if (
    !config.web.attachments ||
    typeof config.web.attachments !== "object" ||
    Array.isArray(config.web.attachments)
  ) {
    config.web.attachments = { ...defaults, allowedMimeTypes: [...defaults.allowedMimeTypes] }
  }
  const attachments = config.web.attachments
  if (typeof attachments.enabled !== "boolean") attachments.enabled = defaults.enabled
  type PositiveIntegerKey =
    | "maxFileBytes"
    | "maxFilesPerMessage"
    | "maxWidth"
    | "maxHeight"
    | "maxPixels"
    | "resizeMaxDimension"
  const positiveIntegerKeys: PositiveIntegerKey[] = [
    "maxFileBytes",
    "maxFilesPerMessage",
    "maxWidth",
    "maxHeight",
    "maxPixels",
    "resizeMaxDimension",
  ]
  for (const key of positiveIntegerKeys) {
    const value = attachments[key]
    if (!Number.isInteger(value) || value < 1) {
      attachments[key] = defaults[key]
    }
  }
  attachments.allowedMimeTypes = Array.isArray(attachments.allowedMimeTypes)
    ? attachments.allowedMimeTypes.filter(
      (mimeType): mimeType is string =>
        typeof mimeType === "string" && WEB_IMAGE_MIME_TYPES.has(mimeType),
    )
    : [...defaults.allowedMimeTypes]
  if (attachments.allowedMimeTypes.length === 0) {
    attachments.allowedMimeTypes = [...defaults.allowedMimeTypes]
  }
}

function normalizeConfig(config: ChatBridgeConfig): void {
  normalizeToolMessages(config)
  normalizeToolSummaries(config)
  normalizeSafeOutput(config)
  normalizePermissions(config)
  normalizeAllowlists(config)
  normalizeWebAttachments(config)
}

let cachedConfig: ChatBridgeConfig | null = null

/**
 * Load configuration from chat-bridge.json
 */
export function loadConfig(configPath?: string): ChatBridgeConfig {
  if (cachedConfig) return cachedConfig
  
  const searchPaths = configPath 
    ? [configPath]
    : [path.join(process.cwd(), "chat-bridge.json")]
  
  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8")
        const parsed = JSON.parse(content)

        // Backward compatibility for the former top-level streamTools option.
        // The public configuration now groups all chat-visible tool activity
        // under toolMessages.
        if (Array.isArray(parsed.streamTools)) {
          parsed.toolMessages = {
            ...(parsed.toolMessages || {}),
            showOutputFor: parsed.toolMessages?.showOutputFor ?? parsed.streamTools,
          }
          delete parsed.streamTools
        }

        const substituted = substituteEnvVars(parsed)
        cachedConfig = deepMerge(defaultConfig, substituted)
        normalizeConfig(cachedConfig)
        console.log(`[CONFIG] Loaded from ${filePath}`)
        return cachedConfig
      } catch (err) {
        console.error(`[CONFIG] Error loading ${filePath}:`, err)
      }
    }
  }
  
  console.log("[CONFIG] No config file found, using defaults")
  cachedConfig = deepMerge(defaultConfig, {})
  normalizeConfig(cachedConfig)
  return cachedConfig
}

/**
 * Get the current configuration (loads if not already loaded)
 */
export function getConfig(): ChatBridgeConfig {
  return cachedConfig || loadConfig()
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null
}
