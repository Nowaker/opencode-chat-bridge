/**
 * Unit tests for safe-output.ts
 */

import { describe, test, expect } from "bun:test"
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
  matchesToolAllowlist,
  summarizeToolCall,
  type ToolSummaryOptions,
} from "../../src/safe-output"

const options: ToolSummaryOptions = {
  allowedTools: ["vibeterm_*", "session_read", "todowrite", "task"],
  allowedFields: ["session", "title", "status", "count", "description"],
  maxFieldLength: 40,
  unlistedTools: "name",
}

describe("matchesToolAllowlist", () => {
  test("denies against an empty allowlist", () => {
    expect(matchesToolAllowlist("read", [])).toBe(false)
  })

  test("denies an empty tool name", () => {
    expect(matchesToolAllowlist("", ["read"])).toBe(false)
  })

  test("matches an exact entry", () => {
    expect(matchesToolAllowlist("todowrite", options.allowedTools)).toBe(true)
  })

  test("matches a trailing-star prefix", () => {
    expect(matchesToolAllowlist("vibeterm_spawn_session", options.allowedTools)).toBe(true)
    expect(matchesToolAllowlist("vibeterm_", options.allowedTools)).toBe(true)
  })

  test("does not match a substring or a suffix", () => {
    expect(matchesToolAllowlist("my_todowrite", options.allowedTools)).toBe(false)
    expect(matchesToolAllowlist("todowrite_evil", options.allowedTools)).toBe(false)
    expect(matchesToolAllowlist("not_vibeterm_spawn", options.allowedTools)).toBe(false)
  })

  test("treats a star that is not final as a literal", () => {
    expect(matchesToolAllowlist("abcd", ["a*d"])).toBe(false)
    expect(matchesToolAllowlist("a*d", ["a*d"])).toBe(true)
  })
})

describe("summarizeToolCall", () => {
  test("reduces an unlisted tool to its name only", () => {
    const summary = summarizeToolCall("bash", { command: "cat /etc/shadow" }, options)
    expect(summary).toBe("ran bash")
    expect(summary).not.toContain("shadow")
  })

  test("says nothing for an unlisted tool when configured to hide", () => {
    expect(summarizeToolCall("bash", { command: "ls" }, { ...options, unlistedTools: "hide" })).toBeNull()
  })

  test("drops every argument field that is not allowlisted", () => {
    const summary = summarizeToolCall("task", {
      description: "Find the config",
      prompt: "SECRET INTERNAL PROMPT BODY",
      apiKey: "sk-abcdefghijklmnopqrstuvwx",
    }, options)
    expect(summary).toBe("description=Find the config [task]")
    expect(summary).not.toContain("SECRET INTERNAL PROMPT BODY")
    expect(summary).not.toContain("apiKey")
  })

  test("emits only the tool name when no allowlisted field is present", () => {
    expect(summarizeToolCall("todowrite", { todos: [1, 2, 3] }, options)).toBe("[todowrite]")
  })

  test("collapses arrays and objects to a shape rather than contents", () => {
    const summary = summarizeToolCall("todowrite", {
      count: [{ secret: "a" }, { secret: "b" }],
      status: { inner: "private" },
    }, options)
    expect(summary).toBe("status={1 field}, count=[2 items] [todowrite]")
    expect(summary).not.toContain("private")
  })

  test("orders fields by the allowlist, not by the caller's key order", () => {
    const args = { count: 1, status: "ok", title: "t" }
    expect(summarizeToolCall("todowrite", args, options))
      .toBe("title=t, status=ok, count=1 [todowrite]")
  })

  test("bounds a long allowlisted value", () => {
    const summary = summarizeToolCall("session_read", { title: "x".repeat(200) }, options)
    expect(summary!.length).toBeLessThan(80)
    expect(summary).toContain("...")
  })

  test("redacts a credential inside an allowlisted field", () => {
    const summary = summarizeToolCall("session_read", {
      title: "token is xoxb-1234567890-ABCDEFGHIJK",
    }, { ...options, maxFieldLength: 200 })
    expect(summary).toContain(REDACTION_PLACEHOLDER)
    expect(summary).not.toContain("xoxb-1234567890")
  })

  test("tolerates a non-object argument payload", () => {
    expect(summarizeToolCall("task", "just a string", options)).toBe("[task]")
    expect(summarizeToolCall("task", undefined, options)).toBe("[task]")
    expect(summarizeToolCall("task", [1, 2], options)).toBe("[task]")
  })

  test("names an unknown tool rather than throwing", () => {
    expect(summarizeToolCall("", {}, options)).toBe("ran unknown")
  })
})

describe("redactSecrets", () => {
  test("masks a slack bot token", () => {
    const out = redactSecrets("use xoxb-99999999-AAAAAAAAAAA now")
    expect(out).not.toContain("xoxb-99999999")
    expect(out).toContain(REDACTION_PLACEHOLDER)
  })

  test("masks a slack app token", () => {
    expect(redactSecrets("xapp-1-A012345-XYZ")).toContain(REDACTION_PLACEHOLDER)
  })

  test("masks github and gitlab tokens", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz012345")).toContain(REDACTION_PLACEHOLDER)
    expect(redactSecrets("glpat-abcdefghijklmnopq")).toContain(REDACTION_PLACEHOLDER)
  })

  test("masks an openai-style key", () => {
    expect(redactSecrets("sk-abcdefghijklmnopqrstuvwxyz")).toContain(REDACTION_PLACEHOLDER)
  })

  test("masks an aws access key id", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain(REDACTION_PLACEHOLDER)
  })

  test("masks a jwt", () => {
    // Assembled at runtime so no source line is itself a JWT for secret scanners.
    const payload = "eyJzdWIiOiIxMjM0NTY3ODkwIn0"
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", payload, "dBjftJeZ4CVPmB92K27uhbUJU1p1r"].join(".")
    expect(redactSecrets(jwt)).not.toContain(payload)
  })

  test("masks a bearer header value", () => {
    const out = redactSecrets("Authorization: Bearer abcdefghijklmnop")
    expect(out).not.toContain("abcdefghijklmnop")
  })

  test("masks credentials embedded in a url and keeps the scheme", () => {
    const out = redactSecrets("remote https://oauth2:glpat-abcdefghijklmnop@git.example.com/x.git")
    expect(out).not.toContain("glpat-abcdefghijklmnop")
    expect(out).toContain("https://")
    expect(out).toContain("git.example.com")
  })

  test("masks the value of a secret-named assignment and keeps the name", () => {
    const out = redactSecrets("MATRIX_ACCESS_TOKEN=syt_verysecretvalue")
    expect(out).toContain("MATRIX_ACCESS_TOKEN=")
    expect(out).not.toContain("syt_verysecretvalue")
  })

  test("masks a quoted secret assignment", () => {
    expect(redactSecrets('password: "hunter2hunter2"')).not.toContain("hunter2hunter2")
  })

  test("masks a private key block", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----"
    const out = redactSecrets(key)
    expect(out).toBe(REDACTION_PLACEHOLDER)
  })

  test("leaves ordinary prose untouched", () => {
    const text = "The deploy finished in 12s and the tests are green."
    expect(redactSecrets(text)).toBe(text)
  })

  test("is idempotent", () => {
    const once = redactSecrets("token=abcdefghijklmnop")
    expect(redactSecrets(once)).toBe(once)
  })
})
