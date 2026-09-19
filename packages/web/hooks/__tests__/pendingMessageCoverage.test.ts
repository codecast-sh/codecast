import { expect, test } from "bun:test";
import { reconcilePendingMessageCoverage } from "../pendingMessageCoverage";

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
