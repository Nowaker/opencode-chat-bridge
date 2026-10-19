/**
 * The broker's database. Every answer the phone takes as an ACK is committed
 * first, so it is opened with `synchronous = FULL`: in WAL mode that fsyncs
 * the log on every commit, where `NORMAL` could lose the last commits to a
 * power cut.
 *
 * `secure_delete` zeroes freed space, and the broker checkpoints the WAL
 * after every purge, so a deleted code does not linger in free pages or in
 * old log frames. `locking_mode = EXCLUSIVE` keeps a second broker on the
 * same database from starting at all.
 */

import { Database } from "bun:sqlite"
import { closeSync, constants, existsSync, openSync } from "fs"

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS requests (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    service TEXT NOT NULL,
    account TEXT NOT NULL,
    challenge TEXT,
    test INTEGER NOT NULL,
    hints TEXT,
    lease_keys TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    not_before INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    resends INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('open', 'claimed', 'expired', 'cancelled')),
    closed_at INTEGER,
    close_reason TEXT,
    claimed_receipt TEXT,
    rejected_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS requests_by_state ON requests (state, expires_at)`,
  `CREATE TABLE IF NOT EXISTS events (
    receipt_id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    arrival_ms INTEGER NOT NULL,
    ts_ms INTEGER NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    age_ms INTEGER NOT NULL,
    age_source TEXT NOT NULL,
    capture_desktop_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    time_basis TEXT,
    test INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('matched', 'claimed', 'ambiguous', 'stale', 'unmatched')),
    reason TEXT,
    request_id TEXT,
    code TEXT,
    duplicates INTEGER NOT NULL DEFAULT 0,
    last_duplicate_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS events_by_request ON events (request_id)`,
  `CREATE INDEX IF NOT EXISTS events_by_arrival ON events (arrival_ms)`,
  `CREATE TABLE IF NOT EXISTS links (
    receipt_id TEXT NOT NULL REFERENCES events (receipt_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('eligible', 'stale')),
    not_before INTEGER NOT NULL,
    PRIMARY KEY (receipt_id, request_id)
  )`,
  `CREATE INDEX IF NOT EXISTS links_by_request ON links (request_id)`,
]

export function openStore(path: string): Database {
  // Created 0600 before SQLite opens it: SQLite gives its -wal and -shm files
  // the database file's own mode.
  if (!existsSync(path)) closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600))
  const db = new Database(path)
  db.run("PRAGMA busy_timeout = 2000")
  db.run("PRAGMA locking_mode = EXCLUSIVE")
  const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()
  if (mode?.journal_mode !== "wal") throw new Error(`database journal mode is ${mode?.journal_mode}, not wal`)
  db.run("PRAGMA synchronous = FULL")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA secure_delete = ON")
  db.transaction(() => {
    for (const statement of SCHEMA) db.run(statement)
  })()
  return db
}
