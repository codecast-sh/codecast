import { expect, test } from "bun:test";
import { applyPendingMessageWrite, pendingMessageWrites, pendingMessagesFromRecords, readPendingMessageJournal, writePendingMessageJournal, type PendingMessageRecord, type PendingMessageWrite, type PendingMessages } from "../pendingMessageJournal";

const message = (id: string) => ({ _id: id, _clientId: id, content: `message ${id}`, role: "user", timestamp: 1, _isOptimistic: true });
const apply = (writes: PendingMessageWrite[], initial: PendingMessageRecord[] = []) => {
  const rows = new Map(initial.map((row) => [row.id, row]));
  for (const write of writes) rows.set(write.id, applyPendingMessageWrite(rows.get(write.id), write));
  return [...rows.values()];
};
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); }, key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; } };
};

test("two windows sending to one conversation retain both messages", () => {
  const a = pendingMessageWrites({}, { c: [message("a")] });
  const b = pendingMessageWrites({}, { c: [message("b")] });
  expect(pendingMessagesFromRecords(apply([...a, ...b])).c.map(m => m._id)).toEqual(["a", "b"]);
});

test("a reload before IndexedDB commits recovers the exact input", () => {
  const disk = storage();
  const pending = { c: [{ ...message("a"), content: "hello\n\nworld", images: [{ storage_id: "image-1" }] }] };
  writePendingMessageJournal(disk, "owner", pendingMessageWrites({}, pending));
  expect(pendingMessagesFromRecords(apply(readPendingMessageJournal(disk).flatMap(b => b.writes)))).toEqual(pending);
});

test("journal writes fail synchronously so the caller cannot clear unsaved input", () => {
  const disk = storage();
  disk.setItem = () => { throw new Error("QuotaExceededError"); };
  expect(() => writePendingMessageJournal(disk, "owner", pendingMessageWrites({}, { c: [message("a")] }))).toThrow("QuotaExceededError");
  expect(disk.length).toBe(0);
});

test("a stale tab cannot resurrect an acknowledged message, regardless of flush order", () => {
  const before = { c: [message("a")] };
  const add = pendingMessageWrites({}, before);
  const ack = pendingMessageWrites(before, {});
  const stale = pendingMessageWrites(before, { c: [{ ...message("a"), _isQueued: true }] });
  for (const writes of [[...add, ...ack, ...stale], [...stale, ...ack, ...add], [...ack, ...add, ...stale]]) {
    expect(pendingMessagesFromRecords(apply(writes))).toEqual({});
  }
});

test("rekey moves the pending message without deleting it or another window's input", () => {
  const before = { stub: [message("a")] };
  const after = { real: [message("a")] };
  const records = apply([...pendingMessageWrites({}, before), ...pendingMessageWrites({}, { real: [message("b")] }), ...pendingMessageWrites(before, after)]);
  expect(pendingMessagesFromRecords(records)).toEqual({ real: [message("a"), message("b")] });
});

test("reordered writes and duplicate replay preserve prepared content and upload results", () => {
  const initial = { c: [message("a")] };
  const expanded: PendingMessages = { c: [{ ...message("a"), _dispatchContent: "exact expanded payload" }] };
  const uploaded: PendingMessages = { c: [{ ...expanded.c[0], images: [{ storage_id: "image-2" }] }] };
  const birth = pendingMessageWrites({}, initial);
  const expansion = pendingMessageWrites(initial, expanded);
  const upload = pendingMessageWrites(expanded, uploaded);
  expect(pendingMessagesFromRecords(apply([...upload, ...birth, ...expansion, ...birth, ...upload]))).toEqual(uploaded);
});

test("updates preserve fields learned in another window", () => {
  const initial = { c: [message("a")] };
  const expanded = { c: [{ ...message("a"), _dispatchContent: "prepared elsewhere" }] };
  const queued = { c: [{ ...message("a"), _isQueued: true }] };
  const rows = apply([...pendingMessageWrites({}, initial), ...pendingMessageWrites(initial, expanded), ...pendingMessageWrites(initial, queued)]);
  expect(pendingMessagesFromRecords(rows).c[0]).toMatchObject({ _dispatchContent: "prepared elsewhere", _isQueued: true });
});

test("unchanged state writes nothing and clearing one window does not remove another's message", () => {
  const a = { c: [message("a")] };
  expect(pendingMessageWrites(a, a)).toEqual([]);
  const rows = apply([...pendingMessageWrites({}, a), ...pendingMessageWrites({}, { c: [message("b")] }), ...pendingMessageWrites(a, {})]);
  expect(pendingMessagesFromRecords(rows)).toEqual({ c: [message("b")] });
});
