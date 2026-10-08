import { describe, expect, test } from "bun:test";
import { listedBlockers, listedReady } from "./listedReadiness";

describe("listed readiness", () => {
  // tasks.list judged ct-2 ready: its blocker ct-1 is done, though blocked_by still names it.
  test("a ready row whose blocker finished is not tagged blocked", () => {
    const row = { status: "open", blocked_by: ["ct-1"], open_blockers: [], ready: true };
    expect(listedBlockers(row)).toEqual([]);
    expect(listedReady(row)).toBe(true);
  });

  test("a row still held lists what holds it, waits included", () => {
    const row = { status: "open", blocked_by: ["ct-1"], open_blockers: ["ct-1", "PR #42 merged"], ready: false };
    expect(listedBlockers(row)).toEqual(["ct-1", "PR #42 merged"]);
    expect(listedReady(row)).toBe(false);
  });

  test("backlog with no blockers is not ready", () => {
    expect(listedReady({ status: "backlog", open_blockers: [], ready: false })).toBe(false);
  });

  test("a row from an older server falls back to its raw blocked_by", () => {
    expect(listedBlockers({ status: "open", blocked_by: ["ct-1"] })).toEqual(["ct-1"]);
    expect(listedReady({ status: "open" })).toBe(true);
  });
});
