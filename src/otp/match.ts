/**
 * What a login request asks for (its hints), how an event is tested against
 * them, how a code is read out of a body, and the leases that keep two open
 * requests from asking for the same thing (contract section 2).
 */

export const DEFAULT_CODE_PATTERN = "\\b\\d{4,8}\\b"

export interface Hints {
  /** Normalized with `normalizeSender`. */
  senders: string[]
  /** Matched case-insensitively against the body. */
  bodyPattern: string | null
  packages: string[]
  codePattern: string
}

export interface EventContent {
  number: string
  body: string
  package: string | null
}

/** Sender addresses compare without formatting: whitespace, dashes, dots and brackets dropped, letters lowercased. */
export function normalizeSender(value: string): string {
  return value.replace(/[\s\-().]/g, "").toLowerCase()
}

export function hasHints(hints: Hints): boolean {
  return hints.senders.length > 0 || hints.bodyPattern !== null || hints.packages.length > 0
}

/** The hints an event fails, by name; empty when it matches all of them. */
export function hintFailures(hints: Hints, event: EventContent): string[] {
  const failed: string[] = []
  if (hints.senders.length > 0 && !hints.senders.includes(normalizeSender(event.number))) failed.push("sender")
  if (hints.bodyPattern !== null && !new RegExp(hints.bodyPattern, "i").test(event.body)) failed.push("body")
  if (hints.packages.length > 0 && !(event.package !== null && hints.packages.includes(event.package))) failed.push("package")
  return failed
}

/** Restricts a code to what an `OTP_CODE=` line can carry unquoted. */
const CODE_SHAPE = /^[A-Za-z0-9-]{1,64}$/

/**
 * The one distinct code in `body`, or null. The pattern's first capture group
 * is the code when it has one, otherwise the whole match. Two different
 * matches in one body are no code at all: guessing which one is the code would
 * be guessing.
 */
export function extractCode(pattern: string, body: string): string | null {
  const values = new Set<string>()
  for (const match of body.matchAll(new RegExp(pattern, "g"))) {
    const value = match[1] ?? match[0]
    if (!value) continue
    values.add(value)
    if (values.size > 1) return null
  }
  const [code] = values
  return code !== undefined && CODE_SHAPE.test(code) ? code : null
}

/** Throws with the field name when a pattern does not compile. */
export function checkPattern(pattern: string, field: string): void {
  try {
    new RegExp(pattern, "g")
  } catch {
    throw new Error(`${field} is not a valid regular expression`)
  }
}

/**
 * Lease keys (v1.2): the (service, account) pair, every sender, every
 * package, and the service itself for a request with only a body pattern.
 * Test and real requests lease separately, because a test event can only ever
 * match a test request.
 */
export function leaseKeys(request: { service: string; account: string; test: boolean; hints: Hints }): string[] {
  const scope = request.test ? "test" : "real"
  const key = (...parts: string[]) => [scope, ...parts].join("\u0000")
  const keys = [key("account", request.service, request.account.trim().toLowerCase())]
  for (const sender of request.hints.senders) keys.push(key("sender", sender))
  for (const pkg of request.hints.packages) keys.push(key("package", pkg))
  if (request.hints.senders.length === 0 && request.hints.packages.length === 0) keys.push(key("service", request.service))
  return keys
}
