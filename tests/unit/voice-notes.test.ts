import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { Attachment, EncryptedAttachment } from "@matrix-org/matrix-sdk-crypto-nodejs"
import { downloadMatrixAudio, matrixAudio, matrixVoiceRequest } from "../../connectors/matrix-media"
import { downloadSlackFile, slackAudioFile, slackVoiceRequest } from "../../connectors/slack-media"
import { SlackConnector } from "../../connectors/slack"
import { RelayClient, RelayError } from "../../src/relay/client"
import type { InboundRequest, InboundResponse, OutboxResponse, VoiceRequest } from "../../src/relay/types"
import { fetchVoiceAudio, forwardVoice, MAX_VOICE_BYTES } from "../../src/relay/voice"

const OGG = new Uint8Array([79, 103, 103, 83, 0, 2, 9, 9, 7])
const CONTEXT = { roomId: "!room:x", sender: "@owner:x", eventId: "$voice", threadRootEventId: "" }

function audioEvent(content: Record<string, unknown>): Record<string, unknown> {
  return { type: "m.room.message", event_id: "$voice", sender: "@owner:x", origin_server_ts: 1_794_000_000, content: { msgtype: "m.audio", body: "Voice message", ...content } }
}

describe("Matrix voice notes", () => {
  test("an Element voice message in an encrypted room: the parsed file decrypts with the real crypto", async () => {
    const encrypted = Attachment.encrypt(OGG)
    const file: Record<string, unknown> = JSON.parse(encrypted.mediaEncryptionInfo ?? "{}")
    const event = audioEvent({
      file: { ...file, url: "mxc://x/abc" },
      info: { mimetype: "audio/ogg", size: OGG.length, duration: 4_200 },
      "org.matrix.msc1767.audio": { duration: 4_200 },
      "org.matrix.msc3245.voice": {},
    })
    const audio = matrixAudio(event)
    expect(audio).toMatchObject({ mimeType: "audio/ogg", declaredBytes: OGG.length, declaredDurationMs: 4_200, voice: true })
    expect(audio?.source.kind).toBe("encrypted")

    const downloads: string[] = []
    const client = {
      downloadContent: async (mxc: string) => {
        downloads.push(mxc)
        return { data: Buffer.from(encrypted.encryptedData) }
      },
      // What CryptoClient.decryptMedia does with the file it is given.
      decryptMedia: async (given: { url: string }) => {
        const data = (await client.downloadContent(given.url)).data
        return Buffer.from(Attachment.decrypt(new EncryptedAttachment(data, JSON.stringify(given))))
      },
    }
    expect(Array.from(await downloadMatrixAudio(client, audio!.source))).toEqual(Array.from(OGG))
    expect(downloads).toEqual(["mxc://x/abc"])
  })

  test("a plain audio file, and what is not audio", () => {
    expect(matrixAudio(audioEvent({ url: "mxc://x/plain", info: { mimetype: "audio/mpeg" } }))).toEqual({
      source: { kind: "plain", mxc: "mxc://x/plain" }, mimeType: "audio/mpeg", voice: false,
    })
    expect(matrixAudio(audioEvent({ msgtype: "m.text", body: "hi" }))).toBeNull()
    expect(matrixAudio(audioEvent({ url: "https://not-mxc" }))).toBeNull()
    expect(matrixAudio(audioEvent({ url: "mxc://x/e", "m.relates_to": { rel_type: "m.replace", event_id: "$old" } }))).toBeNull()
  })

  test("a top-level note or a Reply is a prompt by itself; one in a thread only where the relay serves", () => {
    const audio = matrixAudio(audioEvent({ url: "mxc://x/plain" }))!
    expect(matrixVoiceRequest(CONTEXT, audioEvent({}), audio, 1)).toEqual({
      route: "matrix", eventId: "$voice", roomId: "!room:x", threadRootId: "", sender: "@owner:x", postedAt: 1_794_000_000,
      implicit: false, mimeType: "audio/ogg",
    })
    const reply = audioEvent({ "m.relates_to": { "m.in_reply_to": { event_id: "$ask" } } })
    expect(matrixVoiceRequest(CONTEXT, reply, audio, 1)).toMatchObject({ implicit: false, replyToEventId: "$ask" })
    expect(matrixVoiceRequest({ ...CONTEXT, threadRootEventId: "$root" }, audioEvent({}), audio, 1)).toMatchObject({ implicit: true, threadRootId: "$root" })
  })
})

