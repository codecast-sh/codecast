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

export function applySyncTable<T extends { _id: string }>(
  tableName: string,
  incoming: T[],
  pending: Record<string, PendingEntry>,
  prev?: Record<string, T>,
  opts?: { isDelta?: boolean },
): { table: Record<string, T>; pending: Record<string, PendingEntry> } {
  const newPending = { ...pending };
  const table: Record<string, T> = {};
  const incomingMap = new Map(incoming.map(r => [r._id, r]));
  const incomingIds = new Set(incomingMap.keys());
  const prefix = `${tableName}:`;
  const isDelta = !!opts?.isDelta;

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
        table[id] = applyFieldOverrides(incomingRecord);
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
