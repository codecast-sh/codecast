// The visible cards' owner reads, split into chunks of fixed membership
// (hooks/useSyncVisibleSessionOwners subscribes one listOwnersFor per chunk).
// A scroll changes a few ids at a time: only the chunks it touches change
// their args and are read again, where one batch of every visible id was read
// again whole on every change.

export type OwnerChunk = { key: string; ids: string[] };

export const OWNER_CHUNK_SIZE = 5;
let seq = 0;

/** The next chunks for `ids`: a chunk keeps its key, and its very array when
 *  its members all stay; new ids fill the chunks that change anyway, then new
 *  ones. Too many part-empty chunks for the ids, and they are rebuilt once. */
export function rechunk(prev: readonly OwnerChunk[], ids: readonly string[], size = OWNER_CHUNK_SIZE): OwnerChunk[] {
  const want = new Set(ids);
  const placed = new Set<string>();
  const touched = new Set<OwnerChunk>();
  let next: OwnerChunk[] = [];
  for (const c of prev) {
    const kept = c.ids.filter((id) => want.has(id));
    for (const id of kept) placed.add(id);
    if (!kept.length) continue;
    if (kept.length === c.ids.length) next.push(c);
    else { const t = { key: c.key, ids: kept }; touched.add(t); next.push(t); }
  }
  const fresh = ids.filter((id) => !placed.has(id));
  for (const c of next) {
    if (!fresh.length) break;
    if (touched.has(c) && c.ids.length < size) c.ids.push(...fresh.splice(0, size - c.ids.length));
  }
  while (fresh.length) next.push({ key: `c${++seq}`, ids: fresh.splice(0, size) });
  if (next.length > 2 * Math.ceil(ids.length / size) + 1) {
    next = [];
    for (let i = 0; i < ids.length; i += size) next.push({ key: `c${++seq}`, ids: ids.slice(i, i + size) });
  }
  return next;
}

/** How many session reads a move from `prev` to `next` costs: every id of
 *  each chunk whose membership is new. */
export function chunkReads(prev: readonly OwnerChunk[], next: readonly OwnerChunk[]): number {
  const before = new Map(prev.map((c) => [c.key, c.ids.join(",")]));
  return next.reduce((n, c) => n + (before.get(c.key) === c.ids.join(",") ? 0 : c.ids.length), 0);
}