class FakeRelay {
  voices: Array<{ request: VoiceRequest; audio: number[] }> = []
  failures: Error[] = []
  inbound_: InboundRequest[] = []
  async voice(request: VoiceRequest, audio: Uint8Array<ArrayBuffer>): Promise<InboundResponse> {
    const failure = this.failures.shift()
    if (failure) throw failure
    this.voices.push({ request, audio: Array.from(audio) })
    return { state: "accepted", relayId: "rly_v", reason: "transcribing" }
  }
  async inbound(request: InboundRequest): Promise<InboundResponse> {
    this.inbound_.push(request)
    return { state: "accepted", relayId: "rly_x" }
  }
  async outbox(): Promise<OutboxResponse> {
    return { items: [], typingRooms: [] }
  }
  async ack(): Promise<void> {}
  async nack(): Promise<void> {}
  async health(): Promise<Record<string, unknown>> {
    return {}
  }
}

describe("handing a note to the relay", () => {
  test("retries under the same event while the relay is unreachable, and says so when it gives up", async () => {
    const relay = new FakeRelay()
    relay.failures.push(new RelayError("relay /v1/voice: ECONNREFUSED"))
    const warnings: string[] = []
    const forwarding = { relay, delaysMs: [1], log: () => {}, warn: async (text: string) => { warnings.push(text) }, sleep: async () => {} }
    const request = matrixVoiceRequest(CONTEXT, audioEvent({}), matrixAudio(audioEvent({ url: "mxc://x/p" }))!, 1)
    await forwardVoice(forwarding, request, OGG)
    expect(relay.voices).toEqual([{ request, audio: Array.from(OGG) }])
    expect(warnings).toEqual([])

    relay.failures.push(new RelayError("relay /v1/voice: HTTP 400 invalid voice: mimeType", 400))
    await forwardVoice(forwarding, request, OGG)
    expect(warnings).toEqual(["⚠ The relay did not take this voice note, so it was not transcribed. Send it again once the relay is back."])
  })

  test("a note over the size cap is refused before it is downloaded, and a failed download says so", async () => {
    const warnings: string[] = []
    const forwarding = { log: () => {}, warn: async (text: string) => { warnings.push(text) } }
    let downloads = 0
    expect(await fetchVoiceAudio(forwarding, MAX_VOICE_BYTES + 1, async () => { downloads++; return OGG })).toBeNull()
    expect(downloads).toBe(0)
    expect(await fetchVoiceAudio(forwarding, undefined, async () => { throw new Error("M_NOT_FOUND") })).toBeNull()
    expect(warnings).toEqual([
      "⚠ This voice note is over 20 MiB, so it was not transcribed.",
      "⚠ This voice note could not be downloaded, so it was not transcribed. Send it again.",
    ])
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("RelayClient.voice", () => {
  test("sends the request as `meta` and the audio as `audio` in one multipart body with its length", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "voice-client-"))
    dirs.push(dir)
    const socket = path.join(dir, "relay.sock")
    const seen: Array<{ length: string | null; meta: unknown; audio: number[] }> = []
    const server = Bun.serve({
      unix: socket,
      fetch: async (request) => {
        const form = await request.formData()
        const audio = form.get("audio")
        seen.push({
          length: request.headers.get("content-length"),
          meta: JSON.parse(String(form.get("meta"))),
          audio: audio instanceof Blob ? Array.from(new Uint8Array(await audio.arrayBuffer())) : [],
        })
        return Response.json({ state: "accepted", relayId: "rly_1", reason: "transcribing" })
      },
    })
    try {
      const request: VoiceRequest = { ...matrixVoiceRequest(CONTEXT, audioEvent({}), matrixAudio(audioEvent({ url: "mxc://x/p" }))!, 1) }
      expect(await new RelayClient(socket).voice(request, OGG)).toEqual({ state: "accepted", relayId: "rly_1", reason: "transcribing" })
      expect(seen).toHaveLength(1)
      expect(seen[0]!.meta).toEqual(request)
      expect(seen[0]!.audio).toEqual(Array.from(OGG))
      expect(Number(seen[0]!.length)).toBeGreaterThan(OGG.length)
    } finally {
      server.stop(true)
    }
  })
})

describe("Slack voice notes", () => {
  const OWNER = "U0OWNER"
  const CHANNEL = "C0CHANNEL"
  const clip = { id: "F1", subtype: "slack_audio", mimetype: "audio/webm", size: OGG.length, duration_ms: 3_100, url_private_download: "https://files.slack.com/F1/audio.webm" }

  function setup() {
    const relay = new FakeRelay()
    const downloads: string[] = []
    const connector = new SlackConnector({ relay, downloadFile: async (url) => { downloads.push(url); return OGG } })
    ;(connector as any).allowedUsers = new Set([OWNER])
    ;(connector as any).allowedChannels = new Set([CHANNEL])
    const handlers: Record<string, any> = {}
    connector.registerHandlers({
      event: () => {},
      message: (first: any, second?: any) => {
        if (typeof first === "function") handlers.thread = first
        else handlers.trigger = second
      },
    } as any)
    const posts: any[] = []
    const client = { chat: { postMessage: async (payload: any) => { posts.push(payload); return { ts: "1" } } } }
    return { relay, downloads, handlers, client, posts }
  }

  test("an audio clip from the owner is downloaded and handed to the relay; a thread clip is implicit", async () => {
    const { relay, downloads, handlers, client } = setup()
    await handlers.thread({ message: { subtype: "file_share", text: "", user: OWNER, channel: CHANNEL, ts: "1794.000100", files: [clip] }, body: {}, client })
    await handlers.thread({ message: { subtype: "file_share", text: "", user: OWNER, channel: CHANNEL, ts: "1794.000101", thread_ts: "1794.000050", files: [clip] }, body: {}, client })
    expect(downloads).toEqual([clip.url_private_download, clip.url_private_download])
    expect(relay.voices.map(({ request }) => request)).toEqual([
      { route: "slack", eventId: "1794.000100", roomId: CHANNEL, threadRootId: "", sender: OWNER, postedAt: 1_794_000, implicit: false, mimeType: "audio/webm", declaredDurationMs: 3_100 },
      { route: "slack", eventId: "1794.000101", roomId: CHANNEL, threadRootId: "1794.000050", sender: OWNER, postedAt: 1_794_000, implicit: true, mimeType: "audio/webm", declaredDurationMs: 3_100 },
    ])
    expect(relay.voices[0]!.audio).toEqual(Array.from(OGG))
    expect(relay.inbound_).toEqual([])
  })

  test("a stranger's clip, or one in another channel, is never downloaded", async () => {
    const { relay, downloads, handlers, client } = setup()
    await handlers.thread({ message: { subtype: "file_share", user: "U0STRANGER", channel: CHANNEL, ts: "1794.000200", files: [clip] }, body: {}, client })
    await handlers.thread({ message: { subtype: "file_share", user: OWNER, channel: "C0OTHER", ts: "1794.000201", files: [clip] }, body: {}, client })
    expect(downloads).toEqual([])
    expect(relay.voices).toEqual([])
  })

  test("what counts as audio, and a missing files:read scope is named", async () => {
    expect(slackAudioFile({ files: [{ id: "F2", mimetype: "image/png" }, { id: "F3", mimetype: "audio/mp4" }] })).toEqual({ id: "F3", mimeType: "audio/mp4" })
    expect(slackAudioFile({ files: [{ id: "F4", mimetype: "video/mp4", subtype: "slack_video" }] })).toBeNull()
    expect(slackVoiceRequest({ channelId: CHANNEL, userId: OWNER, eventTs: "1794.5" }, { id: "F", mimeType: "audio/webm" }).implicit).toBe(false)
    const signIn = async () => new Response("<html>sign in</html>", { headers: { "content-type": "text/html; charset=utf-8" } })
    await expect(downloadSlackFile("https://files.slack.com/F1", "xoxb-test", signIn)).rejects.toThrow("files:read")
    const ok = async () => new Response(OGG, { headers: { "content-type": "audio/webm" } })
    expect(Array.from(await downloadSlackFile("https://files.slack.com/F1", "xoxb-test", ok))).toEqual(Array.from(OGG))
  })
})
