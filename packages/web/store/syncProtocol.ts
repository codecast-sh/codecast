export type PendingEntry = {
  type: "exclude" | "field";
  field?: string;
  value?: any;
  expiresAt: number;
};

export function applySyncTable<T extends { _id: string }>(
  tableName: string,
  incoming: T[],
  pending: Record<string, PendingEntry>,
): { table: Record<string, T>; pending: Record<string, PendingEntry> } {
  const newPending = { ...pending };
  const table: Record<string, T> = {};
  const now = Date.now();
  const incomingIds = new Set(incoming.map(r => r._id));
  const prefix = `${tableName}:`;

  for (const [key, entry] of Object.entries(newPending)) {
    if (!key.startsWith(prefix)) continue;
    if (now > entry.expiresAt) {
      delete newPending[key];
      continue;
    }
    if (entry.type === "exclude") {
      const id = key.slice(prefix.length);
      if (!incomingIds.has(id)) {
        delete newPending[key];
      }
    }
  }

  for (const record of incoming) {
    const excludeKey = `${tableName}:${record._id}`;
    if (newPending[excludeKey]?.type === "exclude") continue;

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
    table[record._id] = merged;
  }

  return { table, pending: newPending };
}
