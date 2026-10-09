// The split wire form of the two live inbox queries (listInboxSessions and
// sessionsLiveness). Convex re-sends a query's whole result whenever any part
// of it changes, and both results are the viewer's whole working set: on
// 2026-10-08 one heartbeat re-sent 650 kB of liveness about once a second and
// one changed field re-sent the 3.5 MB list, around 60 MB a minute for an
// account with forty live agents. Split, a result carries every row id in
// order, the rows stamped inside the hot window in full, and one hash over all
// the others. A replica that holds those others rebuilds the whole result and
// checks it against the hash; one that cannot fetches the whole result once.
// A cold row that changes moves the hash, so the split form is exact: it
// decides only how many bytes travel.
//
// Pure and isomorphic: the Convex handlers split with it and the web feeder
// rebuilds with it, so both hash the same bytes the same way.

/** Rows with a stamp inside this window (or a deadline still ahead) ship in full. */
export const INBOX_SPLIT_HOT_MS = 10 * 60 * 1000;

/** JSON with object keys sorted, and undefined fields dropped as Convex drops them on the wire. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/** cyrb53: a fast 53-bit string hash, base 36. Not cryptographic; collisions only cost a missed refetch. */
export function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function rowHash(row: unknown): string {
  return hash53(stableStringify(row));
}

// Epoch-millisecond stamps: a top-level number between 2001 and 2286. Counts
// and sizes never reach that range, so no field list has to be kept in step
// with the row shapes; a misread only moves a row between hot and cold.
const STAMP_MIN = 1e12;
const STAMP_MAX = 1e13;

/** A row is hot if any stamp on it is inside the window or still ahead (a deadline). */
export function isHotRow(row: Record<string, unknown>, now: number, hotMs = INBOX_SPLIT_HOT_MS): boolean {
  for (const v of Object.values(row)) {
    if (typeof v === "number" && v > STAMP_MIN && v < STAMP_MAX && v >= now - hotMs) return true;
  }
  return false;
}

/** The hash over the cold rows, in result order. Both sides combine row hashes this way. */
export function coldHashOf(ids: readonly string[], hot: ReadonlySet<string>, hashOf: (id: string) => string | undefined): string | null {
  const parts: string[] = [];
  for (const id of ids) {
    if (hot.has(id)) continue;
    const h = hashOf(id);
    if (h === undefined) return null;
    parts.push(`${id}:${h}`);
  }
  return hash53(parts.join("|"));
}

export type SplitRows<R> = { ids: string[]; hot: Array<[string, R]>; cold_hash: string };

/** Server side: the split form of an ordered set of rows. */
export function splitRows<R extends Record<string, unknown>>(entries: Array<[string, R]>, now: number, hotMs = INBOX_SPLIT_HOT_MS): SplitRows<R> {
  const ids: string[] = [];
  const hot: Array<[string, R]> = [];
  const hotIds = new Set<string>();
  const cold = new Map<string, R>();
  for (const [id, row] of entries) {
    ids.push(id);
    if (isHotRow(row, now, hotMs)) {
      hot.push([id, row]);
      hotIds.add(id);
    } else cold.set(id, row);
  }
  const cold_hash = coldHashOf(ids, hotIds, (id) => rowHash(cold.get(id)))!;
  return { ids, hot, cold_hash };
}

/** The rows a replica held from earlier results, with their hashes. */
export type SplitCache<R> = Map<string, { row: R; hash: string }>;

export function cacheRows<R>(cache: SplitCache<R>, entries: Iterable<[string, R]>): void {
  for (const [id, row] of entries) {
    const held = cache.get(id);
    if (held && held.row === row) continue;
    cache.set(id, { row, hash: rowHash(row) });
  }
}

/**
 * Client side: the whole ordered row set the split result stands for, or null
 * when the cache lacks a cold row or holds a different version of one (the
 * caller then fetches the whole result). Hot rows enter the cache, so a row
 * that cools off later is already held.
 */
export function rebuildRows<R>(split: SplitRows<R>, cache: SplitCache<R>): Array<[string, R]> | null {
  cacheRows(cache, split.hot);
  const hot = new Map(split.hot);
  const hotIds = new Set(hot.keys());
  if (coldHashOf(split.ids, hotIds, (id) => cache.get(id)?.hash) !== split.cold_hash) return null;
  // The result is the whole set now: rows it no longer lists leave the cache.
  const listed = new Set(split.ids);
  for (const id of cache.keys()) if (!listed.has(id)) cache.delete(id);
  return split.ids.map((id) => [id, hot.has(id) ? hot.get(id)! : cache.get(id)!.row]);
}
