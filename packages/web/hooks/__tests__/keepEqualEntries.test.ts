import { expect, test } from "bun:test";
import { keepEqualEntries } from "../useSyncTasks";

// webActiveSessions re-sends the whole task → agent map, freshly decoded, on
// any agent status flip. A row's pill reads its own entry, so an entry that
// did not change keeps its reference, and a push that changed nothing keeps
// the map.

const entry = (status: string) => ({ conversation_id: "c1", session_id: "s1", agent_status: status });

test("an identical push keeps the map", () => {
  const prev = { t1: entry("working"), t2: entry("idle") };
  expect(keepEqualEntries(prev, JSON.parse(JSON.stringify(prev)))).toBe(prev);
});

test("only the changed entry is new", () => {
  const prev = { t1: entry("working"), t2: entry("idle") };
  const next = keepEqualEntries(prev, { t1: entry("working"), t2: entry("working") });
  expect(next).not.toBe(prev);
  expect(next.t1).toBe(prev.t1);
  expect(next.t2).toEqual(entry("working"));
});

test("added and dropped entries count as changes", () => {
  const prev = { t1: entry("working") };
  const added = keepEqualEntries(prev, { t1: entry("working"), t2: entry("idle") });
  expect(Object.keys(added)).toEqual(["t1", "t2"]);
  expect(added.t1).toBe(prev.t1);
  const swapped = keepEqualEntries(prev, { t2: entry("working") });
  expect(Object.keys(swapped)).toEqual(["t2"]);
  expect(keepEqualEntries(prev, {})).toEqual({});
  const empty = {};
  expect(keepEqualEntries(empty, {})).toBe(empty);
});
