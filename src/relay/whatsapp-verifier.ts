import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

export type Verification =
  | { readonly outcome: "verified" | "refused" | "unavailable"; readonly line: string; readonly reason: null }
  | { readonly outcome: "inconclusive"; readonly line: null; readonly reason: string }

export type VerifierRun =
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly output: string; readonly lines: number; readonly bytes: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "spawn-error"; readonly code: string }

export type VerifierRunner = (command: readonly string[], timeoutMs: number) => Promise<VerifierRun>

function errorCode(error: unknown): string {
  const code = error instanceof Error && "code" in error ? error.code : null
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "UNKNOWN"
}

export const spawnVerifier: VerifierRunner = (command, timeoutMs) => new Promise((resolve) => {
  let child
  try {
    child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    resolve({ kind: "spawn-error", code: errorCode(error) })
    return
  }
  let bytes = 0
  let captured = 0
  let timedOut = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const streams = [child.stdout, child.stderr].map((stream) => {
    const chunks: Buffer[] = []
    const decoder = new StringDecoder("utf8")
    let lines = 0
    let nonempty = false
    const count = (text: string) => {
      const parts = text.split("\n")
      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          if (nonempty) lines++
          nonempty = false
        }
        if (part.trim()) nonempty = true
      }
    }
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      const kept = chunk.subarray(0, Math.max(0, 8_192 - captured))
      if (kept.length) chunks.push(Buffer.from(kept))
      captured += kept.length
      count(decoder.write(chunk))
    })
    return () => {
      count(decoder.end())
      return { output: Buffer.concat(chunks).toString("utf8"), lines: lines + (nonempty ? 1 : 0) }
    }
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGTERM")
    killTimer = setTimeout(() => {
      child.kill("SIGKILL")
      child.stdout.destroy()
      child.stderr.destroy()
    }, 2_000)
  }, timeoutMs)
  const clearTimers = () => {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
  }
  child.once("error", (error) => {
    clearTimers()
    resolve({ kind: "spawn-error", code: errorCode(error) })
  })
  child.once("close", (code, signal) => {
    clearTimers()
    const output = streams.map((finish) => finish())
    resolve(timedOut ? { kind: "timeout" } : {
      kind: "exit", code, signal, bytes,
      output: output.map((stream) => stream.output).join("\n"),
      lines: output.reduce((sum, stream) => sum + stream.lines, 0),
    })
  })
})

export function verifierVerdict(result: VerifierRun, name: string): Verification {
  const inconclusive = (reason: string): Verification => ({ outcome: "inconclusive", line: null, reason })
  switch (result.kind) {
    case "timeout": return inconclusive("timed out")
    case "spawn-error": return inconclusive(`spawn failed: ${result.code}`)
    case "exit": {
      if (result.signal) return inconclusive(`signal ${result.signal}`)
      if (result.code !== 0 && result.code !== 1 && result.code !== 2) return inconclusive(`exit ${result.code}`)
      const lines = result.output.split("\n").map((line) => line.trim()).filter(Boolean)
      if (result.bytes <= 8_192 && result.lines === 1 && lines.length === 1) {
        const line = lines[0]
        if (result.code === 0 && line === `verified ${name}`) return { outcome: "verified", line, reason: null }
        const reason = "[A-Za-z0-9 _.,:()/-]{1,120}"
        if (result.code === 1 && new RegExp(`^refuse ${name}: ${reason}$`).test(line)) return { outcome: "refused", line, reason: null }
        if (result.code === 2 && new RegExp(`^unavailable ${name}: ${reason}$`).test(line)) return { outcome: "unavailable", line, reason: null }
      }
      return inconclusive(`output not recognized (${result.lines} lines, ${result.bytes} bytes)`)
    }
  }
}
