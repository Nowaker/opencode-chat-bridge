/**
 * The phone's webhook body (contract section 1): validation, the dedup hash,
 * and the event's capture time on the desktop clock.
 */

import { createHash } from "crypto"
import { absent, isRecord, isSafeInt, optionalString } from "./guards"

export interface WebhookEvent {
  version: 1
  /** The send attempt's own time, on the phone's clock. Per attempt. */
  tsMs: number
  deliveryId: string
  /** The source's own timestamp (for an SMS, its PDU/service-centre time). */
  capturedAtMs: number
  /** The phone's measure of the event's age at this attempt, when it has one. Per attempt. */
  ageMs: number | null
  kind: "sms" | "notification"
  /** Which clock `captured_at_ms` came from, as the phone reports it. Receipts only. */
  timeBasis: string | null
  number: string
  name: string
  package: string | null
  body: string
  label: string | null
  test: boolean
  redirectId: number | null
  eventId: number | null
}

export type ParsedEvent = { ok: true; event: WebhookEvent } | { ok: false; field: string }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** A source time this far after the attempt's own time is a clock error, not an event. */
export const CLOCK_ANOMALY_MS = 300_000

/** Validates every field the broker reads. Fields it does not know are ignored. */
export function parseEvent(body: unknown): ParsedEvent {
  const fail = (field: string): ParsedEvent => ({ ok: false, field })
  if (!isRecord(body)) return fail("body")
  const { version, ts_ms: tsMs, delivery_id: deliveryId, captured_at_ms: capturedAtMs, age_ms: ageMs, source } = body
  if (version !== 1) return fail("version")
  if (!isSafeInt(tsMs) || tsMs <= 0) return fail("ts_ms")
  if (typeof deliveryId !== "string" || !UUID.test(deliveryId)) return fail("delivery_id")
  if (!isSafeInt(capturedAtMs) || capturedAtMs <= 0) return fail("captured_at_ms")
  if (!absent(ageMs) && (!isSafeInt(ageMs) || ageMs < 0)) return fail("age_ms")
  if (!isRecord(source)) return fail("source")
  const { kind, number: sourceNumber, name, package: sourcePackage, time_basis: timeBasis } = source
  if (kind !== "sms" && kind !== "notification") return fail("source.kind")
  if (typeof sourceNumber !== "string") return fail("source.number")
  if (!optionalString(name)) return fail("source.name")
  if (!optionalString(sourcePackage)) return fail("source.package")
  if (kind === "notification" && !sourcePackage) return fail("source.package")
  if (!absent(timeBasis) && (typeof timeBasis !== "string" || !/^[a-z_]{1,32}$/.test(timeBasis))) return fail("source.time_basis")
  const { body: text, label, test, redirect_id: redirectId, event_id: eventId } = body
  if (typeof text !== "string") return fail("body")
  if (!optionalString(label)) return fail("label")
  if (!absent(test) && typeof test !== "boolean") return fail("test")
  if (!absent(redirectId) && !isSafeInt(redirectId)) return fail("redirect_id")
  if (!absent(eventId) && !isSafeInt(eventId)) return fail("event_id")
  return {
    ok: true,
    event: {
      version: 1,
      tsMs,
      deliveryId,
      capturedAtMs,
      ageMs: ageMs ?? null,
      kind,
      timeBasis: timeBasis ?? null,
      number: sourceNumber,
      name: name ?? "",
      package: sourcePackage || null,
      body: text,
      label: label ?? null,
      test: test === true,
      redirectId: redirectId ?? null,
      eventId: eventId ?? null,
    },
  }
}

/**
 * The duplicate-or-conflict hash (v1.3.2) covers the immutable fields only.
 * `ts_ms`, `age_ms`, any attempt counter and the signature change on every
 * attempt, and `age_ms` disappears after a phone reboot, so hashing any of
 * them would turn a lost-ACK retry into a 409 and stop delivery for good.
 */
export function contentHash(event: WebhookEvent): string {
  const immutable = [
    event.version,
    event.redirectId,
    event.eventId,
    event.deliveryId,
    event.capturedAtMs,
    event.kind,
    event.number,
    event.name,
    event.package,
    event.body,
    event.label,
    event.test,
  ]
  return createHash("sha256").update(JSON.stringify(immutable)).digest("hex")
}

export interface CaptureTime {
  ageMs: number
  /** `phone` when the phone sent `age_ms`, `ts` when it is `ts_ms - captured_at_ms`. */
  ageSource: "phone" | "ts"
  captureDesktopMs: number
  clockAnomaly: boolean
}

/**
 * The event's capture time on the desktop clock (v1.3.4).
 *
 * An SMS's `captured_at_ms` is the service centre's clock, not the phone's.
 * An age built from it and a phone time carries the phone's clock error P
 * (`arrival - age = captured_at + latency - P`), so a fast phone makes a fresh
 * code look old and a slow one makes an old code look fresh. Removing the
 * offset the broker measures on the same attempt (`ts_ms - arrival_ms`) leaves
 * the service-centre time itself: an SMS uses that, never later than its
 * arrival, and phone clock error does not enter. Its remaining error is the
 * service centre's clock.
 *
 * A notification's `captured_at_ms` is the messaging app's message time
 * (v1.3.5), whose clock is not known: the phone's, or the messaging service's.
 * Each reading is right for one of those and wrong by P for the other, so a
 * notification takes the earlier of `captured_at_ms` and `arrival_ms - age_ms`.
 * Phone clock error can then make a notification look older (refused, fail
 * closed) but never newer.
 *
 * A source time more than 300 s after the event's arrival, on the desktop
 * clock, is a clock anomaly for either kind.
 */
export function captureTime(event: WebhookEvent, arrivalMs: number): CaptureTime {
  const ageSource = event.ageMs === null ? "ts" : "phone"
  const ageMs = event.ageMs ?? Math.max(0, event.tsMs - event.capturedAtMs)
  return {
    ageMs,
    ageSource,
    captureDesktopMs: event.kind === "sms" ? Math.min(event.capturedAtMs, arrivalMs) : Math.min(event.capturedAtMs, arrivalMs - ageMs),
    clockAnomaly: event.capturedAtMs - arrivalMs > CLOCK_ANOMALY_MS,
  }
}
