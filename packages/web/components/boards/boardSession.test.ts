import { describe, expect, test } from "bun:test";
import { clock, readSession, startVotingOps, toggleVoteOps, voteResults, votesUsed } from "./boardSession";
import type { BoardEl } from "./boardTypes";

const s = (key: string, votes?: string[]) => ({ key, kind: "sticky", rev: 1, ...(votes ? { votes } : {}) }) as BoardEl;

describe("dot voting", () => {
  test("a click adds my vote, a second click takes it back, and the limit holds", () => {
    expect(toggleVoteOps(s("a"), "me", 0, 3)).toEqual([{ k: "a", set: { votes: ["me"] } }]);
    expect(toggleVoteOps(s("a", ["you", "me"]), "me", 1, 3)).toEqual([{ k: "a", set: { votes: ["you"] } }]);
    expect(toggleVoteOps(s("b"), "me", 3, 3)).toBeNull();
  });
  test("used votes and results count across the board", () => {
    const els = [s("a", ["me", "you"]), s("b", ["me"]), s("c")];
    expect(votesUsed(els, "me")).toBe(2);
    expect(voteResults(els)).toEqual([{ key: "a", count: 2 }, { key: "b", count: 1 }]);
  });
  test("starting a vote opens the session and clears the last round", () => {
    const ops = startVotingOps([s("a", ["me"]), s("b")], false);
    expect(ops[0]).toEqual({ k: "el_session", put: { kind: "session", voting: { open: true, per: 3 }, timer: null } });
    expect(ops[1]).toEqual({ k: "a", set: { votes: null } });
    expect(ops.length).toBe(2);
  });
  test("the session reads safely from whatever the element holds", () => {
    expect(readSession(undefined)).toEqual({ voting: null, timer: null });
    expect(readSession({ key: "el_session", kind: "session", rev: 1, voting: { open: false, per: 5 }, timer: { ends_at: 10, ms: 60000 } } as BoardEl))
      .toEqual({ voting: { open: false, per: 5 }, timer: { ends_at: 10, ms: 60000 } });
  });
  test("the timer shows m:ss, never below zero", () => {
    expect(clock(61_000)).toBe("1:01");
    expect(clock(-5)).toBe("0:00");
  });
});
