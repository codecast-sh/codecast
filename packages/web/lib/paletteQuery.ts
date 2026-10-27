// Pure helpers the command palette uses on a typed query.

/** The recents pool with the person's favorites added (once each), for a
 *  typed query that ranks them all together. */
export function withFavorites<T extends { _id: unknown }>(pool: T[], favorites: T[], exclude?: readonly string[]): T[] {
  const seen = new Set(pool.map((c) => String(c._id)));
  const skip = new Set(exclude ?? []);
  const added = favorites.filter((f) => !seen.has(String(f._id)) && !skip.has(String(f._id)));
  return added.length ? [...pool, ...added] : pool;
}

/** A typed query as a row quotes it: trimmed, and cut short with an ellipsis
 *  so the closing quote survives the row's own truncation. */
export function previewQuery(query: string): string {
  const q = query.trim();
  return q.length > 40 ? `${q.slice(0, 40)}\u2026` : q;
}
