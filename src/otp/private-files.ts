/**
 * Files only this user may read: the signing key, the profiles, the OTP_CODE
 * files the CLI writes. Each is checked rather than trusted, because a key or
 * a code readable by anyone else is a leak no later step can undo.
 */

import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "fs"
import { randomBytes } from "crypto"
import { dirname } from "path"

/** A 0700 directory of this user, created if missing; anything looser is refused. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error(`${path} is not a private directory`)
  }
}

/** A private regular file of this user, never read through a symlink. */
export function readPrivateText(path: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error(`${path} is not a private file`)
  }
  return readFileSync(path, "utf8")
}

/** Written whole and flushed, then renamed into place: a crash leaves the old file or the new one. */
export function writePrivateText(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  const dir = openSync(dirname(path), constants.O_RDONLY)
  try {
    fsyncSync(dir)
  } finally {
    closeSync(dir)
  }
}
