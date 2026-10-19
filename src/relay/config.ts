/**
 * The relay's configuration file.
 *
 * Allowlists can be named by an env-file key instead of written out, so the
 * relay reads the same `MATRIX_ALLOWED_*` values as the container that already
 * enforces them, and private ids stay out of the config file. Only the named
 * keys are read from that file; it also holds credentials the relay never needs.
 */

import { readFileSync } from "fs"
import { homedir } from "os"
import { isRelayRoute, type RelayRoute } from "./types"
import type { RouteConfig } from "./relay"

interface RouteFile {
  enabled?: boolean
  sessionID?: string
  allowedUsers?: string[]
  allowedUsersFrom?: string
  allowedRooms?: string[]
  allowedRoomsFrom?: string
  defaultRoom?: string
  repliesOnly?: boolean
  idsInPrompt?: boolean
  chatLabel?: string
}

interface RelayFile {
  socketPath?: string
  stateDir?: string
  envFile?: string
  pollIntervalMs?: number
  vibetermApi?: { url?: string; username?: string; secretsModule?: string }
  routes?: Record<string, RouteFile>
}

export interface LoadedRelayConfig {
  socketPath: string
  stateDir: string
  pollIntervalMs: number
  api: { url: string; username: string; secretsModule: string }
  routes: Partial<Record<RelayRoute, RouteConfig>>
}

function expand(path: string): string {
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path
}

export function readEnvKeys(path: string, keys: readonly string[]): Record<string, string> {
  const wanted = new Set(keys)
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match || !wanted.has(match[1])) continue
    let value = match[2].trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    out[match[1]] = value
  }
  return out
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean)
}

export function loadRelayConfig(path: string): LoadedRelayConfig {
  const file = JSON.parse(readFileSync(path, "utf8")) as RelayFile
  const required = (value: string | undefined, name: string) => {
    if (!value) throw new Error(`relay config: ${name} is required`)
    return expand(value)
  }
  const socketPath = required(file.socketPath, "socketPath")
  const stateDir = required(file.stateDir, "stateDir")
  const secretsModule = required(file.vibetermApi?.secretsModule, "vibetermApi.secretsModule")

  const routeFiles = Object.entries(file.routes ?? {})
  const envKeys = routeFiles.flatMap(([, r]) => [r.allowedUsersFrom, r.allowedRoomsFrom]).filter((k): k is string => Boolean(k))
  const env = envKeys.length ? readEnvKeys(required(file.envFile, "envFile"), envKeys) : {}

  const routes: Partial<Record<RelayRoute, RouteConfig>> = {}
  for (const [name, route] of routeFiles) {
    if (!isRelayRoute(name)) throw new Error(`relay config: unknown route ${name}`)
    const sessionID = route.sessionID ?? ""
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) throw new Error(`relay config: routes.${name}.sessionID is not a session id`)
    const allowedUsers = route.allowedUsers ?? list(route.allowedUsersFrom ? env[route.allowedUsersFrom] : undefined)
    const allowedRooms = route.allowedRooms ?? list(route.allowedRoomsFrom ? env[route.allowedRoomsFrom] : undefined)
    const enabled = route.enabled === true
    // An enabled route with an empty allowlist would refuse everything in
    // silence; say so at startup instead.
    if (enabled && (allowedUsers.length === 0 || allowedRooms.length === 0)) {
      throw new Error(`relay config: routes.${name} is enabled with an empty allowlist`)
    }
    routes[name] = {
      enabled,
      sessionID,
      allowedUsers,
      allowedRooms,
      defaultRoom: route.defaultRoom ?? allowedRooms[0] ?? "",
      repliesOnly: route.repliesOnly === true,
      idsInPrompt: route.idsInPrompt !== false,
      ...(route.chatLabel ? { chatLabel: route.chatLabel } : {}),
    }
  }

  return {
    socketPath,
    stateDir,
    pollIntervalMs: file.pollIntervalMs ?? 3_000,
    api: {
      url: file.vibetermApi?.url ?? "http://127.0.0.1:6096",
      username: file.vibetermApi?.username ?? "opencode",
      secretsModule,
    },
    routes,
  }
}
