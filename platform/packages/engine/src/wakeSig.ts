// Wake signatures — subscribe to a SIGNATURE of churny store state, not the raw
// object, so a component re-renders only on the changes it actually branches on.
//
// THE PITFALL THIS EXISTS TO PREVENT. useTrackedStore / any zustand selector
// re-renders when a dep's ref flips (Object.is). The store is a mutative draft,
// so ANY field change on ANY row hands back a brand-new collection ref and a
// brand-new row ref. With ~1s liveness heartbeats across N live rows, a
// component subscribed to the whole collection map — or even a whole row —
// re-renders on every tick, even though the fields that changed never changed
// what it shows. An always-mounted panel doing this pins the main thread (a
// sidebar was measured at ~70% idle CPU from exactly this).
//
// THE FIX. Derive a short string from only the fields that affect THIS
// component's output and subscribe to that. A bare heartbeat leaves the string
// unchanged, so there is no re-render.
//
// TWO SHAPES — pick by how much of the data you actually render:
//   • rowSigExcluding(row, deny): ONE watched row, re-render on any real change
//     except known churn fields. The denylist is fail-safe — omit a field and you
//     re-render more often, never render stale.
//   • makeCollectionSig(project): a WHOLE collection where only a few fields
//     matter (group / order / identity). The projection is an allowlist and MUST
//     be a superset of every field your output depends on, or a row goes stale in
//     the wrong place. Memoized by the collection ref, so unrelated store
//     mutations are free.
//
// Either shape only tracks FIELD-driven change. TIME-driven transitions (a status
// going stale after a TTL, a relative clock advancing) are not field changes —
// pair the signature with a coarse re-render ticker (useCoarseNow), never by
// widening the signature back out to churny fields.

let __refSeq = 0;
const __refIds = new WeakMap<object, number>();
// A stable id per object reference, so an object-valued field contributes
// losslessly to a signature (a new ref produces a new id, flipping the sig)
// without serializing the object. WeakMap so ids vanish with their objects.
export function stableRefId(o: object): number {
  let id = __refIds.get(o);
  if (id === undefined) {
    id = ++__refSeq;
    __refIds.set(o, id);
  }
  return id;
}

// Single-row signature: every own field except the denied (churn) ones. Object
// values fold in via stableRefId so a nested change still flips the signature.
// Memoized by the row ref and the denylist: every subscriber re-reads its row's
// signature on every store write, and a row the write did not touch keeps its
// ref, so a list of N cards rebuilds one row's string per write, not N.
const rowSigs = new WeakMap<ReadonlySet<string>, WeakMap<object, string>>();
export function rowSigExcluding(
  row: Record<string, any> | null | undefined,
  deny: ReadonlySet<string>,
): string {
  if (!row) return "none";
  let byRow = rowSigs.get(deny);
  if (!byRow) rowSigs.set(deny, (byRow = new WeakMap()));
  let sig = byRow.get(row);
  if (sig === undefined) byRow.set(row, (sig = rowSigUncached(row, deny)));
  return sig;
}

function rowSigUncached(row: Record<string, any>, deny: ReadonlySet<string>): string {
  let sig = "";
  for (const k in row) {
    if (deny.has(k)) continue;
    const v = row[k];
    sig += k + ":" + (v !== null && typeof v === "object" ? "#" + stableRefId(v) : String(v)) + ";";
  }
  return sig;
}

// Build a collection-signature function, memoized by the collection ref: it
// recomputes only when the map identity changes (i.e. some row changed) and
// returns the cached string for every unrelated store mutation (keystrokes,
// other collections). `project` distills a row down to its structural fields.
//
// The signature is a short digest, not the projections themselves: a hash per
// row (its key and projection, cached by the row ref) folded into two sums and
// the row count. A projection of null leaves the row out of the signature. A rebuild after one row changed hashes that row only, and the
// result compares in constant time. Joined projections over thousands of rows
// were megabytes, rebuilt on every heartbeat and compared character by
// character by every subscriber on every store write. It answers equality
// only: never parse it. Key order does not count; membership and every
// projection do.
export function makeCollectionSig<T>(
  project: (row: T) => string | null,
): (collection: Record<string, T>) => string {
  const signatures = new WeakMap<Record<string, T>, string>();
  const hashedByRow = new WeakMap<object, RowHash>();
  // A row that is not an object (a set kept as { id: true }) is cached by its
  // key and value instead, so it is not hashed again on every rebuild.
  const hashedByKey = new Map<string, { hash: RowHash; value: unknown }>();
  return (collection: Record<string, T>): string => {
    const cached = signatures.get(collection);
    if (cached !== undefined) return cached;
    let a = 0;
    let b = 0;
    let n = 0;
    for (const id in collection) {
      const row = collection[id];
      const keyed = row !== null && typeof row === "object";
      let h: RowHash | undefined;
      if (keyed) h = hashedByRow.get(row as object);
      else {
        const byKey = hashedByKey.get(id);
        if (byKey && byKey.value === row) h = byKey.hash;
      }
      if (h === undefined || h.id !== id) {
        const projected = project(row);
        h = projected === null ? { id, a: 0, b: 0, left: true } : rowHash(id, projected);
        if (keyed) hashedByRow.set(row as object, h);
        else hashedByKey.set(id, { hash: h, value: row });
      }
      if (h.left) continue;
      a = (a + h.a) | 0;
      b = (b + h.b) | 0;
      n++;
    }
    const signature = `${n}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
    signatures.set(collection, signature);
    return signature;
  };
}

// `left`: the projection returned null, so the row is not counted.
type RowHash = { id: string; a: number; b: number; left?: true };

// Two independent 32-bit hashes of the row's key and projection (cyrb53's
// mixing), so the folded pair carries 64 bits.
function rowHash(id: string, projected: string): RowHash {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const s = id + "\u0000" + projected;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return { id, a: h1 | 0, b: h2 | 0 };
}
