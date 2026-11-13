/**
 * Which invites the bot accepts. matrix-bot-sdk's AutojoinRoomsMixin joins any
 * room anyone invites it to; the bot decrypts what it reads there, so only an
 * invite from an allowlisted user is accepted, and every other one is rejected
 * (leaving a room the bot is only invited to declines the invite).
 */

export type InviteDecision = { join: true; inviter: string } | { join: false; reason: string }

export function inviteDecision(event: unknown, botUserId: string, allowed: (userId: string) => boolean): InviteDecision {
  if (typeof event !== "object" || event === null) return { join: false, reason: "malformed invite" }
  const sender = "sender" in event ? event.sender : undefined
  const stateKey = "state_key" in event ? event.state_key : undefined
  if (typeof sender !== "string" || !sender) return { join: false, reason: "invite names no sender" }
  if (stateKey !== botUserId) return { join: false, reason: "invite is not for this bot" }
  if (!allowed(sender)) return { join: false, reason: "inviter is not allowlisted" }
  return { join: true, inviter: sender }
}
