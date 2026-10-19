#!/usr/bin/env bun
/**
 * Service profiles: the hints a request inherits by naming its service
 * (contract section 2). The file is private (0600), because a profile names
 * the sender a provider's codes come from.
 *
 * Run directly, this writes one profile, reading senders from a private JSON
 * file at a JSON pointer, inside the process. It prints counts, never a value:
 *
 *   bun src/otp/profiles.ts --profiles FILE --service spruce \
 *     --senders-from DISCOVERY.json --pointer /candidates/0/sender --body-pattern Spruce
 */

import { existsSync } from "fs"
import { resolve } from "path"
import type { Profile } from "./broker"
import { checkPattern, hasHints, normalizeSender } from "./match"
import { readPrivateText, writePrivateText } from "./private-files"

const SERVICE = /^[a-z0-9][a-z0-9_.-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
}

export function parseProfiles(text: string): Record<string, Profile> {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error("profiles must be an object of service names")
  const profiles: Record<string, Profile> = {}
  for (const [service, profile] of Object.entries(value)) {
    if (!SERVICE.test(service) || !isRecord(profile)) throw new Error(`profile ${service} is malformed`)
    const { senders, bodyPattern, packages, codePattern } = profile
    if (senders !== undefined && !strings(senders)) throw new Error(`profile ${service}: senders`)
    if (packages !== undefined && !strings(packages)) throw new Error(`profile ${service}: packages`)
    if (bodyPattern !== undefined && typeof bodyPattern !== "string") throw new Error(`profile ${service}: bodyPattern`)
    if (codePattern !== undefined && typeof codePattern !== "string") throw new Error(`profile ${service}: codePattern`)
    if (bodyPattern !== undefined) checkPattern(bodyPattern, `profile ${service}: bodyPattern`)
    if (codePattern !== undefined) checkPattern(codePattern, `profile ${service}: codePattern`)
    const parsed: Profile = {
      ...(senders === undefined ? {} : { senders }),
      ...(bodyPattern === undefined ? {} : { bodyPattern }),
      ...(packages === undefined ? {} : { packages }),
      ...(codePattern === undefined ? {} : { codePattern }),
    }
    if (!hasHints({ senders: parsed.senders ?? [], bodyPattern: parsed.bodyPattern ?? null, packages: parsed.packages ?? [], codePattern: "" })) {
      throw new Error(`profile ${service} has no hints`)
    }
    profiles[service] = parsed
  }
  return profiles
}

/** RFC 6901. */
export function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document
  if (!pointer.startsWith("/")) throw new Error("a JSON pointer starts with /")
  let current = document
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(token)) current = current[Number(token)]
    else if (isRecord(current)) current = current[token]
    else current = undefined
    if (current === undefined) throw new Error("the pointer does not resolve")
  }
  return current
}

function main(argv: string[]): number {
  const single = new Map<string, string>()
  const packages: string[] = []
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    const value = argv[i + 1]
    if (!name?.startsWith("--") || value === undefined) {
      console.error("usage: profiles.ts --profiles FILE --service NAME [--senders-from FILE --pointer PTR] [--body-pattern RE] [--package P]... [--code-pattern RE]")
      return 2
    }
    if (name === "--package") packages.push(value)
    else single.set(name, value)
  }
  const file = single.get("--profiles")
  const service = single.get("--service")
  if (!file || !service || !SERVICE.test(service)) {
    console.error("profiles.ts: --profiles and a valid --service are required")
    return 2
  }

  let senders: string[] = []
  const from = single.get("--senders-from")
  if (from) {
    const value = resolvePointer(JSON.parse(readPrivateText(from)), single.get("--pointer") ?? "")
    const list = typeof value === "string" ? [value] : value
    if (!strings(list)) {
      console.error("profiles.ts: the pointer does not name a sender string or a list of them")
      return 1
    }
    senders = [...new Set(list.map(normalizeSender).filter(Boolean))]
  }

  const profiles = existsSync(file) ? parseProfiles(readPrivateText(file)) : {}
  const profile: Profile = {
    ...(senders.length > 0 ? { senders } : {}),
    ...(single.has("--body-pattern") ? { bodyPattern: single.get("--body-pattern") } : {}),
    ...(packages.length > 0 ? { packages } : {}),
    ...(single.has("--code-pattern") ? { codePattern: single.get("--code-pattern") } : {}),
  }
  // Validated through the same parser the broker uses, before anything is written.
  const next = parseProfiles(JSON.stringify({ ...profiles, [service]: profile }))
  writePrivateText(file, JSON.stringify(next, null, 2) + "\n")
  console.log(
    `profile ${service}: ${senders.length} sender(s), body pattern ${profile.bodyPattern ? "set" : "none"}, ` +
      `${packages.length} package(s), code pattern ${profile.codePattern ? "custom" : "default"} -> ${resolve(file)}`,
  )
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
