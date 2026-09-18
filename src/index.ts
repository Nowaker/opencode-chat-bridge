/**
 * OpenCode Chat Bridge
 * ACP-based client for OpenCode
 * 
 * Usage:
 *   CLI: bun src/cli.ts [prompt]
 *   Library: import { ACPClient } from "opencode-chat-bridge"
 */

export { ACPClient, type ACPClientOptions, type MCPServer, type SessionUpdate, type ActivityEvent, type ToolActivityRevision, type ImageContent, type PromptImage, type OpenCodeCommand, type PermissionOption, type PermissionRequest } from "./acp-client"

export {
  PermissionBroker,
  formatPermissionPrompt,
  generateCorrelationToken,
  resolveRejectOption,
  type PendingPermission,
  type PermissionReplyOutcome,
  type PermissionRequestInput,
} from "./permission-broker"
export { getConfig, loadConfig, clearConfigCache, type ChatBridgeConfig, type ACPConfig, type MatrixConfig, type MattermostConfig, type WhatsAppConfig, type SlackConfig, type DiscordConfig, type TelegramConfig, type TelegramAttachmentsConfig, type WebConfig, type WebAttachmentsConfig, type ToolMessageMode, type ToolMessagesConfig, type ToolSummariesConfig, type UnlistedToolPresentation, type SafeOutputConfig, type PermissionsConfig } from "./config"
export { 
  getSessionDir, 
  resolveSessionWorkspace,
  type ResolvedSessionWorkspace,
  ensureSessionDir, 
  cleanupOldSessions, 
  getSessionStorageInfo, 
  getSessionBaseDir, 
  estimateTokens,
  extractImagePaths,
  extractDocPaths,
  removeImageMarkers,
  removeDocMarkers,
  sanitizeServerPaths,
  copyOpenCodeConfig,
  copyACPProfile,
  type SessionConfig 
} from "./session-utils"

// Connector base classes and utilities
export {
  BaseConnector,
  SessionManager,
  RateLimiter,
  EventDeduplicator,
  CommandHandler,
  parseCsvList,
  isAllowedId,
  formatToolCallMessage,
  resolveToolMessageMode,
  resolveToolSummaries,
  FAIL_CLOSED_TOOL_SUMMARIES,
  ToolActivityPresenter,
  ToolActivityController,
  shouldShowToolOutput,
  type BaseSession,
  type SessionStats,
  type ConnectorConfig,
  type ActiveQueryHandle,
} from "./connector-base"

export {
  AI_PREFIX,
  WHATSAPP_MAX_MESSAGE_LENGTH,
  applyAiPrefix,
  buildAiMessageChunks,
  looksLikeBridgeEcho,
} from "./whatsapp-format"

export {
  REDACTION_PLACEHOLDER,
  redactSecrets,
  matchesToolAllowlist,
  summarizeToolCall,
  type ToolSummaryOptions,
} from "./safe-output"

export { ACPSessionStore, type StoredACPSession } from "./session-store"

export { ImageHandler, type ImageUploadCallback, DocHandler, type DocUploadCallback } from "./image-handler"
