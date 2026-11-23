// The inbox list's rows carry ~145 fields, ~120 of them null on a typical
// session (measured: 2.7KB of a 3.4KB row). Every mutation re-sends the live
// window's hot rows, so the nulls were most of each echo's bytes and of the
// client's decode. The compact wire form drops null fields and records which
// ones were null as a bitmask over one key list per payload; expanding it
// restores the row exactly (same keys, same values), so row hashes and every
// reader see what the full form carried. Asked for by the caller
// (`compact: true`); a caller that does not ask gets the full form.

/** The field holding a compacted row's null mask. */
export const NULLS_FIELD = "_nulls";

const CHUNK = 30;

function encodeMask(bits: number[], width: number): string {
  const out: string[] = [];
  for (let start = 0; start < width; start += CHUNK) {
    let word = 0;
    for (const b of bits) if (b >= start && b < start + CHUNK) word += 2 ** (b - start);
    out.push(word.toString(36));
  }
  while (out.length && out[out.length - 1] === "0") out.pop();
  return out.join(".");
}

function decodeMask(mask: string): number[] {
  const bits: number[] = [];
  mask.split(".").forEach((part, chunk) => {
    let word = parseInt(part, 36);
    for (let i = 0; word > 0; i++, word = Math.floor(word / 2)) if (word % 2) bits.push(chunk * CHUNK + i);
  });
  return bits;
}

/** Drop each row's null fields, recording them in `_nulls` against the returned key list. */
export function compactNulls<R extends Record<string, unknown>>(rows: readonly R[]): { rows: Record<string, unknown>[]; null_keys: string[] } {
  const keys = new Set<string>();
  for (const row of rows) for (const k in row) if (row[k] === null) keys.add(k);
  const null_keys = [...keys].sort();
  if (!null_keys.length) return { rows: rows as unknown as Record<string, unknown>[], null_keys };
  const index = new Map(null_keys.map((k, i) => [k, i]));
  const out = rows.map((row) => {
    const bits: number[] = [];
    const compact: Record<string, unknown> = {};
    for (const k in row) {
      if (row[k] === null) bits.push(index.get(k)!);
      else compact[k] = row[k];
    }
    if (bits.length) compact[NULLS_FIELD] = encodeMask(bits, null_keys.length);
    return compact;
  });
  return { rows: out, null_keys };
}

/** The full rows a compacted list stands for. Rows without a mask pass through as they are. */
export function expandNulls<R = Record<string, unknown>>(rows: readonly any[], nullKeys: readonly string[]): R[] {
  return rows.map((row) => {
    const mask = row?.[NULLS_FIELD];
    if (typeof mask !== "string") return row;
    const full: Record<string, unknown> = {};
    for (const k in row) if (k !== NULLS_FIELD) full[k] = row[k];
    for (const bit of decodeMask(mask)) {
      const key = nullKeys[bit];
      if (key !== undefined) full[key] = null;
    }
    return full as R;
  });
}
