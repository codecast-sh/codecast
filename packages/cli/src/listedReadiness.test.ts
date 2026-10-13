import { describe, expect, test } from "bun:test";
import { formatWaitTime, prWords, type Blocker } from "@codecast/shared/tasks";
import { listedBlockers, listedReady } from "./listedReadiness";

const ct1: Blocker = { kind: "task", ref: "ct-1", status: "open" };
const pr42: Blocker = { kind: "pr_merged", repository: "o/r", pr_number: 42, id: "w1", state: "waiting", created_at: 1 };

describe("listed readiness", () => {
  // tasks.list judged ct-2 ready: its blocker ct-1 is done, though blocked_by still names it.
  test("a ready row whose blocker finished is not tagged blocked", () => {
    const row = { status: "open", blocked_by: ["ct-1"], open_blockers: [], ready: true };
    expect(listedBlockers(row)).toEqual([]);
    expect(listedReady(row)).toBe(true);
  });

  test("a row still held lists what holds it, waits included", () => {
    const row = { status: "open", blocked_by: ["ct-1"], open_blockers: [ct1, pr42], ready: false };
    expect(listedBlockers(row)).toEqual(["ct-1", "PR #42 merges"]);
    expect(listedReady(row)).toBe(false);
  });

  test("a PR in another repository than the checkout's is named in full", () => {
    const row = { status: "open", open_blockers: [pr42, { ...pr42, repository: "o/other", pr_number: 6 }], ready: false };
    expect(listedBlockers(row, prWords("o/r"))).toEqual(["PR #42 merges", "PR o/other#6 merges"]);
    expect(listedBlockers(row, prWords(null))).toEqual(["PR o/r#42 merges", "PR o/other#6 merges"]);
  });

  // The server sends the wait, not words: Convex runs in UTC and would print
  // a UTC wall time with no zone.
  test("a time wait is labelled in this machine's zone", () => {
    const at = Date.UTC(2030, 0, 15, 17, 0);
    const wait: Blocker = { kind: "time", at, id: "w2", state: "waiting", created_at: 1 };
    expect(listedBlockers({ open_blockers: [wait] })).toEqual([`until ${formatWaitTime(at)}`]);
  });

  test("backlog with no blockers is not ready", () => {
    expect(listedReady({ status: "backlog", open_blockers: [], ready: false })).toBe(false);
  });

  test("a row from an older server falls back to its labels, then its raw blocked_by", () => {
    expect(listedBlockers({ status: "open", open_blockers: ["ct-1"] })).toEqual(["ct-1"]);
    expect(listedBlockers({ status: "open", blocked_by: ["ct-1"] })).toEqual(["ct-1"]);
    expect(listedReady({ status: "open" })).toBe(true);
  });
});
