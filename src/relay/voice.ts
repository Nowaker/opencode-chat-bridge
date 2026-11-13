/**
 * A voice note's way to the relay, shared by the connectors: they download
 * (and on Matrix decrypt) the owner's audio, and this hands it over, retrying
 * under the same event id, which the relay dedupes on. The relay transcribes
 * it on the host; the audio never goes anywhere else.
 */

import { RelayError, type RelayClient } from "./client"
import type { VoiceRequest } from "./types"

/** Ten minutes of a voice message is a few MiB; the relay accepts 25 MiB per request. */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024

export interface VoiceForwarding {
  relay: Pick<RelayClient, "voice">
  /** Delays before each further attempt while the relay cannot be reached. */
  delaysMs: readonly number[]
  log(line: string): void
  /** Tells the owner, in the note's thread, that it went nowhere. */
  warn(text: string): Promise<void>
  sleep?(ms: number): Promise<void>
  stopping?(): boolean
}

/** Gets the audio, refusing one over `MAX_VOICE_BYTES`; null after it told the owner why. */
export async function fetchVoiceAudio(
  forwarding: Pick<VoiceForwarding, "log" | "warn">,
  declaredBytes: number | undefined,
  download: () => Promise<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (declaredBytes !== undefined && declaredBytes > MAX_VOICE_BYTES) {
    await forwarding.warn(`⚠ This voice note is over ${MAX_VOICE_BYTES / 1_048_576} MiB, so it was not transcribed.`)
    return null
  }
  let audio: Uint8Array<ArrayBuffer>
  try {
    audio = await download()
  } catch (err) {
    forwarding.log(`[VOICE] download failed: ${err instanceof Error ? err.message : String(err)}`)
    await forwarding.warn("⚠ This voice note could not be downloaded, so it was not transcribed. Send it again.")
    return null
  }
  if (audio.length > MAX_VOICE_BYTES) {
    await forwarding.warn(`⚠ This voice note is over ${MAX_VOICE_BYTES / 1_048_576} MiB, so it was not transcribed.`)
    return null
  }
  return audio
}

export async function forwardVoice(forwarding: VoiceForwarding, request: VoiceRequest, audio: Uint8Array<ArrayBuffer>): Promise<void> {
  const sleep = forwarding.sleep ?? ((ms: number) => Bun.sleep(ms))
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await forwarding.relay.voice(request, audio)
      const detail = [result.relayId, result.reason].filter(Boolean).join(": ")
      forwarding.log(`[RELAY] voice ${result.state}${detail ? ` ${detail}` : ""} (${audio.length} bytes)`)
      return
    } catch (err) {
      const retryable = !(err instanceof RelayError) || err.retryable
      const delay = forwarding.delaysMs[attempt]
      if (!retryable || delay === undefined || forwarding.stopping?.()) {
        forwarding.log(`[RELAY] voice failed: ${err instanceof Error ? err.message : String(err)}`)
        await forwarding.warn("⚠ The relay did not take this voice note, so it was not transcribed. Send it again once the relay is back.")
        return
      }
      await sleep(delay)
    }
  }
}
