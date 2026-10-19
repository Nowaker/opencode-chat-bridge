#!/usr/bin/env bun
/**
 * ai-bridge-otp: the OTP broker. It takes the SMS Forward app's signed
 * webhook on a loopback port and serves the `ai-bridge-otp` CLI on a private
 * Unix socket; see broker.ts for how a code reaches exactly one requester.
 *
 * Usage: bun src/otp/main.ts --state-dir DIR --listen 127.0.0.1:PORT
 *          [--socket PATH] [--key-file PATH] [--profiles PATH]
 *
 * The state directory (0700) holds `otp.sqlite`, and by default
 * `webhook-signing-key`, `profiles.json` and `broker.sock`.
 */

import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { join } from "path"
import { startApiServer } from "./api"
import { Broker, BrokerError } from "./broker"
import { ensurePrivateDir, readPrivateText } from "./private-files"
import { parseProfiles } from "./profiles"
import { openStore } from "./store"
import { startWebhookServer, webhookHandler } from "./webhook"

const PURGE_INTERVAL_MS = 60_000

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** The commit this process runs, so a log line can always name the code behind it. */
function revision(): string {
  const git = (...args: string[]) => spawnSync("git", ["-C", import.meta.dir, ...args], { encoding: "utf8" })
  const head = git("rev-parse", "--short", "HEAD")
  if (head.status !== 0) return "unknown"
  const dirty = git("status", "--porcelain", "--", ".").stdout.trim() !== ""
  return `${head.stdout.trim()}${dirty ? "-dirty" : ""}`
}

export function parseListen(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value)
  const port = Number(match?.[3])
  if (!match || !Number.isInteger(port) || port > 65535) throw new Error(`--listen ${value} is not HOST:PORT`)
  return { host: match[1] ?? match[2], port }
}

function main(): void {
  const stateDir = argument("--state-dir")
  const listen = argument("--listen")
  if (!stateDir || !listen) {
    console.error("usage: bun src/otp/main.ts --state-dir DIR --listen 127.0.0.1:PORT [--socket PATH] [--key-file PATH] [--profiles PATH]")
    process.exit(2)
  }
  ensurePrivateDir(stateDir)
  const keyFile = argument("--key-file") ?? join(stateDir, "webhook-signing-key")
  const socketPath = argument("--socket") ?? join(stateDir, "broker.sock")
  const profilesFile = argument("--profiles") ?? join(stateDir, "profiles.json")
  const { host, port } = parseListen(listen)

  const key = readPrivateText(keyFile).trim()
  if (key.length < 32) throw new Error(`${keyFile} holds no usable key`)
  const loadProfiles = () => {
    if (!existsSync(profilesFile)) return {}
    try {
      return parseProfiles(readPrivateText(profilesFile))
    } catch (error) {
      throw new BrokerError(`the profiles file is unusable: ${error instanceof Error ? error.message : String(error)}`, "invalid")
    }
  }
  const profileCount = Object.keys(loadProfiles()).length

  // The database first: its exclusive lock refuses a second broker before it touches the socket.
  const db = openStore(join(stateDir, "otp.sqlite"))
  const broker = new Broker(db, { profiles: loadProfiles })
  broker.purge()
  const webhook = startWebhookServer(webhookHandler(broker, key), host, port)
  const api = startApiServer(broker, socketPath)
  console.log(`[OTP] ai-bridge-otp ${revision()} on ${host}:${webhook.port} and ${socketPath}; state ${stateDir}; ${profileCount} profile(s)`)

  const timer = setInterval(() => {
    try {
      const purged = broker.purge()
      if (purged.codes || purged.events || purged.requests) {
        console.log(`[OTP] purged ${purged.codes} code(s), ${purged.events} delivery record(s), ${purged.requests} request(s)`)
      }
    } catch (error) {
      console.error("[OTP] purge failed:", error instanceof Error ? error.message : error)
    }
  }, PURGE_INTERVAL_MS)

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`[OTP] ${signal}: stopping`)
    clearInterval(timer)
    broker.stop()
    webhook.stop(true)
    api.stop(true)
    db.close()
    process.exit(0)
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error("[OTP] fatal:", error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
