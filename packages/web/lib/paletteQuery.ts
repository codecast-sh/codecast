// Pure helpers the command palette uses on a typed query.

/** The recents pool with the person's favorites added (once each), for a
 *  typed query that ranks them all together. */
export function withFavorites<T extends { _id: unknown }>(pool: T[], favorites: T[], exclude?: readonly string[]): T[] {
  // The favorites the pool lacks, found by walking the pool until each one
  // turns up: they are usually recent, so the walk ends near its start.
  const missing = new Map(favorites.map((f) => [String(f._id), f]));
  for (const c of pool) {
    if (!missing.size) break;
    missing.delete(String(c._id));
  }
  for (const id of exclude ?? []) missing.delete(id);
  return missing.size ? [...pool, ...favorites.filter((f) => missing.get(String(f._id)) === f)] : pool;
}

/** A typed query as a row quotes it: trimmed, and cut short with an ellipsis
 *  so the closing quote survives the row's own truncation. */
export function previewQuery(query: string): string {
  const q = query.trim();
  return q.length > 40 ? `${q.slice(0, 40)}\u2026` : q;
}
