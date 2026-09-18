/**
 * Unit tests for permission-broker.ts
 */

import { describe, test, expect, beforeEach } from "bun:test"
import {
  PermissionBroker,
  formatPermissionPrompt,
  generateCorrelationToken,
  resolveRejectOption,
  type PermissionOption,
} from "../../src/permission-broker"

const OPTIONS: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

const OWNER = "owner-1"
const THREAD = "C0C2U4Q51HP:1712345678.0001"

describe("PermissionBroker", () => {
  let now: number
  let broker: PermissionBroker

  beforeEach(() => {
    now = 1_000_000
    broker = new PermissionBroker({
      timeoutMs: 180_000,
      authorize: (senderId) => senderId === OWNER,
      now: () => now,
    })
  })

  function hold() {
    return broker.create({
      requestId: 42,
      title: "edit src/config.ts",
      threadId: THREAD,
      options: OPTIONS,
    })
  }

  test("accepts a correctly correlated and authenticated reply", () => {
    const pending = hold()

    const outcome = broker.resolveReply({
      text: `${pending.token} 1`,
      senderId: OWNER,
      threadId: THREAD,
    })

    expect(outcome.status).toBe("accepted")
    if (outcome.status !== "accepted") throw new Error("unreachable")
    expect(outcome.optionId).toBe("once")
    expect(broker.size).toBe(0)
  })

  test("accepts a reply that names the option by id", () => {
    const pending = hold()

    const outcome = broker.resolveReply({
      text: `approve ${pending.token} always please`,
      senderId: OWNER,
      threadId: THREAD,
    })

    expect(outcome.status).toBe("accepted")
    if (outcome.status !== "accepted") throw new Error("unreachable")
    expect(outcome.optionId).toBe("always")
  })

  test("is case-insensitive about the token", () => {
    const pending = hold()

    const outcome = broker.resolveReply({
      text: `${pending.token.toLowerCase()} 2`,
      senderId: OWNER,
      threadId: THREAD,
    })

    expect(outcome.status).toBe("accepted")
  })

  test("rejects a reply from a sender who is not allowlisted", () => {
    const pending = hold()

    const outcome = broker.resolveReply({
      text: `${pending.token} 1`,
      senderId: "intruder",
      threadId: THREAD,
    })

    expect(outcome.status).toBe("wrong_sender")
    expect(broker.size).toBe(1)
  })

  test("rejects a reply that arrives in a different thread", () => {
    const pending = hold()

    const outcome = broker.resolveReply({
      text: `${pending.token} 1`,
      senderId: OWNER,
      threadId: "C0C2U4Q51HP:9999999999.0002",
    })

    expect(outcome.status).toBe("wrong_thread")
    expect(broker.size).toBe(1)
  })

  test("rejects a stale token that no longer matches a held request", () => {
    const pending = hold()
    broker.settle(pending.token)

    const outcome = broker.resolveReply({
      text: `${pending.token} 1`,
      senderId: OWNER,
      threadId: THREAD,
    })

    expect(outcome.status).toBe("unknown_token")
  })

  test("cannot settle the same request twice", () => {
    const pending = hold()
    const reply = { text: `${pending.token} 1`, senderId: OWNER, threadId: THREAD }

    expect(broker.resolveReply(reply).status).toBe("accepted")
    expect(broker.resolveReply(reply).status).toBe("unknown_token")
  })

  test("rejects a reply that arrives after the window closed", () => {
    const pending = hold()
    now += 180_001

    const outcome = broker.resolveReply({
      text: `${pending.token} 1`,
      senderId: OWNER,
      threadId: THREAD,
    })

    expect(outcome.status).toBe("expired")
  })

  test("never treats ambiguous free text as an approval", () => {
    const pending = hold()

    for (const text of [
      `${pending.token} yes go ahead`,
      `${pending.token} sure, whatever you think`,
      `${pending.token} ok`,
      `${pending.token}`,
      `${pending.token} 1 and also 2`,
      `${pending.token} 99`,
    ]) {
      const outcome = broker.resolveReply({ text, senderId: OWNER, threadId: THREAD })
      expect(outcome.status).toBe("ambiguous")
    }

    expect(broker.size).toBe(1)
  })

  test("ignores an ordinary message that names no token", () => {
    hold()

    const outcome = broker.resolveReply({
      text: "1",
      senderId: OWNER,
      threadId: THREAD,
    })

    expect(outcome.status).toBe("no_token")
    expect(broker.size).toBe(1)
  })

  test("refuses to act when two different tokens are named", () => {
    const first = hold()
    const second = hold()

    const outcome = broker.resolveReply({
      text: `${first.token} ${second.token} 1`,
      senderId: OWNER,
      threadId: THREAD,
    })

    expect(outcome.status).toBe("no_token")
    expect(broker.size).toBe(2)
  })

  test("checks the sender before parsing a decision", () => {
    const pending = hold()

    const outcome = broker.resolveReply({
      text: `${pending.token} nonsense`,
      senderId: "intruder",
      threadId: THREAD,
    })

    expect(outcome.status).toBe("wrong_sender")
  })

  test("takeExpired removes only requests past their window", () => {
    const first = hold()
    now += 100_000
    const second = hold()
    now += 100_000

    const expired = broker.takeExpired()

    expect(expired.map((entry) => entry.token)).toEqual([first.token])
    expect(broker.size).toBe(1)
    expect(broker.get(second.token)).toBeDefined()
  })

  test("takeAll drains everything for shutdown", () => {
    hold()
    hold()

    expect(broker.takeAll()).toHaveLength(2)
    expect(broker.size).toBe(0)
  })

  test("issues a distinct token per request", () => {
    const tokens = new Set([hold().token, hold().token, hold().token])
    expect(tokens.size).toBe(3)
  })
})

describe("generateCorrelationToken", () => {
  test("avoids characters that are misread on a phone screen", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCorrelationToken()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
    }
  })
})

describe("resolveRejectOption", () => {
  test("prefers the agent's explicit reject option", () => {
    expect(resolveRejectOption(OPTIONS)).toBe("reject")
  })

  test("finds a reject option by kind when the id differs", () => {
    expect(resolveRejectOption([
      { optionId: "yes", kind: "allow_once", name: "Yes" },
      { optionId: "no-thanks", kind: "reject_always", name: "No" },
    ])).toBe("no-thanks")
  })

  test("falls back to an id opencode does not treat as approval", () => {
    expect(resolveRejectOption([])).toBe("reject")
  })
})

describe("formatPermissionPrompt", () => {
  test("numbers the options and names the token", () => {
    const broker = new PermissionBroker({ timeoutMs: 60_000, authorize: () => true })
    const pending = broker.create({
      requestId: "r1",
      title: "edit src/config.ts",
      threadId: THREAD,
      options: OPTIONS,
    })

    const prompt = formatPermissionPrompt(pending, "!oc")

    expect(prompt).toContain(pending.token)
    expect(prompt).toContain("1. Allow once")
    expect(prompt).toContain("2. Always allow")
    expect(prompt).toContain("3. Reject")
    expect(prompt).toContain("Expires in 60s")
  })
})
