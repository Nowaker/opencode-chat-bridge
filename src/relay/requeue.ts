#!/usr/bin/env bun
/**
 * Hand a definitely refused relay back to the running relay, which redelivers
 * it under its original key (see `Relay.processRequeues`). The message text is
 * read from stdin exactly as the connector handed it over, so pipe it with
 * `printf '%s'`: a trailing newline changes its hash and the relay refuses it.
 *
 * Usage: printf '%s' "<text>" | bun src/relay/requeue.ts --config <relay.json> <relayId>
 */

import { mkdirSync, renameSync, writeFileSync } from "fs"
import { join } from "path"
import { loadRelayConfig } from "./config"

const USAGE = `usage: printf '%s' "<text>" | bun src/relay/requeue.ts --config <relay.json> <relayId>`

const args = process.argv.slice(2)
const configAt = args.indexOf("--config")
const configPath = configAt === -1 ? process.env.AI_BRIDGE_RELAY_CONFIG : args[configAt + 1]
const relayId = args.find((_, index) => index !== configAt && index !== configAt + 1)
if (!configPath || !relayId || !/^rly_[a-z0-9]+$/.test(relayId)) {
  console.error(USAGE)
  process.exit(2)
}

const text = await Bun.stdin.text()
const dir = join(loadRelayConfig(configPath).stateDir, "requeue")
mkdirSync(dir, { recursive: true, mode: 0o700 })
const target = join(dir, `${relayId}.json`)
const staging = `${target}.tmp-${process.pid}`
writeFileSync(staging, JSON.stringify({ text }), { mode: 0o600 })
renameSync(staging, target)
console.log(`queued ${relayId}; within one poll the relay logs "requeued ${relayId}" or why it refused`)
