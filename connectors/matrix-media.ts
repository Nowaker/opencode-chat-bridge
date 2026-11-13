/**
 * Matrix voice notes: an `m.audio` message (Element's voice message is one,
 * marked `org.matrix.msc3245.voice`), plain (`url`) or, in an encrypted room,
 * an encrypted attachment (`file`) that this connector's own E2EE device
 * decrypts. The audio goes to the relay over its socket and nowhere else.
 */

import type { EncryptedFile } from "matrix-bot-sdk"
import type { VoiceRequest } from "../src/relay/types"
import { extractReplyToEventId } from "./matrix-thread-helpers"

export type MatrixAudioSource = { kind: "plain"; mxc: string } | { kind: "encrypted"; file: EncryptedFile }

export interface MatrixAudio {
  source: MatrixAudioSource
  mimeType: string
  declaredBytes?: number
  declaredDurationMs?: number
  /** Element's voice message, as opposed to an attached audio file. */
  voice: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function encryptedFile(value: unknown): EncryptedFile | null {
  const file = record(value)
  const key = record(file?.key)
  const hashes = record(file?.hashes)
  if (!file || !key || !hashes) return null
  if (typeof file.url !== "string" || !file.url.startsWith("mxc://") || typeof file.iv !== "string" || file.v !== "v2") return null
  if (key.kty !== "oct" || key.alg !== "A256CTR" || typeof key.k !== "string" || key.ext !== true || !Array.isArray(key.key_ops)) return null
  if (typeof hashes.sha256 !== "string") return null
  return {
    url: file.url,
    key: { kty: "oct", key_ops: key.key_ops.filter((op): op is string => typeof op === "string"), alg: "A256CTR", k: key.k, ext: true },
    iv: file.iv,
    hashes: { sha256: hashes.sha256 },
    v: "v2",
  }
}

/** The audio an `m.audio` message carries, or null for anything else. */
export function matrixAudio(event: unknown): MatrixAudio | null {
  const content = record(record(event)?.content)
  if (!content || content.msgtype !== "m.audio") return null
  // An edit of an audio message carries no new audio worth transcribing.
  if (record(content["m.relates_to"])?.rel_type === "m.replace") return null
  const file = encryptedFile(content.file)
  const source: MatrixAudioSource | null = file
    ? { kind: "encrypted", file }
    : typeof content.url === "string" && content.url.startsWith("mxc://")
      ? { kind: "plain", mxc: content.url }
      : null
  if (!source) return null
  const info = record(content.info)
  const mimeType = typeof info?.mimetype === "string" && info.mimetype.startsWith("audio/") ? info.mimetype : "audio/ogg"
  const declaredBytes = finiteNumber(info?.size)
  const declaredDurationMs = finiteNumber(info?.duration) ?? finiteNumber(record(content["org.matrix.msc1767.audio"])?.duration)
  return {
    source,
    mimeType,
    ...(declaredBytes === undefined ? {} : { declaredBytes }),
    ...(declaredDurationMs === undefined ? {} : { declaredDurationMs }),
    voice: content["org.matrix.msc3245.voice"] !== undefined,
  }
}

/**
 * Where the note goes. A voice note cannot carry the trigger, so the owner's
 * note in an allowlisted room is a prompt by itself, top-level or as a Reply;
 * one inside a thread is taken only in a thread the relay serves, like an
 * untriggered typed reply.
 */
export function matrixVoiceRequest(
  context: { roomId: string; sender: string; eventId: string; threadRootEventId: string },
  event: unknown,
  audio: MatrixAudio,
  now: number,
): VoiceRequest {
  const postedAt = record(event)?.origin_server_ts
  const replyToEventId = extractReplyToEventId(event)
  return {
    route: "matrix",
    eventId: context.eventId,
    roomId: context.roomId,
    threadRootId: context.threadRootEventId,
    sender: context.sender,
    postedAt: typeof postedAt === "number" ? postedAt : now,
    implicit: context.threadRootEventId !== "",
    mimeType: audio.mimeType,
    ...(replyToEventId ? { replyToEventId } : {}),
    ...(audio.declaredDurationMs === undefined ? {} : { declaredDurationMs: audio.declaredDurationMs }),
  }
}

export interface MatrixMediaClient {
  downloadContent(mxc: string): Promise<{ data: Buffer }>
  decryptMedia(file: EncryptedFile): Promise<Buffer>
}

/** The note's bytes: downloaded, and decrypted (its sha256 checked) when it is encrypted. */
export async function downloadMatrixAudio(client: MatrixMediaClient, source: MatrixAudioSource): Promise<Uint8Array<ArrayBuffer>> {
  if (source.kind === "encrypted") return new Uint8Array(await client.decryptMedia(source.file))
  return new Uint8Array((await client.downloadContent(source.mxc)).data)
}
