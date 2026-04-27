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
): { table: Record<string, T>; pending: Record<string, PendingEntry> } {
  const newPending = { ...pending };
  const table: Record<string, T> = {};
  const incomingMap = new Map(incoming.map(r => [r._id, r]));
  const incomingIds = new Set(incomingMap.keys());
  const prefix = `${tableName}:`;

  // Confirmed excludes — server no longer sends the record
  for (const [key, entry] of Object.entries(newPending)) {
    if (!key.startsWith(prefix)) continue;
    if (entry.type === "exclude") {
      const id = key.slice(prefix.length);
      if (!incomingIds.has(id)) {
        delete newPending[key];
      }
    }
  }

  // Local-first ordering: walk prev keys first so existing records keep
  // their position; server sync only updates fields, not order. Records
  // dropped by server (not in incoming) are removed.
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

  if (prev) {
    for (const id of Object.keys(prev)) {
      const excludeKey = `${tableName}:${id}`;
      if (newPending[excludeKey]?.type === "exclude") continue;
      const incomingRecord = incomingMap.get(id);
      if (incomingRecord) {
        table[id] = applyFieldOverrides(incomingRecord);
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

  // Include entries — locally-added records the server hasn't acknowledged
  for (const [key, entry] of Object.entries(newPending)) {
    if (!key.startsWith(prefix) || entry.type !== "include") continue;
    const id = key.slice(prefix.length);
    if (incomingIds.has(id)) {
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
