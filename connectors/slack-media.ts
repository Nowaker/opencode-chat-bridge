/**
 * Slack voice notes: an audio clip recorded in Slack (a file with subtype
 * `slack_audio`) or an attached audio file, shared in a message. The bot
 * downloads it with its own token, which needs the `files:read` scope, and
 * hands it to the relay.
 */

import type { VoiceRequest } from "../src/relay/types"

export interface SlackAudioFile {
  id: string
  /** `url_private_download`; absent when Slack sent the file as a stub, which `files.info` completes. */
  url?: string
  mimeType: string
  declaredBytes?: number
  declaredDurationMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** One file object, when it is audio. */
export function slackAudioOf(file: unknown): SlackAudioFile | null {
  if (!isRecord(file) || typeof file.id !== "string" || !file.id) return null
  const mimeType = typeof file.mimetype === "string" ? file.mimetype : ""
  if (file.subtype !== "slack_audio" && !mimeType.startsWith("audio/")) return null
  const declaredBytes = finiteNumber(file.size)
  const declaredDurationMs = finiteNumber(file.duration_ms)
  return {
    id: file.id,
    ...(typeof file.url_private_download === "string" ? { url: file.url_private_download } : {}),
    mimeType: mimeType.startsWith("audio/") ? mimeType : "audio/webm",
    ...(declaredBytes === undefined ? {} : { declaredBytes }),
    ...(declaredDurationMs === undefined ? {} : { declaredDurationMs }),
  }
}

/** The first audio file a message shares, or null. */
export function slackAudioFile(message: unknown): SlackAudioFile | null {
  if (!isRecord(message) || !Array.isArray(message.files)) return null
  for (const file of message.files) {
    const audio = slackAudioOf(file)
    if (audio) return audio
  }
  return null
}

/** As on Matrix: a top-level note is a prompt by itself; one in a thread only in a thread the relay serves. */
export function slackVoiceRequest(
  context: { channelId: string; userId: string; eventTs: string; threadTs?: string },
  audio: SlackAudioFile,
): VoiceRequest {
  return {
    route: "slack",
    eventId: context.eventTs,
    roomId: context.channelId,
    threadRootId: context.threadTs ?? "",
    sender: context.userId,
    postedAt: Math.round(Number(context.eventTs) * 1000) || Date.now(),
    implicit: Boolean(context.threadTs),
    mimeType: audio.mimeType,
    ...(audio.declaredDurationMs === undefined ? {} : { declaredDurationMs: audio.declaredDurationMs }),
  }
}

/**
 * Downloads a private file with the bot token. Without `files:read` Slack
 * answers 200 with its sign-in page rather than an error, so HTML is refused
 * by name.
 */
export async function downloadSlackFile(
  url: string,
  token: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "follow", signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if ((response.headers.get("content-type") ?? "").startsWith("text/html")) {
    throw new Error("Slack answered with a web page: the app's token needs the files:read scope")
  }
  return new Uint8Array(await response.arrayBuffer())
}
