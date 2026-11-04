import { expect, test } from "bun:test";
import { LOST_SEND_GRACE_MS, reconcilePendingMessageCoverage } from "../pendingMessageCoverage";

const conversation = "a".repeat(32);
const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ _id: `local-${i}`, _clientId: `command-${i}` }));

test("settles confirmed control deliveries and exposes rejected sends without dropping their text", async () => {
  const settled: string[][] = [];
  const failed: string[][] = [];
  await reconcilePendingMessageCoverage({
    pending: { [conversation]: rows(3) },
    query: async () => ({ access: "granted", coverage: { kind: "command-ids", commandIds: [] }, delivery: { settled: ["command-0"], failed: ["command-1"] } }),
    settle: (_id, ids) => { settled.push(ids); },
    fail: (_id, ids) => { failed.push(ids); },
    isCurrent: () => true,
  });
  expect(settled).toEqual([["command-0"]]);
  expect(failed).toEqual([["command-1"]]);
});

test("drops a send cancelled outright, which no echo will ever retire", async () => {
  const dropped: string[][] = [];
  await reconcilePendingMessageCoverage({
    pending: { [conversation]: rows(3) },
    query: async () => ({ access: "granted", coverage: { kind: "command-ids", commandIds: ["command-2"] }, delivery: { settled: ["command-0", "command-1"], failed: [], cancelled: ["command-1", "command-2"] } }),
    settle: () => {},
    drop: (_id, ids) => { dropped.push(ids); },
    isCurrent: () => true,
  });
  // command-2's transcript row exists, so its bubble retires through the echo instead.
  expect(dropped).toEqual([["command-1"]]);
});

test("reconciles unopened conversations only with exact server command coverage", async () => {
  const settled: unknown[] = [];
  await reconcilePendingMessageCoverage({
    pending: { [conversation]: rows(2) },
    query: async () => ({ access: "granted", coverage: { kind: "command-ids", commandIds: ["command-0", "not-requested"] } }),
    settle: (...args) => settled.push(args),
    isCurrent: () => true,
  });
  expect(settled).toEqual([[conversation, ["command-0"]]]);
});

test("serializes large backlogs into server-sized batches and excludes unsent local drafts", async () => {
  let active = 0;
  const batches: number[] = [];
  await reconcilePendingMessageCoverage({
    pending: { [conversation]: [...rows(150), { _id: "draft", _isLocalQueue: true }], stub: rows(2) },
    query: async (_id, ids) => {
      expect(++active).toBe(1);
      batches.push(ids.length);
      await Bun.sleep(1);
      active--;
      return { access: "granted", coverage: { kind: "command-ids", commandIds: [] } };
    },
    settle: () => { throw new Error("No coverage was returned"); },
    isCurrent: () => true,
  });
  expect(batches).toEqual([64, 64, 22]);
});

test.each(["forbidden", "missing", "unauthenticated"])("preserves pending messages when access is %s", async access => {
  await reconcilePendingMessageCoverage({
    pending: { [conversation]: rows(1) },
    query: async () => ({ access }),
    settle: () => { throw new Error("Unconfirmed message removed"); },
    isCurrent: () => true,
  });
});

test("ignores an earlier account's response and stops further queries", async () => {
  let current = true;
  let queries = 0;
  await reconcilePendingMessageCoverage({
    pending: { [conversation]: rows(100) },
    query: async () => { queries++; current = false; return { access: "granted", coverage: { kind: "command-ids", commandIds: ["command-0"] } }; },
    settle: () => { throw new Error("Cross-account response applied"); },
    isCurrent: () => current,
  });
  expect(queries).toBe(1);
});

test("reports a conversation the server no longer has, once, without settling or failing its sends", async () => {
  const gone: string[] = [];
  await reconcilePendingMessageCoverage({
    pending: { [conversation]: rows(130) },
    query: async () => ({ access: "missing" }),
    settle: () => { throw new Error("Unconfirmed message settled"); },
    fail: () => { throw new Error("Message failed instead of the session being dropped"); },
    gone: id => { gone.push(id); },
    isCurrent: () => true,
  });
  expect(gone).toEqual([conversation]);
});

test("fails a send the server never received once it is past the grace and in no outbox", async () => {
  const NOW = 10_000_000;
  const old = NOW - LOST_SEND_GRACE_MS;
  const failed: string[][] = [];
  await reconcilePendingMessageCoverage({
    pending: {
      [conversation]: [
        { _id: "l-lost", _clientId: "lost", timestamp: old },
        { _id: "l-fresh", _clientId: "fresh", timestamp: NOW - 1_000 },
        { _id: "l-outbox", _clientId: "outbox", timestamp: old },
        { _id: "l-queued", _clientId: "queued", timestamp: old, _isQueued: true },
        { _id: "l-upload", _clientId: "upload", timestamp: old, images: [{ uploading: true }] },
      ],
    },
    query: async () => ({ access: "granted", coverage: { kind: "command-ids", commandIds: [] }, delivery: { settled: [], failed: [], unknown: ["lost", "fresh", "outbox", "queued", "upload"] } }),
    settle: () => {},
    fail: (_id, ids) => { failed.push(ids); },
    stillQueued: async () => (id) => id === "outbox",
    now: () => NOW,
    isCurrent: () => true,
  });
  expect(failed).toEqual([["lost"]]);
});

test("never reads the outbox when the server knows every send", async () => {
  let reads = 0;
  await reconcilePendingMessageCoverage({
    pending: { [conversation]: rows(2) },
    query: async () => ({ access: "granted", coverage: { kind: "command-ids", commandIds: ["command-0", "command-1"] } }),
    settle: () => {},
    stillQueued: async () => { reads++; return () => false; },
    isCurrent: () => true,
  });
  expect(reads).toBe(0);
});
