/**
 * OpenCode Chat Bridge
 * ACP-based client for OpenCode
 * 
 * Usage:
 *   CLI: bun src/cli.ts [prompt]
 *   Library: import { ACPClient } from "opencode-chat-bridge"
 */

export { ACPClient, type ACPClientOptions, type MCPServer, type SessionUpdate, type ActivityEvent, type ToolActivityRevision, type ImageContent, type PromptImage, type OpenCodeCommand } from "./acp-client"
export { getConfig, loadConfig, clearConfigCache, type ChatBridgeConfig, type ACPConfig, type MatrixConfig, type MattermostConfig, type WhatsAppConfig, type SlackConfig, type DiscordConfig, type TelegramConfig, type TelegramAttachmentsConfig, type WebConfig, type WebAttachmentsConfig, type ToolMessageMode, type ToolMessagesConfig, type ToolSummariesConfig, type UnlistedToolPresentation, type SafeOutputConfig, type PermissionsConfig } from "./config"
export { 
  getSessionDir, 
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

export { ACPSessionStore, type StoredACPSession } from "./session-store"

export { ImageHandler, type ImageUploadCallback, DocHandler, type DocUploadCallback } from "./image-handler"
