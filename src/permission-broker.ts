/**
 * Correlated, authenticated permission replies.
 *
 * A permission request is held open under a short opaque token. A chat message
 * only settles it when it names that token, comes from an allowlisted sender,
 * arrives in the thread the request was posted to, and lands inside the expiry
 * window. Every other message leaves the request pending.
 */

import { randomInt } from "crypto"

export interface PermissionOption {
  optionId: string
  name: string
  kind?: string
}

export interface PermissionRequestInput {
  requestId: string | number
  title: string
  threadId: string
  options: PermissionOption[]
}

export interface PendingPermission extends PermissionRequestInput {
  token: string
  createdAt: number
  expiresAt: number
}

export type PermissionReplyOutcome =
  | { status: "accepted"; pending: PendingPermission; optionId: string }
  | { status: "no_token" }
  | { status: "unknown_token" }
  | { status: "expired"; pending: PendingPermission }
  | { status: "wrong_sender"; pending: PendingPermission }
  | { status: "wrong_thread"; pending: PendingPermission }
  | { status: "ambiguous"; pending: PendingPermission }

export interface PermissionReplyInput {
  text: string
  senderId: string
  threadId: string
  now?: number
}

export interface PermissionBrokerOptions {
  timeoutMs: number
  authorize: (senderId: string) => boolean
  now?: () => number
}

/**
 * Ambiguous characters are excluded so a token read off a phone screen cannot
 * be mistyped into a different valid token.
 */
const CORRELATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
const CORRELATION_LENGTH = 6

export function generateCorrelationToken(): string {
  let token = ""
  for (let i = 0; i < CORRELATION_LENGTH; i++) {
    token += CORRELATION_ALPHABET[randomInt(CORRELATION_ALPHABET.length)]
  }
  return token
}

/**
 * The option to answer with when nobody approves: an explicit reject entry if
 * the agent offered one, otherwise the last option. opencode treats every
 * optionId other than `once`/`always` as a refusal, so falling back to an
 * unrecognized id still denies.
 */
export function resolveRejectOption(options: PermissionOption[]): string {
  const explicit = options.find(
    (option) => option.optionId === "reject" || (option.kind || "").startsWith("reject"),
  )
  return explicit?.optionId || options[options.length - 1]?.optionId || "reject"
}

/**
 * How many settled tokens stay remembered. Recognizing a token the bridge
 * actually issued is what separates "you answered a request that already
 * closed" from ordinary chat, without guessing at token-shaped words and
 * swallowing a message that merely contains one.
 */
const SETTLED_TOKEN_MEMORY = 100

export class PermissionBroker {
  private pending = new Map<string, PendingPermission>()
  private settled = new Set<string>()

  constructor(private options: PermissionBrokerOptions) {}

  private remember(token: string): void {
    this.settled.add(token)
    if (this.settled.size > SETTLED_TOKEN_MEMORY) {
      const oldest = this.settled.values().next().value
      if (oldest) this.settled.delete(oldest)
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  get size(): number {
    return this.pending.size
  }

  list(): PendingPermission[] {
    return [...this.pending.values()]
  }

  get(token: string): PendingPermission | undefined {
    return this.pending.get(token.toUpperCase())
  }

  create(input: PermissionRequestInput): PendingPermission {
    let token = generateCorrelationToken()
    while (this.pending.has(token)) token = generateCorrelationToken()

    const createdAt = this.now()
    const entry: PendingPermission = {
      ...input,
      token,
      createdAt,
      expiresAt: createdAt + this.options.timeoutMs,
    }
    this.pending.set(token, entry)
    return entry
  }

  settle(token: string): PendingPermission | undefined {
    const key = token.toUpperCase()
    const entry = this.pending.get(key)
    if (entry) this.pending.delete(key)
    this.remember(key)
    return entry
  }

  /** Remove and return every request whose window has closed. */
  takeExpired(): PendingPermission[] {
    const now = this.now()
    const expired = [...this.pending.values()].filter((entry) => now >= entry.expiresAt)
    for (const entry of expired) {
      this.pending.delete(entry.token)
      this.remember(entry.token)
    }
    return expired
  }

  /** Remove and return everything still pending, for shutdown or disconnect. */
  takeAll(): PendingPermission[] {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const entry of all) this.remember(entry.token)
    return all
  }

  /**
   * Classify a chat message as a reply to a held request.
   *
   * Authentication is checked before the message is parsed for a decision, so
   * an unauthorized sender cannot probe which selections a request accepts.
   * An accepted outcome removes the request; every other outcome leaves it
   * pending so the real owner can still answer.
   */
  resolveReply(input: PermissionReplyInput): PermissionReplyOutcome {
    const now = input.now ?? this.now()
    const token = this.findToken(input.text)
    if (!token) return { status: "no_token" }

    const pending = this.pending.get(token)
    // A token this bridge issued but no longer holds: already answered,
    // already expired, or issued before a restart.
    if (!pending) return { status: "unknown_token" }
    if (now >= pending.expiresAt) return { status: "expired", pending }
    if (!this.options.authorize(input.senderId)) return { status: "wrong_sender", pending }
    if (input.threadId !== pending.threadId) return { status: "wrong_thread", pending }

    const optionId = this.findSelection(input.text, token, pending.options)
    if (!optionId) return { status: "ambiguous", pending }

    this.settle(token)
    return { status: "accepted", pending, optionId }
  }

  private findToken(text: string): string | null {
    const found = tokenize(text).filter(
      (word) => this.pending.has(word) || this.settled.has(word),
    )
    // Two different tokens in one message name no single request.
    return new Set(found).size === 1 ? found[0] : null
  }

  /**
   * A decision is an option's 1-based position or its exact id/name. Anything
   * naming zero or several distinct options is not a decision.
   */
  private findSelection(text: string, token: string, options: PermissionOption[]): string | null {
    const words = tokenize(text).filter((word) => word !== token)
    const selected = new Set<string>()

    for (const word of words) {
      const index = Number.parseInt(word, 10)
      if (String(index) === word && index >= 1 && index <= options.length) {
        selected.add(options[index - 1].optionId)
        continue
      }
      const match = options.find(
        (option) =>
          option.optionId.toUpperCase() === word ||
          option.name.toUpperCase().replace(/\s+/g, "") === word,
      )
      if (match) selected.add(match.optionId)
    }

    return selected.size === 1 ? [...selected][0] : null
  }
}

function tokenize(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[^A-Z0-9_]+/)
    .filter(Boolean)
}

/** Render a held request for a chat channel, with its numbered options. */
export function formatPermissionPrompt(pending: PendingPermission, trigger: string): string {
  const seconds = Math.max(1, Math.round((pending.expiresAt - pending.createdAt) / 1000))
  const lines = [
    `Permission requested: ${pending.title}`,
    `Reply with: ${trigger} ${pending.token} <number>`,
    "",
    ...pending.options.map((option, index) => `${index + 1}. ${option.name}`),
    "",
    `Expires in ${seconds}s; no reply denies it.`,
  ]
  return lines.join("\n")
}
