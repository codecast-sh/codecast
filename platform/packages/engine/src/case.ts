/**
 * Wire-case conversion.
 *
 * The server schema is snake_case; client stores are camelCase. These convert
 * at the sync boundary — deep, keys only — so neither side ever sees the
 * other's convention.
 *
 * Keys that are protocol, not data, pass through verbatim:
 *   _id, _creationTime   Convex system fields
 *   client_id            the optimistic-create rekey key (registry altKey)
 */

const VERBATIM = new Set(['_id', '_creationTime', 'client_id'])

function snakeToCamelKey(key: string): string {
  if (VERBATIM.has(key) || !key.includes('_')) return key
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function camelToSnakeKey(key: string): string {
  if (VERBATIM.has(key) || key.startsWith('_')) return key
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

function convert(value: unknown, keyFn: (k: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => convert(v, keyFn))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[keyFn(k)] = convert(v, keyFn)
    }
    return out
  }
  return value
}

/** Incoming server rows → client shape. */
export function rowsToCamel<T = any>(rows: unknown): T {
  return convert(rows, snakeToCamelKey) as T
}

/** Outgoing client patches → server columns. */
export function patchesToSnake<T = any>(patches: unknown): T {
  return convert(patches, camelToSnakeKey) as T
}
