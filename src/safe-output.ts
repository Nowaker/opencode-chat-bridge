/**
 * Safe output filtering.
 *
 * Chat gets a structured, bounded summary of a tool call -- never its raw
 * arguments and never its raw result. Both the tool name and each argument
 * field must be allowlisted before any value reaches the channel.
 */

import type { ToolSummariesConfig } from "./config"

export const REDACTION_PLACEHOLDER = "[redacted]"

interface SecretRule {
  pattern: RegExp
  replace: (...args: string[]) => string
}

const maskWholeMatch = () => REDACTION_PLACEHOLDER

/**
 * A value that is already the placeholder, or a prefix of it left by a value
 * terminator eating the closing bracket. Redaction must be idempotent: a
 * summarized field is redacted once here and again when the assembled message
 * passes the connector's send boundary.
 */
function isRedacted(value: string): boolean {
  return value.startsWith(REDACTION_PLACEHOLDER) || REDACTION_PLACEHOLDER.startsWith(value)
}

/**
 * Credential shapes that are masked wherever they appear, including inside an
 * allowlisted field. Ordering matters: the specific vendor shapes run before
 * the generic assignment rule so a match is not partially consumed.
 */
const SECRET_RULES: SecretRule[] = [
  { pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, replace: maskWholeMatch },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, replace: maskWholeMatch },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, replace: maskWholeMatch },
  { pattern: /\bxapp-[A-Za-z0-9-]{8,}/g, replace: maskWholeMatch },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: maskWholeMatch },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: maskWholeMatch },
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: maskWholeMatch },
  { pattern: /\bnpm_[A-Za-z0-9]{28,}/g, replace: maskWholeMatch },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: maskWholeMatch },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: maskWholeMatch },
  { pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g, replace: maskWholeMatch },
  {
    // Credentials embedded in a URL's userinfo, e.g. https://user:token@host.
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g,
    replace: (_match, scheme) => `${scheme}${REDACTION_PLACEHOLDER}@`,
  },
  {
    pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    replace: (_match, scheme) => `${scheme} ${REDACTION_PLACEHOLDER}`,
  },
  {
    // NAME=value where the name itself announces a secret.
    pattern: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;)}\]]+)/gi,
    replace: (match, name, separator, value) =>
      isRedacted(value) ? match : `${name}${separator}${REDACTION_PLACEHOLDER}`,
  },
]

/**
 * Mask credential-shaped substrings.
 *
 * This is a backstop, not the primary control -- the allowlists are. It runs
 * on everything the bridge emits so that a value which is legitimately
 * allowlisted still cannot carry a token out to the chat channel.
 */
export function redactSecrets(text: string): string {
  let output = text
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0
    output = output.replace(rule.pattern, rule.replace as (substring: string, ...args: any[]) => string)
  }
  return output
}

/**
 * Whether a tool name is allowlisted. Entries match exactly, or as a `prefix*`
 * glob so a whole tool family such as `vibeterm_*` can be named at once. A `*`
 * anywhere other than the final character is not a wildcard.
 */
export function matchesToolAllowlist(toolName: string, allowedTools: readonly string[]): boolean {
  if (!toolName) return false
  return allowedTools.some((entry) => {
    const pattern = entry.trim()
    if (!pattern) return false
    if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1))
    return toolName === pattern
  })
}

/**
 * Render one argument value.
 *
 * Arrays and objects collapse to a shape description rather than their
 * contents: an allowlisted field name says the field is safe to mention, not
 * that every value nested inside it is safe to publish.
 */
function formatValue(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>)
    return `{${keys.length} field${keys.length === 1 ? "" : "s"}}`
  }

  const collapsed = redactSecrets(String(value)).replace(/\s+/g, " ").trim()
  if (!collapsed) return null
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`
}

export interface ToolSummaryOptions extends ToolSummariesConfig {}

/**
 * Build the chat-visible summary of a tool call.
 *
 * Returns null when nothing should be said at all. An unlisted tool yields at
 * most its name, never its arguments.
 */
export function summarizeToolCall(
  toolName: string,
  args: unknown,
  options: ToolSummaryOptions,
): string | null {
  const name = toolName || "unknown"

  if (!matchesToolAllowlist(name, options.allowedTools)) {
    return options.unlistedTools === "hide" ? null : `ran ${name}`
  }

  const fields: string[] = []
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>
    for (const field of options.allowedFields) {
      if (!(field in record)) continue
      const rendered = formatValue(record[field], options.maxFieldLength)
      if (rendered !== null) fields.push(`${field}=${rendered}`)
    }
  }

  return fields.length > 0 ? `${fields.join(", ")} [${name}]` : `[${name}]`
}
