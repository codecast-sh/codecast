import { describe, expect, test } from "bun:test";
import { admit, drainQueue, mergeBackLabel, mergeBackNote, normalizeSubagentCaps, queueAhead, queuedLabel, type SlotRow } from "./subagentFleet";

const caps = (per_session: number, per_machine: number) => ({ per_session, per_machine });
const row = (id: string, slot: SlotRow["slot"], at: number, parent: string | null, device: string | null = "mac", c = caps(2, 8)): SlotRow =>
  ({ id, slot, at, parent, device, caps: c });

describe("normalizeSubagentCaps", () => {
  test("defaults are 10 per session and 24 per machine", () => {
    expect(normalizeSubagentCaps()).toEqual({ per_session: 10, per_machine: 24 });
  });
  test("takes positive whole numbers, from strings too, and drops the rest", () => {
    expect(normalizeSubagentCaps({ per_session: "6", per_machine: 0 })).toEqual({ per_session: 6, per_machine: 24 });
    expect(normalizeSubagentCaps({ per_session: 2.5, per_machine: -1 })).toEqual({ per_session: 10, per_machine: 24 });
  });
});

describe("admit", () => {
  test("a session at its limit queues, whatever the machine has free", () => {
    const running = [row("a", "running", 1, "p"), row("b", "running", 2, "p")];
    expect(admit({ parent: "p", device: "mac", caps: caps(2, 8) }, running)).toEqual({ start: false, full: "session" });
    expect(admit({ parent: "q", device: "mac", caps: caps(2, 8) }, running)).toEqual({ start: true });
  });
  test("the machine limit counts every session's workers on that machine only", () => {
    const running = [row("a", "running", 1, "p"), row("b", "running", 2, "q"), row("c", "running", 3, "r", "linux")];
    expect(admit({ parent: "s", device: "mac", caps: caps(4, 2) }, running)).toEqual({ start: false, full: "machine" });
    expect(admit({ parent: "s", device: "linux", caps: caps(4, 2) }, running)).toEqual({ start: true });
  });
});

describe("drainQueue", () => {
  test("starts queued rows first in, first out, up to the free slots", () => {
    const rows = [
      row("a", "running", 1, "p"),
      row("q2", "queued", 30, "p"),
      row("q1", "queued", 20, "p"),
    ];
    expect(drainQueue(rows)).toEqual(["q1"]);
  });
  test("a full session does not hold up another session's queued worker", () => {
    const rows = [
      row("a", "running", 1, "p"),
      row("b", "running", 2, "p"),
      row("p3", "queued", 10, "p"),
      row("q1", "queued", 20, "q"),
    ];
    expect(drainQueue(rows)).toEqual(["q1"]);
  });
  test("each start counts against the next one", () => {
    const rows = [row("q1", "queued", 1, "p"), row("q2", "queued", 2, "p"), row("q3", "queued", 3, "p")];
    expect(drainQueue(rows)).toEqual(["q1", "q2"]);
  });
  test("ties in time break by id, so the order never depends on read order", () => {
    const rows = [row("z", "queued", 5, "p", "mac", caps(1, 8)), row("m", "queued", 5, "p", "mac", caps(1, 8))];
    expect(drainQueue(rows)).toEqual(["m"]);
    expect(drainQueue([...rows].reverse())).toEqual(["m"]);
  });
});

describe("queueAhead", () => {
  test("counts earlier queued rows that share the session or the machine", () => {
    const rows = [
      row("a", "running", 1, "p"),
      row("q1", "queued", 10, "p"),
      row("q2", "queued", 20, "x", "mac"),
      row("q3", "queued", 30, "y", "linux"),
      row("me", "queued", 40, "p", "mac"),
    ];
    expect(queueAhead("me", rows)).toBe(2);
    expect(queueAhead("q1", rows)).toBe(0);
    expect(queueAhead("a", rows)).toBe(0);
    expect(queuedLabel(2)).toBe("queued, 2 ahead");
    expect(queuedLabel(0)).toBe("queued, next");
  });
});

describe("merge back copy", () => {
  test("labels and the parent's note name the files", () => {
    expect(mergeBackLabel({ state: "merged", files: ["a.ts"] })).toBe("merged 1 file");
    expect(mergeBackLabel({ state: "conflict", files: ["a.ts", "b.ts"] })).toBe("conflict, 2 files");
    const note = mergeBackNote({ short_id: "jx7abcd", worktree_path: "/r/.codecast/worktrees/w" }, { state: "conflict", files: ["a.ts"] }, "done")!;
    expect(note).toContain("- a.ts");
    expect(note).toContain("/r/.codecast/worktrees/w");
    expect(mergeBackNote({ short_id: "jx7abcd" }, { state: "kept" }, "blocked")).toContain("ended blocked");
    expect(mergeBackNote({ short_id: "jx7abcd" }, { state: "pending" }, "done")).toBeNull();
  });
});
