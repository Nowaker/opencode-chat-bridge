/**
 * The provenance block a relayed message is wrapped in, and the parser that
 * finds the relay id in it again.
 *
 * The block is the first thing in the prompt for two reasons. The coordinator
 * reads who sent it and how far to trust it before the text itself. And the
 * prompt never starts with the chat text, so a message reading "/compact" is
 * never mistaken for a TUI command when vibeterm-api has to type it into a pane.
 *
 * The relay id is also how a reply finds its way back: the watcher reads the
 * parent user message of a finished turn, and a known id there routes the
 * answer into that message's thread.
 */

import type { RelayRoute } from "./types"

export const BLOCK_START = "[chat_relay]"
export const BLOCK_END = "[/chat_relay]"
const RELAY_ID = /^rly_[A-Za-z0-9]+$/

export interface Provenance {
  route: RelayRoute
  /** Already safe to show: public ids for Matrix, labels for WhatsApp. */
  chat: string
  sender: string
  event: string
  /** "" when the message started a new thread. */
  thread: string
  relayId: string
  postedAt: number
  trust: "operator"
  replyHint: string
}

/** Strip anything that would let chat text end the block early or forge a field. */
function field(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll(BLOCK_END, "").trim()
}

export function buildRelayPrompt(p: Provenance, text: string): string {
  const lines = [
    BLOCK_START,
    `channel: ${field(p.route)}`,
    `chat: ${field(p.chat)}`,
    `sender: ${field(p.sender)}`,
    `trust: ${p.trust}`,
    `event: ${field(p.event)}`,
    `thread: ${p.thread ? field(p.thread) : "new"}`,
    `relay_id: ${p.relayId}`,
    `posted: ${new Date(p.postedAt).toISOString()}`,
    `reply: ${field(p.replyHint)}`,
    BLOCK_END,
    "",
    text,
  ]
  return lines.join("\n")
}

/**
 * The relay id of a persisted user message, or null. Only a block at the very
 * start counts: a block quoted further down a message is somebody's text.
 */
export function parseRelayId(text: string): string | null {
  if (!text.startsWith(BLOCK_START + "\n")) return null
  const end = text.indexOf("\n" + BLOCK_END)
  if (end === -1) return null
  for (const line of text.slice(BLOCK_START.length + 1, end).split("\n")) {
    const match = /^relay_id: (\S+)$/.exec(line)
    if (match && RELAY_ID.test(match[1])) return match[1]
  }
  return null
}

export function isRelayId(value: string): boolean {
  return RELAY_ID.test(value)
}
