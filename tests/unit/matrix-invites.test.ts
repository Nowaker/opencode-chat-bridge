import { describe, expect, test } from "bun:test"
import { inviteDecision } from "../../connectors/matrix-invites"

const BOT = "@bot:example.org"
const OWNER = "@owner:example.org"
const allowed = (userId: string) => userId === OWNER

describe("invites", () => {
  test("only an allowlisted user's invite to this bot is accepted", () => {
    expect(inviteDecision({ sender: OWNER, state_key: BOT }, BOT, allowed)).toEqual({ join: true })
    expect(inviteDecision({ sender: "@stranger:example.org", state_key: BOT }, BOT, allowed)).toEqual({ join: false, reason: "inviter is not allowlisted" })
    expect(inviteDecision({ sender: OWNER, state_key: "@other:example.org" }, BOT, allowed)).toEqual({ join: false, reason: "invite is not for this bot" })
    expect(inviteDecision({ state_key: BOT }, BOT, allowed)).toEqual({ join: false, reason: "invite names no sender" })
    expect(inviteDecision(null, BOT, allowed)).toEqual({ join: false, reason: "malformed invite" })
  })
})
