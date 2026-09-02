import type { PendingEntry } from "./types";

function fieldEchoesPending(
  field: string,
  incoming: unknown,
  pending: unknown,
  optionalClearFields?: ReadonlySet<string>,
): boolean {
  // A server may omit an optional field when it is clear, while an optimistic
  // write retains the local `null` spelling. For the fields the app declares
  // that way, both spellings are the same acknowledgement — without the
  // equivalence such a pending lock would never retire and would keep
  // re-asserting the clear. Every other field keeps strict null/undefined
  // semantics.
  if (incoming === pending) return true;
  if (optionalClearFields?.has(field) && incoming == null && pending == null) {
    return true;
  }
  // Array/object-valued protected fields (e.g. a row's label id list) arrive
  // from the server as fresh references on every push, so reference equality
  // alone would keep their pending lock alive forever and freeze the field.
  // Compare by value instead — pending fields are few and small, so the JSON
  // stringify here is far cheaper than the permanent override it prevents.
  if (
    incoming !== null && pending !== null &&
    typeof incoming === "object" && typeof pending === "object"
  ) {
    try {
      return JSON.stringify(incoming) === JSON.stringify(pending);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Local-first sync: pending entries represent local mutations waiting for
 * server acknowledgment.  They never expire by time — they clear only when
 * the server confirms the change.
 *
 *   exclude — record was deleted locally; block server from re-adding it.
 *             Clears when the server stops sending the record.
 *   include — record was added locally; keep it even if server doesn't
 *             send it yet.  Clears when the server starts sending it.
 *   field   — field was changed locally; override server value.
 *             Clears when the server value matches the local value.
 */

// Whether two records are equal across all SCALAR fields (string / number /
// boolean / null / undefined). This is the version key for identity reuse (see
// the call site): reuse the prev object only when nothing the UI renders has
// changed.
//
// Why scalars only: live queries resend nested objects/arrays as fresh
// references on every push, so comparing them by reference would force endless
// churn, and a deep compare is too costly on this hot path. We skip them and
// rely on updated_at (itself a scalar, compared here) bumping on real content
// edits to cover the nested case. ignoreFields opts a known per-push-churning
// scalar out of the comparison — a perf escape hatch whose mistakes cost an
// extra render, never a dropped update.
//
// This replaced an updated_at-only check, which silently dropped changes to any
// field the server derives independently of updated_at — pinning a row in the
// wrong place until an unrelated edit bumped updated_at.
function scalarFieldsEqual(a: any, b: any, ignoreFields?: Set<string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (ignoreFields?.has(k)) continue;
    const av = a[k];
    const bv = b[k];
    // null is a scalar for our purposes; only non-null objects/arrays are skipped.
    const aScalar = av === null || typeof av !== "object";
    const bScalar = bv === null || typeof bv !== "object";
    // A field crossing between scalar and object (null → {…}, {…} → undefined)
    // is a real change, not nested churn: the anchor space's `anchor` going
    // from null to a row is exactly what flips onboarding to the real page.
    if (aScalar !== bScalar) return false;
    if (!aScalar) continue;
    if (av !== bv) return false;
  }
  return true;
}

export function applySyncTable<T extends { _id: string }>(
  tableName: string,
  incoming: T[],
  pending: Record<string, PendingEntry>,
  prev?: Record<string, T>,
  opts?: {
    isDelta?: boolean;
    ignoreFields?: string[];
    preserveFields?: string[];
    pruneAbsentScope?: (record: T) => boolean;
    optionalClearFields?: ReadonlySet<string>;
  },
): { table: Record<string, T>; pending: Record<string, PendingEntry> } {
  // Copy-on-write: most pushes change no pending entry (heartbeat re-sends,
  // overlay top-ups), and an always-fresh pending object woke every subscriber
  // of `pending` and re-persisted the map to IDB on each ~1s push.
  // The original ref is returned untouched unless something actually mutates.
  let newPending = pending;
  let pendingMutated = false;
  const mutPending = (): Record<string, PendingEntry> => {
    if (!pendingMutated) { newPending = { ...pending }; pendingMutated = true; }
    return newPending;
  };
  const table: Record<string, T> = {};
  const incomingMap = new Map(incoming.map(r => [r._id, r]));
  const incomingIds = new Set(incomingMap.keys());
  const prefix = `${tableName}:`;
  const isDelta = !!opts?.isDelta;
  const ignoreFields = opts?.ignoreFields ? new Set(opts.ignoreFields) : undefined;
  const preserveFields = opts?.preserveFields;
  const pruneAbsentScope = opts?.pruneAbsentScope;
  const optionalClearFields = opts?.optionalClearFields;

  // ONE pass over pending, partitioned into O(1)-consumable shapes. The naive
  // shape rebuilt Object.entries(newPending) and string-scanned the WHOLE
  // pending map for EVERY incoming row — O(incoming × pending). Exclude
  // tombstones never clear for delta tables (absence ≠ deletion), so pending
  // grows with every removal and that product turns quadratic: a measured
  // 1,832-entry pending map made each ~1s 152-row push do ~280k startsWith
  // checks (~100ms), which alone pinned the main thread.
  const excludeIds = new Set<string>();
  const includeIds: string[] = [];
  let fieldsByRecord: Map<string, Array<{ key: string; field: string; entry: PendingEntry }>> | null = null;
  for (const [key, entry] of Object.entries(newPending)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const colon = rest.indexOf(":");
    if (colon === -1) {
      if (entry.type === "exclude") excludeIds.add(rest);
      else if (entry.type === "include") includeIds.push(rest);
    } else if (entry.type === "field") {
      const id = rest.slice(0, colon);
      if (!fieldsByRecord) fieldsByRecord = new Map();
      let arr = fieldsByRecord.get(id);
      if (!arr) fieldsByRecord.set(id, (arr = []));
      arr.push({ key, field: rest.slice(colon + 1), entry });
    }
  }

  // Ids with ANY local pending state — never prune these (an optimistic write
  // must not be discarded because a full fetch raced it).
  let pendingIds: Set<string> | null = null;
  if (pruneAbsentScope) {
    pendingIds = new Set(excludeIds);
    for (const id of includeIds) pendingIds.add(id);
    if (fieldsByRecord) for (const id of fieldsByRecord.keys()) pendingIds.add(id);
  }

  // Confirmed excludes — server no longer sends the record.
  // In delta mode the incoming set is partial by definition, so an absent
  // record means "unchanged", not "deleted". Skip the exclude-clearing
  // pass; soft-deletes still arrive as updated rows.
  if (!isDelta) {
    for (const id of excludeIds) {
      if (!incomingIds.has(id)) {
        delete mutPending()[prefix + id];
        excludeIds.delete(id);
      }
    }
  }

  const applyFieldOverrides = (record: T): T => {
    const overrides = fieldsByRecord?.get(record._id);
    if (!overrides) return record;
    let merged = record;
    for (const { key, field, entry } of overrides) {
      if (fieldEchoesPending(field, (record as any)[field], entry.value, optionalClearFields)) {
        delete mutPending()[key];
      } else {
        if (merged === record) merged = { ...record };
        (merged as any)[field] = entry.value;
      }
    }
    return merged;
  };

  // Snapshot mode: walk prev first to preserve ordering, then copy any
  // incoming-only records at the tail. Records absent from incoming are
  // dropped (server is authoritative).
  //
  // Delta mode: keep ALL prev rows; overlay incoming. Absence != deletion.
  if (prev) {
    for (const id of Object.keys(prev)) {
      if (excludeIds.has(id)) continue;
      const incomingRecord = incomingMap.get(id);
      if (incomingRecord) {
        let merged = applyFieldOverrides(incomingRecord);
        const prevRecord = prev[id];
        if (preserveFields && prevRecord) {
          // Overlay-owned fields (e.g. heartbeat liveness) arrive on a separate
          // channel; the base payload carries null for them. Fill the gap from
          // prev's (overlay-set) value so the base sync doesn't clobber the
          // overlay between its ticks. A REAL incoming value still applies, so
          // this only fills nulls. Then reuse prev's identity if only overlay
          // fields would have differed.
          //
          // A preserved field CAN be non-scalar (e.g. a carried comment list),
          // which scalarFieldsEqual skips — so a row whose only change is a
          // carried fresh array must not reuse prev, or the update is silently
          // dropped. Content-compare carried preserved values to decide; when
          // equal, the fresh-but-identical array also must not break identity
          // reuse.
          let preservedEqual = true;
          for (const f of preserveFields) {
            const mv = (merged as any)[f];
            const pv = (prevRecord as any)[f];
            if (mv == null && pv != null) {
              if (merged === incomingRecord) merged = { ...incomingRecord };
              (merged as any)[f] = pv;
            } else if (mv !== pv && JSON.stringify(mv) !== JSON.stringify(pv)) {
              preservedEqual = false;
            }
          }
          table[id] =
            preservedEqual && scalarFieldsEqual(prevRecord, merged, ignoreFields)
              ? prevRecord
              : merged;
        } else {
          // Preserve the previous object identity when nothing the UI renders has
          // changed. Live queries resend the ENTIRE result set as fresh objects
          // on any change, so without this one updated row churns the identity of
          // every other row and defeats React.memo for all of them (e.g. every
          // list card re-rendering on every row's heartbeat).
          // scalarFieldsEqual is the version key — it covers every scalar field,
          // so a change the server derives independently of updated_at can't be
          // swallowed. Skip the reuse when a pending field override produced a
          // fresh object (merged !== incomingRecord) so local-first values stick.
          table[id] =
            merged === incomingRecord &&
            prevRecord &&
            scalarFieldsEqual(prevRecord, incomingRecord, ignoreFields)
              ? prevRecord
              : merged;
        }
      } else if (isDelta) {
        // Scoped authoritative prune: when the caller certifies `incoming` is the
        // COMPLETE server set for a scope, an in-scope record absent from it is a
        // server-side deletion. Plant an exclude — the store's deletion contract,
        // and what authorizes the IDB diff to remove the row durably (a bare
        // store-shrink is ignored there, and hydration would resurrect the row).
        // Out-of-scope records and records with pending local state keep the
        // normal delta behavior.
        if (pruneAbsentScope && pruneAbsentScope(prev[id]) && !pendingIds!.has(id)) {
          mutPending()[`${tableName}:${id}`] = { type: "exclude", ts: Date.now() };
          continue;
        }
        table[id] = prev[id];
      }
    }
  }

  // Append records new in incoming (not previously seen) at the end
  for (const record of incoming) {
    if (excludeIds.has(record._id)) continue;
    if (table[record._id]) continue;
    table[record._id] = applyFieldOverrides(record);
  }

  // Include entries — locally-added records the server hasn't acknowledged.
  // Same delta caveat: don't clear an include just because this partial
  // batch didn't carry the record.
  for (const id of includeIds) {
    if (!isDelta && incomingIds.has(id)) {
      delete mutPending()[prefix + id];
    } else if (prev?.[id] && !table[id]) {
      table[id] = prev[id];
    }
  }

  // Whole-collection identity reuse: when every row kept its previous identity
  // and no row was added or dropped, hand back the previous collection object.
  // A no-op push then short-circuits everything downstream — no store commit,
  // no subscriber wake, no IDB re-put of the collection.
  if (prev) {
    const tableKeys = Object.keys(table);
    if (tableKeys.length === Object.keys(prev).length) {
      let same = true;
      for (const k of tableKeys) {
        if (table[k] !== prev[k]) { same = false; break; }
      }
      if (same) return { table: prev, pending: newPending };
    }
  }
  return { table, pending: newPending };
}

/**
 * Apply pending protection to a single-record sync (e.g. syncRecord).
 * Returns the protected record and updated pending state.
 */
/**
 * Pending protection for a PARTIAL patch (a merge patch that names only the
 * fields it changes, plus `unset` for removed ones). Unlike applySyncRecord,
 * which treats a missing key as the server's value, this visits ONLY the locks
 * for fields the patch or unset names: a lock on a field the patch omits is
 * re-asserted untouched (a local clear is recorded as a lock with value
 * undefined, and `undefined === undefined` would otherwise retire it before the
 * clear has landed). A field in `unset` is the server saying "absent": it
 * echoes an undefined-valued lock (and a null-valued one for optionalClear
 * fields), retiring it; otherwise the lock wins and the unset is dropped.
 */
export function applySyncPatch(
  tableName: string,
  id: string,
  patch: Record<string, any>,
  unset: readonly string[],
  pending: Record<string, PendingEntry>,
  optionalClearFields?: ReadonlySet<string>,
): { fields: Record<string, any>; unset: string[]; pending: Record<string, PendingEntry> } {
  const newPending = { ...pending };
  const excludeKey = `${tableName}:${id}`;
  if (newPending[excludeKey]?.type === "exclude") {
    return { fields: patch, unset: [...unset], pending: newPending };
  }
  const fields: Record<string, any> = { ...patch };
  const keptUnset: string[] = [];
  const prefix = `${tableName}:${id}:`;
  const consider = (field: string, incoming: unknown, isUnset: boolean): boolean => {
    const key = prefix + field;
    const entry = newPending[key];
    if (!entry || entry.type !== "field") return true;
    if (fieldEchoesPending(field, incoming, entry.value, optionalClearFields)) {
      delete newPending[key];
      return true;
    }
    // Lock wins: the local value stays, the server's write for this field is
    // ignored until it echoes.
    if (isUnset) return false;
    fields[field] = entry.value;
    return true;
  };
  for (const field of Object.keys(patch)) consider(field, patch[field], false);
  for (const field of unset) {
    if (field in fields) continue;
    if (consider(field, undefined, true)) keptUnset.push(field);
  }
  return { fields, unset: keptUnset, pending: newPending };
}

export function applySyncRecord(
  tableName: string,
  id: string,
  incoming: Record<string, any>,
  pending: Record<string, PendingEntry>,
  optionalClearFields?: ReadonlySet<string>,
): { record: Record<string, any>; pending: Record<string, PendingEntry> } {
  const newPending = { ...pending };

  const excludeKey = `${tableName}:${id}`;
  if (newPending[excludeKey]?.type === "exclude") {
    return { record: incoming, pending: newPending };
  }

  let merged = incoming;
  const fieldPrefix = `${tableName}:${id}:`;
  for (const [key, entry] of Object.entries(newPending)) {
    if (entry.type !== "field" || !key.startsWith(fieldPrefix)) continue;
    const field = key.slice(fieldPrefix.length);
    if (fieldEchoesPending(field, incoming[field], entry.value, optionalClearFields)) {
      delete newPending[key];
    } else {
      if (merged === incoming) merged = { ...incoming };
      merged[field] = entry.value;
    }
  }

  return { record: merged, pending: newPending };
}
