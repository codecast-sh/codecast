export type PendingEntry = {
  type: "exclude" | "include" | "field";
  value?: any;
  ts?: number;
};

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
// Why scalars only: Convex live queries resend nested objects/arrays as fresh
// references on every push, so comparing them by reference would force endless
// churn, and a deep compare is too costly on this hot path. We skip them and
// rely on updated_at (itself a scalar, compared here) bumping on real content
// edits to cover the nested case. ignoreFields opts a known per-push-churning
// scalar out of the comparison — a perf escape hatch whose mistakes cost an
// extra render, never a dropped update.
//
// This replaced an updated_at-only check, which silently dropped changes to any
// field the server derives independently of updated_at (e.g. a session's
// agent_status / is_idle, computed from managed_sessions + an idle grace) —
// pinning a finished agent in the wrong inbox bucket until an unrelated edit
// bumped updated_at.
function scalarFieldsEqual(a: any, b: any, ignoreFields?: Set<string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (ignoreFields?.has(k)) continue;
    const av = a[k];
    const bv = b[k];
    // null is a scalar for our purposes; only non-null objects/arrays are skipped.
    const aScalar = av === null || typeof av !== "object";
    const bScalar = bv === null || typeof bv !== "object";
    if (!aScalar || !bScalar) continue;
    if (av !== bv) return false;
  }
  return true;
}

export function applySyncTable<T extends { _id: string }>(
  tableName: string,
  incoming: T[],
  pending: Record<string, PendingEntry>,
  prev?: Record<string, T>,
  opts?: { isDelta?: boolean; ignoreFields?: string[]; preserveFields?: string[] },
): { table: Record<string, T>; pending: Record<string, PendingEntry> } {
  const newPending = { ...pending };
  const table: Record<string, T> = {};
  const incomingMap = new Map(incoming.map(r => [r._id, r]));
  const incomingIds = new Set(incomingMap.keys());
  const prefix = `${tableName}:`;
  const isDelta = !!opts?.isDelta;
  const ignoreFields = opts?.ignoreFields ? new Set(opts.ignoreFields) : undefined;
  const preserveFields = opts?.preserveFields;

  // Confirmed excludes — server no longer sends the record.
  // In delta mode the incoming set is partial by definition, so an absent
  // record means "unchanged", not "deleted". Skip the exclude-clearing
  // pass; soft-deletes (status="dropped") still arrive as updated rows.
  if (!isDelta) {
    for (const [key, entry] of Object.entries(newPending)) {
      if (!key.startsWith(prefix)) continue;
      if (entry.type === "exclude") {
        const id = key.slice(prefix.length);
        if (!incomingIds.has(id)) {
          delete newPending[key];
        }
      }
    }
  }

  const applyFieldOverrides = (record: T): T => {
    let merged = record;
    const fieldPrefix = `${tableName}:${record._id}:`;
    for (const [key, entry] of Object.entries(newPending)) {
      if (entry.type !== "field" || !key.startsWith(fieldPrefix)) continue;
      const field = key.slice(fieldPrefix.length);
      if ((record as any)[field] === entry.value) {
        delete newPending[key];
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
      const excludeKey = `${tableName}:${id}`;
      if (newPending[excludeKey]?.type === "exclude") continue;
      const incomingRecord = incomingMap.get(id);
      if (incomingRecord) {
        let merged = applyFieldOverrides(incomingRecord);
        const prevRecord = prev[id];
        if (preserveFields && prevRecord) {
          // Overlay-owned fields (e.g. heartbeat liveness) arrive on a separate
          // channel (syncOverlay); the base payload carries null for them. Fill the
          // gap from prev's (overlay-set) value so the base sync doesn't clobber the
          // overlay between its ticks. A REAL incoming value still applies (the
          // reconcile crawl runs liveness-on), so this only fills nulls. Then reuse
          // prev's identity if only overlay fields would have differed.
          for (const f of preserveFields) {
            if ((merged as any)[f] == null && (prevRecord as any)[f] != null) {
              if (merged === incomingRecord) merged = { ...incomingRecord };
              (merged as any)[f] = (prevRecord as any)[f];
            }
          }
          table[id] = scalarFieldsEqual(prevRecord, merged, ignoreFields) ? prevRecord : merged;
        } else {
          // Preserve the previous object identity when nothing the UI renders has
          // changed. Convex live queries resend the ENTIRE result set as fresh
          // objects on any change, so without this one updated row churns the
          // identity of every other row and defeats React.memo for all of them
          // (e.g. every SessionCard re-rendering on every session's heartbeat).
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
        table[id] = prev[id];
      }
    }
  }

  // Append records new in incoming (not previously seen) at the end
  for (const record of incoming) {
    const excludeKey = `${tableName}:${record._id}`;
    if (newPending[excludeKey]?.type === "exclude") continue;
    if (table[record._id]) continue;
    table[record._id] = applyFieldOverrides(record);
  }

  // Include entries — locally-added records the server hasn't acknowledged.
  // Same delta caveat: don't clear an include just because this partial
  // batch didn't carry the record.
  for (const [key, entry] of Object.entries(newPending)) {
    if (!key.startsWith(prefix) || entry.type !== "include") continue;
    const id = key.slice(prefix.length);
    if (!isDelta && incomingIds.has(id)) {
      delete newPending[key];
    } else if (prev?.[id] && !table[id]) {
      table[id] = prev[id];
    }
  }

  return { table, pending: newPending };
}

/**
 * Apply pending protection to a single-record sync (e.g. syncRecord).
 * Returns the protected record and updated pending state.
 */
export function applySyncRecord(
  tableName: string,
  id: string,
  incoming: Record<string, any>,
  pending: Record<string, PendingEntry>,
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
    if (incoming[field] === entry.value) {
      delete newPending[key];
    } else {
      if (merged === incoming) merged = { ...incoming };
      merged[field] = entry.value;
    }
  }

  return { record: merged, pending: newPending };
}
