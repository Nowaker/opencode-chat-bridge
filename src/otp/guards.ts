/**
 * Narrowing for values from outside this process: the phone's webhook body,
 * requests and answers on the CLI's socket, private files, and JSON read back
 * from the database. Each reader checks its value and returns it typed, so
 * nothing downstream is cast. A wrong shape is a ShapeError naming the field,
 * never carrying its value.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

/**
 * JSON null in an optional field means the same as leaving the field out.
 * Refusing it would be a 400, which stops the phone's retries and loses the
 * delivery.
 */
export function absent(value: unknown): value is null | undefined {
  return value === undefined || value === null
}

export function optionalString(value: unknown): value is string | null | undefined {
  return absent(value) || typeof value === "string"
}

export class ShapeError extends Error {
  constructor(readonly field: string, missing = false) {
    super(missing ? `${field} is required` : `${field} has the wrong type`)
    this.name = "ShapeError"
  }
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ShapeError(field, absent(value))
  return value
}

export function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError(field, absent(value))
  return value
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ShapeError(field, absent(value))
  return value
}

export function int(value: unknown, field: string): number {
  if (!isSafeInt(value)) throw new ShapeError(field, absent(value))
  return value
}

export function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ShapeError(field, absent(value))
  return value
}

/** A new array holding `value`'s items, each of which must be a string. */
export function strings(value: unknown, field: string): string[] {
  return list(value, field).map((item) => {
    if (typeof item !== "string") throw new ShapeError(field)
    return item
  })
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const found = allowed.find((item) => item === value)
  if (found === undefined) throw new ShapeError(field, absent(value))
  return found
}

export function optional<T>(value: unknown, read: (value: unknown, field: string) => T, field: string): T | undefined {
  return absent(value) ? undefined : read(value, field)
}

export function nullable<T>(value: unknown, read: (value: unknown, field: string) => T, field: string): T | null {
  return absent(value) ? null : read(value, field)
}
