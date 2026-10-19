#!/usr/bin/env bun
/**
 * ai-bridge-relay: the host process between the chat connectors and the
 * Vibeterm coordinator sessions. See relay.ts for what it does.
 *
 * Usage: bun src/relay/main.ts --config <relay.json>
 */

import { spawnSync } from "child_process"
import { readFileSync } from "fs"
import { join, resolve } from "path"
import { loadRelayConfig, type LoadedRelayConfig } from "./config"
import { Relay } from "./relay"
import { startRelayServer } from "./server"
import { VibetermApi, vibetermSecretsPassword } from "./vibeterm-api"
import { nativeClient, nativeReplySender, WhatsAppNativeDriver } from "./whatsapp-native"

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

/** A WhatsApp problem leaves that route down and the rest serving; it never stops the relay. */
async function startWhatsApp(config: LoadedRelayConfig, configPath: string, relay: Relay, api: VibetermApi): Promise<WhatsAppNativeDriver | null> {
  const route = config.routes.whatsapp
  const native = config.whatsappNative
  if (!route?.enabled || !native) return null
  try {
    const capability = JSON.parse(readFileSync(native.capabilityFile, "utf8"))
    if (
      typeof capability?.capability_id !== "string" ||
      typeof capability?.conversation_id !== "string" ||
      !Number.isSafeInteger(capability?.expires_at) ||
      typeof capability?.prefix !== "string"
    ) {
      throw new Error("the reply capability reference is not one")
    }
    const call = nativeClient(native.clientModule)
    const driver = new WhatsAppNativeDriver({
      relay,
      call,
      sender: nativeReplySender(call),
      stateDir: join(config.stateDir, "whatsapp"),
      headFile: native.headFile,
      groupJid: route.allowedRooms[0],
      conversationId: capability.conversation_id,
      capabilityId: capability.capability_id,
      capabilityExpiresAt: capability.expires_at,
      ownerSender: route.allowedUsers[0],
      aiPrefix: capability.prefix,
      hold: native.hold,
      trigger: native.trigger,
      windowMs: native.replyWindowMs,
      safetyMarginMs: native.safetyMarginMs,
      minReleaseWindowMs: native.minReleaseWindowMs,
      ...(native.verifier ? { verifier: native.verifier } : {}),
      notifySessions: native.notifySessions,
      ...(native.wakeCoordinatorOnHold ? { coordinatorSession: route.sessionID } : {}),
      notify: (sessionID, key, text) => api.promptAsync(sessionID, key, text),
      releaseCommand: `bun ${join(import.meta.dir, "whatsapp-release.ts")} --config ${resolve(configPath)}`,
      pollIntervalMs: config.pollIntervalMs,
    })
    await driver.start()
    relay.healthExtras.set("whatsapp", () => driver.health())
    return driver
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[RELAY] whatsapp route not started: ${message}`)
    relay.healthExtras.set("whatsapp", () => ({ started: false, error: message }))
    return null
  }
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
  const whatsapp = await startWhatsApp(config, configPath, relay, api)

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`[RELAY] ${signal}: stopping`)
    whatsapp?.stop()
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
