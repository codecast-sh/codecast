export type PendingMessage = { _id: string; _clientId?: string; [key: string]: any };
export type PendingMessages = Record<string, PendingMessage[]>;
export type PendingMessageWrite = {
  id: string;
  stamp: string;
  conversationId: string;
  fields?: Record<string, unknown>;
  unset?: string[];
  removed?: true;
};
export type PendingMessageRecord = {
  id: string;
  conversationId: string;
  message: PendingMessage;
  stamps: Record<string, string>;
  removed?: true;
};

let sequence = 0;
const writer = Math.random().toString(36).slice(2);

function indexPending(messages: PendingMessages): Map<string, { conversationId: string; message: PendingMessage }> {
  const entries = new Map<string, { conversationId: string; message: PendingMessage }>();
  for (const [conversationId, rows] of Object.entries(messages)) {
    for (const message of rows) entries.set(message._clientId || message._id, { conversationId, message });
  }
  return entries;
}

export function pendingMessageWrites(before: PendingMessages, after: PendingMessages): PendingMessageWrite[] {
  if (before === after) return [];
  const previous = indexPending(before);
  const next = indexPending(after);
  const stamp = `${String(Date.now()).padStart(16, "0")}:${String(++sequence).padStart(12, "0")}:${writer}`;
  const writes: PendingMessageWrite[] = [];
  for (const [id, row] of next) {
    const old = previous.get(id);
    if (old?.message === row.message && old.conversationId === row.conversationId) continue;
    const fields: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [key, value] of Object.entries(row.message)) {
      if (old && Object.is(old.message[key], value)) continue;
      if (value === undefined) unset.push(key);
      else fields[key] = value;
    }
    for (const key of Object.keys(old?.message ?? {})) {
      if (!(key in row.message)) unset.push(key);
    }
    writes.push({ id, stamp, conversationId: row.conversationId, fields, unset });
  }
  for (const [id, row] of previous) {
    if (!next.has(id)) writes.push({ id, stamp, conversationId: row.conversationId, removed: true });
  }
  return writes;
}

export function applyPendingMessageWrite(
  previous: PendingMessageRecord | undefined,
  write: PendingMessageWrite,
): PendingMessageRecord {
  if (previous?.removed) return previous;
  if (write.removed) return { id: write.id, conversationId: write.conversationId, message: { _id: write.id }, stamps: {}, removed: true };
  const row: PendingMessageRecord = previous
    ? { ...previous, message: { ...previous.message }, stamps: { ...previous.stamps } }
    : { id: write.id, conversationId: write.conversationId, message: { _id: write.id }, stamps: {} };
  if (write.stamp > (row.stamps.conversationId ?? "")) {
    row.conversationId = write.conversationId;
    row.stamps.conversationId = write.stamp;
  }
  for (const [field, value] of Object.entries(write.fields ?? {})) {
    if (write.stamp <= (row.stamps[field] ?? "")) continue;
    row.message[field] = value;
    row.stamps[field] = write.stamp;
  }
  for (const field of write.unset ?? []) {
    if (write.stamp <= (row.stamps[field] ?? "")) continue;
    delete row.message[field];
    row.stamps[field] = write.stamp;
  }
  return row;
}

export function pendingMessagesFromRecords(records: PendingMessageRecord[]): PendingMessages {
  const pending: PendingMessages = {};
  for (const row of records) {
    if (row.removed) continue;
    (pending[row.conversationId] ??= []).push(row.message);
  }
  for (const rows of Object.values(pending)) rows.sort((a, b) => (a._isLocalQueue && b._isLocalQueue ? (a._queuePosition ?? 0) - (b._queuePosition ?? 0) : 0) || a.timestamp - b.timestamp || a._id.localeCompare(b._id));
  return pending;
}

export type PendingJournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export const PENDING_JOURNAL_PREFIX = "cast-pending-input:v1:";

export function readPendingMessageJournal(storage: PendingJournalStorage): Array<{ key: string; ownerId: string; writes: PendingMessageWrite[] }> {
  const batches: Array<{ key: string; ownerId: string; writes: PendingMessageWrite[] }> = [];
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
  for (const key of keys) {
    if (!key?.startsWith(PENDING_JOURNAL_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw) batches.push({ key, ...JSON.parse(raw) });
  }
  return batches;
}

export function writePendingMessageJournal(storage: PendingJournalStorage, ownerId: string, writes: PendingMessageWrite[]): void {
  if (!writes.length) return;
  storage.setItem(`${PENDING_JOURNAL_PREFIX}${ownerId}:${writes[0].stamp}`, JSON.stringify({ ownerId, writes }));
}

export function clearPendingMessageJournal(storage: PendingJournalStorage): void {
  for (const { key } of readPendingMessageJournal(storage)) storage.removeItem(key);
}

export function queuedMessagesFromPending(pending: PendingMessages): Record<string, string[]> {
  const queues: Record<string, string[]> = {};
  for (const [conversationId, rows] of Object.entries(pending)) {
    const queued = rows.filter(message => message._isLocalQueue).sort((a, b) => (a._queuePosition ?? 0) - (b._queuePosition ?? 0)).map(message => message.content ?? "");
    if (queued.length) queues[conversationId] = queued;
  }
  return queues;
}

export function importLegacyQueuedMessages(queues: Record<string, string[]>): PendingMessages {
  const pending: PendingMessages = {};
  for (const [conversationId, texts] of Object.entries(queues)) {
    pending[conversationId] = texts.map((content, index) => {
      const id = `queued_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return { _id: id, _clientId: id, role: "user", content, timestamp: Date.now() + index, _isOptimistic: true, _isLocalQueue: true, _queuePosition: index };
    });
  }
  return pending;
}
