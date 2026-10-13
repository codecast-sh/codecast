import { describe, expect, test } from "bun:test";
import { labelTurns, snapshotAtLine, type TurnSnapshotRow } from "./turns.js";

const row = (sha: string, at: number, extra: Partial<TurnSnapshotRow> = {}): TurnSnapshotRow => ({
  sha, tree_sha: `t${sha}`, base_sha: "base", depth: 1, changed_paths: [], changed_count: 0, dirty: true,
  source: "turn", taken_at: at, turn_completed_at: at, ...extra,
});
const msgs = [
  { role: "human", content: "fix the login bug", timestamp: 1000 },
  { role: "assistant", content: "done", timestamp: 1500 },
  { role: "human", content: "now add a test for it please, a long one that goes past the clip width of the ask column", timestamp: 3000 },
  { role: "assistant", content: "added", timestamp: 3500 },
  { role: "human", content: "ship", timestamp: 5000 },
];

describe("labelTurns", () => {
  test("each snapshot closes the turn whose ask precedes it, in cast read numbering", () => {
    const turns = labelTurns([row("b", 4000), row("a", 2000)], msgs);
    expect(turns.map((t) => [t.index, t.row.sha, t.askLine, t.lastLine])).toEqual([[1, "a", 1, 2], [2, "b", 3, 4]]);
    expect(turns[0].ask).toBe("fix the login bug");
    expect(turns[1].ask!.length).toBeLessThanOrEqual(72);
    expect(turns[1].ask!.endsWith("…")).toBe(true);
  });
  test("a sweep with nothing new after the last turn carries no ask", () => {
    const turns = labelTurns([row("a", 2000), row("s", 2500, { source: "sweep", turn_completed_at: undefined })], msgs);
    expect(turns[1].askLine).toBeUndefined();
    expect(turns[1].lastLine).toBeUndefined();
  });
});

describe("snapshotAtLine", () => {
  const rows = [row("a", 2000), row("b", 4000)];
  test("the tree as it stood when the message was sent: the newest snapshot at or before it", () => {
    // Line 2 is the assistant's reply inside the first turn: that turn's
    // snapshot (2000) is later than the reply (1500), so nothing yet.
    expect(snapshotAtLine(rows, msgs, 2)).toBeNull();
    expect(snapshotAtLine(rows, msgs, 3)?.sha).toBe("a");
    expect(snapshotAtLine(rows, msgs, 4)?.sha).toBe("a");
    expect(snapshotAtLine(rows, msgs, 5)?.sha).toBe("b");
  });
  test("null before any snapshot, or past the transcript", () => {
    expect(snapshotAtLine(rows, msgs, 1)).toBeNull();
    expect(snapshotAtLine(rows, msgs, 99)).toBeNull();
  });
});
