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
export function rowSigExcluding(
  row: Record<string, any> | null | undefined,
  deny: ReadonlySet<string>,
): string {
  if (!row) return "none";
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
export function makeCollectionSig<T>(
  project: (row: T) => string,
): (collection: Record<string, T>) => string {
  let lastRef: unknown;
  let lastSig = "";
  const projectedByRow = new WeakMap<object, string>();
  return (collection: Record<string, T>): string => {
    if (collection === lastRef) return lastSig;
    const parts: string[] = [];
    for (const id in collection) {
      const row = collection[id];
      if (row !== null && typeof row === "object") {
        let projected = projectedByRow.get(row);
        if (projected === undefined) {
          projected = project(row);
          projectedByRow.set(row, projected);
        }
        parts.push(projected);
      } else {
        parts.push(project(row));
      }
    }
    lastRef = collection;
    // Newline-joined so two distinct collections can't concatenate into one
    // string; project() outputs never contain a newline.
    lastSig = parts.join("\n");
    return lastSig;
  };
}
