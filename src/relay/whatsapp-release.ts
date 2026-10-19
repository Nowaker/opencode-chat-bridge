#!/usr/bin/env bun
/**
 * Release a WhatsApp message the relay holds for review, or discard it (see
 * `WhatsAppNativeDriver`). A release only moves the held record; the running
 * relay checks it again (its verdict, anything that invalidated it since, the
 * app generation, the time left before the reply deadline) before it prompts
 * the coordinator, and logs "release of sN: ..." either way.
 *
 * Usage: bun src/relay/whatsapp-release.ts --config <relay.json> [--discard] s<sequence>
 */

import { existsSync, lstatSync, mkdirSync, renameSync } from "fs"
import { join } from "path"
import { loadRelayConfig } from "./config"

const USAGE = "usage: bun src/relay/whatsapp-release.ts --config <relay.json> [--discard] s<sequence>"

const args = process.argv.slice(2)
const configAt = args.indexOf("--config")
const configPath = configAt === -1 ? process.env.AI_BRIDGE_RELAY_CONFIG : args[configAt + 1]
const discard = args.includes("--discard")
const name = args.find((arg, index) => (configAt === -1 || index !== configAt + 1) && /^s\d+$/.test(arg))
if (!configPath || !name) {
  console.error(USAGE)
  process.exit(2)
}

const base = join(loadRelayConfig(configPath).stateDir, "whatsapp")
const held = join(base, "held", `${name}.json`)
if (!existsSync(held) || !lstatSync(held).isFile()) {
  console.error(`${name} is not held (never held, or already released or discarded)`)
  process.exit(1)
}
const target = join(base, discard ? "discarded" : "release")
mkdirSync(target, { recursive: true, mode: 0o700 })
renameSync(held, join(target, `${name}.json`))
console.log(
  discard
    ? `discarded ${name}; it will not be prompted or answered`
    : `released ${name}; within one poll the relay logs "release of ${name}: ..." with the outcome`,
)
