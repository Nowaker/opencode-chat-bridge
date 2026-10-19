/**
 * The few vibeterm-api calls the relay makes, with the outcome of a prompt
 * classified by what it proves about delivery.
 *
 * Prompts go to `POST /session/{id}/prompt_async` with an `Idempotency-Key`.
 * vibeterm-api keeps a ledger for that key, so sending the same key again
 * after a timeout never types the prompt twice: it replays the recorded
 * receipt, or reconciles against the database. That is what makes a retry
 * after an uncertain answer safe rather than a blind resend.
 *
 * The password is never stored here. It is read from Vibeterm's own
 * credential record each time the cache expires, the way OpenPortal reads it,
 * so a rotation reaches the relay without anything being rewritten.
 */

import type { ApiMessage } from "./turns"

export type PromptOutcome =
  /** The prompt is a user row; `messageId` is that row. */
  | { kind: "delivered"; messageId: string }
  /** It may have landed. Retry with the SAME key; never with a new one. */
  | { kind: "uncertain"; status?: number; error: string }
  /** It definitely did not land, and trying again may work. */
  | { kind: "retry"; status?: number; error: string }
  /** Refused for good. */
  | { kind: "failed"; status: number; error: string }
  /** Delivery is blocked on a human: the tab's composer holds unsent text. */
  | { kind: "needs_attention"; status: number; error: string }

export interface VibetermApiOptions {
  url: string
  username: string
  password: () => Promise<string>
  fetchImpl?: typeof fetch
  promptTimeoutMs?: number
  readTimeoutMs?: number
}

export class VibetermApi {
  private readonly fetchImpl: typeof fetch
  private readonly promptTimeoutMs: number
  private readonly readTimeoutMs: number

  constructor(private readonly options: VibetermApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    // vibeterm-api answers a prompt within 90s even when it has to wake a parked tab.
    this.promptTimeoutMs = options.promptTimeoutMs ?? 100_000
    this.readTimeoutMs = options.readTimeoutMs ?? 20_000
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const password = await this.options.password()
    const basic = Buffer.from(`${this.options.username}:${password}`, "utf8").toString("base64")
    return { authorization: `Basic ${basic}`, ...extra }
  }

  private url(path: string): string {
    return new URL(path, this.options.url).toString()
  }

  async promptAsync(sessionID: string, key: string, text: string): Promise<PromptOutcome> {
    let headers: Record<string, string>
    try {
      headers = await this.headers({ "content-type": "application/json", "idempotency-key": key })
    } catch (error) {
      // Nothing was sent: the credential could not be read.
      return { kind: "retry", error: error instanceof Error ? error.message : String(error) }
    }
    let response: Response
    try {
      response = await this.fetchImpl(this.url(`/session/${encodeURIComponent(sessionID)}/prompt_async`), {
        method: "POST",
        headers,
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
        signal: AbortSignal.timeout(this.promptTimeoutMs),
      })
    } catch (error) {
      return classifyTransportError(error)
    }
    return classifyPromptResponse(response)
  }

  async messages(sessionID: string, limit: number): Promise<ApiMessage[]> {
    const response = await this.fetchImpl(
      this.url(`/session/${encodeURIComponent(sessionID)}/message?limit=${limit}`),
      { headers: await this.headers(), signal: AbortSignal.timeout(this.readTimeoutMs) },
    )
    if (!response.ok) throw new Error(`messages: HTTP ${response.status}`)
    const body = await response.json()
    if (!Array.isArray(body)) throw new Error("messages: not an array")
    return body as ApiMessage[]
  }

  async message(sessionID: string, messageID: string): Promise<ApiMessage | null> {
    const response = await this.fetchImpl(
      this.url(`/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`),
      { headers: await this.headers(), signal: AbortSignal.timeout(this.readTimeoutMs) },
    )
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`message: HTTP ${response.status}`)
    return (await response.json()) as ApiMessage
  }

  /** Sessions with a turn running, per vibeterm-api's own stuck-detector verdict. */
  async busySessions(): Promise<Set<string>> {
    const response = await this.fetchImpl(this.url("/session/status"), {
      headers: await this.headers(),
      signal: AbortSignal.timeout(this.readTimeoutMs),
    })
    if (!response.ok) throw new Error(`status: HTTP ${response.status}`)
    const body = (await response.json()) as Record<string, { type?: string }>
    return new Set(Object.entries(body).filter(([, s]) => s?.type !== "idle").map(([id]) => id))
  }

  async session(sessionID: string): Promise<Record<string, any> | null> {
    const response = await this.fetchImpl(this.url(`/session/${encodeURIComponent(sessionID)}`), {
      headers: await this.headers(),
      signal: AbortSignal.timeout(this.readTimeoutMs),
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`session: HTTP ${response.status}`)
    return (await response.json()) as Record<string, any>
  }
}

export function classifyTransportError(error: unknown): PromptOutcome {
  const code = (error as { code?: unknown })?.code
  const message = error instanceof Error ? error.message : String(error)
  // Refused before any byte was sent: nothing can have been delivered.
  if (code === "ConnectionRefused" || code === "ECONNREFUSED" || code === "FailedToOpenSocket") {
    return { kind: "retry", error: `connection refused` }
  }
  return { kind: "uncertain", error: message.slice(0, 200) }
}

export async function classifyPromptResponse(response: Response): Promise<PromptOutcome> {
  const status = response.status
  if (status === 204 || status === 200) {
    const messageId = response.headers.get("x-vibeterm-message-id") ?? ""
    if (!messageId) return { kind: "uncertain", status, error: "accepted without a message-id receipt" }
    return { kind: "delivered", messageId }
  }
  let body: any = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const name = typeof body?.name === "string" ? body.name : `HTTP ${status}`
  const detail = typeof body?.data?.message === "string" ? `${name}: ${body.data.message}` : name
  const error = detail.slice(0, 200)
  if (status === 504 || body?.data?.possiblyAccepted === true) return { kind: "uncertain", status, error }
  if (status === 409) return { kind: "needs_attention", status, error }
  // Refused by the gate or before any delivery was attempted.
  if (status === 401 || status === 503 || status === 429) return { kind: "retry", status, error }
  // A definite refusal (usually a parked tab still waking past the API's 60s
  // pane wait): nothing was submitted and the ledger forgets the key.
  if (status === 400 && body?.data?.possiblyAccepted === false) return { kind: "retry", status, error }
  if (status >= 500) return { kind: "uncertain", status, error }
  return { kind: "failed", status, error }
}

/**
 * Read the vibeterm-api password through opencode-tools' own secrets module,
 * cached for `ttlMs`. The module is loaded by path so this file carries no
 * dependency on opencode-tools.
 */
export function vibetermSecretsPassword(modulePath: string, ttlMs = 60_000): () => Promise<string> {
  let cached: { value: string; at: number } | null = null
  let loaded: Promise<{ readSecret: (key: string) => { value: string } | undefined; API_PASSWORD_KEY: string }> | null = null
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value
    loaded ??= import(modulePath) as Promise<any>
    const secrets = await loaded
    const record = secrets.readSecret(secrets.API_PASSWORD_KEY)
    if (!record?.value) throw new Error("vibeterm-api password record is missing")
    cached = { value: record.value, at: Date.now() }
    return record.value
  }
}
