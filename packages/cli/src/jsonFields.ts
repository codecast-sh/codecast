/**
 * A --json reply narrowed to the fields a caller names (`--fields a,b`), so a
 * reader that needs a title and a status does not carry every comment through
 * a transport with a size cap. `short_id` always rides along: it is how a
 * caller that asked for several rows tells them apart. No names, the row whole.
 */
export function pickFields<T extends Record<string, unknown>>(row: T, fields: string | undefined): Partial<T> {
  const names = (fields ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  if (names.length === 0) return row;
  const keep = new Set(["short_id", ...names]);
  return Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k))) as Partial<T>;
}
