#!/usr/bin/env bun
/**
 * ai-bridge-relay: the host process between the chat connectors and the
 * Vibeterm coordinator sessions. See relay.ts for what it does.
 *
 * Usage: bun src/relay/main.ts --config <relay.json>
 */

import { spawnSync } from "child_process"
import { loadRelayConfig } from "./config"
import { Relay } from "./relay"
import { startRelayServer } from "./server"
import { VibetermApi, vibetermSecretsPassword } from "./vibeterm-api"

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

async function main(): Promise<void> {
  const configPath = argument("--config") ?? process.env.AI_BRIDGE_RELAY_CONFIG
  if (!configPath) {
    console.error("usage: bun src/relay/main.ts --config <relay.json>")
    process.exit(2)
  }
  const config = loadRelayConfig(configPath)
  const api = new VibetermApi({
    url: config.api.url,
    username: config.api.username,
    password: vibetermSecretsPassword(config.api.secretsModule),
  })
  const relay = new Relay(api, { stateDir: config.stateDir, routes: config.routes, pollIntervalMs: config.pollIntervalMs })

  console.log(`[RELAY] ai-bridge-relay ${revision()} starting; state ${config.stateDir}`)
  for (const [route, settings] of Object.entries(config.routes)) {
    console.log(`[RELAY] route ${route}: ${settings?.enabled ? "enabled" : "disabled"} -> ${settings?.sessionID}`)
  }
  await relay.start()
  const server = startRelayServer(relay, config.socketPath)
  console.log(`[RELAY] listening on ${config.socketPath}`)

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`[RELAY] ${signal}: stopping`)
    relay.stop()
    server.stop(true)
    process.exit(0)
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch((error) => {
  console.error("[RELAY] fatal:", error instanceof Error ? error.message : error)
  process.exit(1)
})
