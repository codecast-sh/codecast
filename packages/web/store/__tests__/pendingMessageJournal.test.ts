import { expect, test } from "bun:test";
import { formatDecisionAnswer } from "@codecast/shared/contracts";
import { applyPendingMessageWrite, pendingMessageWrites, pendingMessagesFromRecords, readPendingMessageJournal, retireStalePendingRecords, writePendingMessageJournal, type PendingMessageRecord, type PendingMessageWrite, type PendingMessages } from "../pendingMessageJournal";

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

test("a row journaled under the old settled-control flag hydrates as settled", () => {
  const a = pendingMessageWrites({}, { c: [{ ...message("a"), content: "[Request interrupted by user]", _isSettledControl: true }] });
  const [row] = pendingMessagesFromRecords(apply(a)).c;
  expect(row._isSettled).toBe(true);
  expect("_isSettledControl" in row).toBe(false);
});

test("a reload before IndexedDB commits recovers the exact input", () => {
  const disk = storage();
  const pending = { c: [{ ...message("a"), content: "hello\n\nworld", images: [{ storage_id: "image-1" }] }] };
  writePendingMessageJournal(disk, "owner", pendingMessageWrites({}, pending));
  expect(pendingMessagesFromRecords(apply(readPendingMessageJournal(disk).flatMap(b => b.writes)))).toEqual(pending);
});

test("getAllKeys is scanned once when provided, not once per stored key", () => {
  const values = new Map<string, string>();
  for (let i = 0; i < 200; i++) values.set(`noise-${i}`, "x");
  values.set("cast-pending-input:v1:owner:1", JSON.stringify({ ownerId: "owner", writes: pendingMessageWrites({}, { c: [message("a")] }) }));
  let allCalls = 0;
  let keyCalls = 0;
  const disk = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, v); },
    removeItem: (k: string) => { values.delete(k); },
    key: (i: number) => { keyCalls++; return [...values.keys()][i] ?? null; },
    get length() { return values.size; },
    getAllKeys: () => { allCalls++; return [...values.keys()]; },
  };
  const batches = readPendingMessageJournal(disk);
  expect(allCalls).toBe(1);
  expect(keyCalls).toBe(0);
  expect(batches).toHaveLength(1);
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

// Every window journaled a copy of each failed send whenever any pending row
// changed: the copy is a fresh object (replication clones it), so the row was
// rewritten with a new conversationId stamp and nothing else.
test("a fresh copy of an unchanged message journals nothing", () => {
  const sent = { ...message("a"), _isFailed: true, images: [{ storage_id: "image-1" }] };
  const copy = structuredClone(sent);
  expect(pendingMessageWrites({ c: [sent] }, { c: [copy] })).toEqual([]);
  expect(pendingMessageWrites({ c: [sent] }, { c: [copy, message("b")] }).map((w) => w.id)).toEqual(["b"]);
  expect(pendingMessageWrites({ c: [sent] }, { c: [{ ...copy, images: [] }] })[0].fields).toEqual({ images: [] });
});

// A failed send is kept for its retry, and only an echo retires a pending
// row, so failed sends nobody typed (a revive's "continue", an interrupt
// marker) sat on the desktop app's disk for weeks.
test("a failed machine send an hour old retires at load; a person's own failed message stays", () => {
  const now = 10 * 3_600_000;
  const old = now - 2 * 3_600_000;
  const row = (id: string, content: string, extra: Record<string, unknown> = {}) =>
    apply(pendingMessageWrites({}, { c: [{ _id: id, _clientId: id, role: "user", content, timestamp: old, _isOptimistic: true, _isFailed: true, ...extra }] }))[0];
  const records = [
    row("acct-revive-abc-jx7conv", "continue"),
    row("continue-blocked-jx7conv-29781734", "continue"),
    row("optimistic_1_interrupt", "[Request interrupted by user]"),
    row("optimistic_2_typed", "please fix the build"),
    row("acct-revive-new-jx7conv", "continue", { timestamp: now - 60_000 }),
    row("revive-jx7conv-1", "continue", { _isFailed: undefined }),
  ];
  const { kept, retired } = retireStalePendingRecords(records, now);
  expect(retired.map((r) => r.id)).toEqual(["acct-revive-abc-jx7conv", "continue-blocked-jx7conv-29781734", "optimistic_1_interrupt"]);
  expect(retired.every((r) => r.removed)).toBe(true);
  expect(kept.map((r) => r.id)).toEqual(["optimistic_2_typed", "acct-revive-new-jx7conv", "revive-jx7conv-1"]);
  // A tombstone holds: a stale window's later copy cannot bring the row back.
  expect(applyPendingMessageWrite(retired[0], pendingMessageWrites({}, { c: [records[0].message] })[0]).removed).toBe(true);
});

// A settled send retires only on its echo or a later row, read while its
// conversation is open, so the desktop app kept settled interrupts, /model
// lines, poll answers and typed messages from September in a conversation
// nobody reopened.
test("a settled send a day old retires at load; a hosted approval's answer stays", () => {
  const now = 100 * 3_600_000;
  const old = now - 25 * 3_600_000;
  const row = (id: string, content: string, extra: Record<string, unknown> = {}) =>
    apply(pendingMessageWrites({}, { c: [{ _id: id, _clientId: id, role: "user", content, timestamp: old, _isSettled: true, ...extra }] }))[0];
  const answer = formatDecisionAnswer({ id: "k97decision", question: "Ship?", answer: "Yes" });
  const records = [
    row("optimistic_1_poll", '{"__cc_poll":true,"keys":["1"]}'),
    row("optimistic_2_legacy", "[Request interrupted by user]", { _isSettled: undefined, _isSettledControl: true }),
    row("optimistic_3_typed", "Okay, done."),
    row("optimistic_4_answer", answer),
    row("optimistic_5_recent", "status?", { timestamp: now - 3_600_000 }),
    row("optimistic_6_unsettled", "still sending", { _isSettled: undefined, _isOptimistic: true }),
  ];
  const { kept, retired } = retireStalePendingRecords(records, now);
  expect(retired.map((r) => r.id)).toEqual(["optimistic_1_poll", "optimistic_2_legacy", "optimistic_3_typed"]);
  expect(kept.map((r) => r.id)).toEqual(["optimistic_4_answer", "optimistic_5_recent", "optimistic_6_unsettled"]);
});
