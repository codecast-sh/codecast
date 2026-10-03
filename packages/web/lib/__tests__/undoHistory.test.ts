import { describe, expect, test } from "bun:test";
import {
  describeUndoObject,
  undoActLabel,
  undoHistoryFixture,
  undoTimelineNowSig,
  undoTimelineRows,
  UNDO_HISTORY_TIER,
} from "../undoHistory";

const NOW = new Date(2026, 9, 3, 12).getTime();
const WINDOW = 5 * 60_000;
const fx = undoHistoryFixture(NOW);
const model = undoTimelineRows(fx.snapshot, fx.state, NOW, WINDOW);
const row = (id: string, m = model) => m.rows.find((r) => r.id === id)!;

describe("undo timeline row model", () => {
  test("the tier is hidden", () => {
    expect(UNDO_HISTORY_TIER).toBe("hidden");
  });

  test("the now rule sits above the head; undone rows above it walk forward, done rows below walk back", () => {
    expect(model.headId).toBe("fx-status");
    expect(model.rows.slice(0, model.headIndex).map((r) => r.id)).toEqual(["fx-pin", "fx-file"]);
    expect(row("fx-status").act).toEqual({ kind: "back", steps: 1 });
    expect(row("fx-defer").act).toEqual({ kind: "back", steps: 2 });
    expect(row("fx-old").act).toEqual({ kind: "back", steps: 3 });
    expect(row("fx-file").act).toEqual({ kind: "forward", steps: 1 });
    expect(row("fx-pin").act).toEqual({ kind: "forward", steps: 2 });
    expect(undoActLabel(row("fx-defer").act)).toBe("Back 2");
    expect(undoActLabel(row("fx-status").act)).toBe("Back to here");
    expect(undoActLabel(row("fx-pin").act)).toBe("Forward to here");
  });

  test("with nothing left to undo the rule sits under the oldest undone row", () => {
    const items = fx.snapshot.items.map((i) => (i.status === "done" ? { ...i, status: "undone" as const, undoneAt: NOW } : i));
    const m = undoTimelineRows({ version: 2, items, head: null }, fx.state, NOW, WINDOW);
    const lastUndone = m.rows.map((r) => r.state).lastIndexOf("undone");
    expect(m.headIndex).toBe(lastUndone + 1);
    expect(m.rows.every((r) => r.act?.kind !== "back")).toBe(true);
  });

  test("dropped redo branches fold into one struck marker under the entry that set them aside", () => {
    expect(model.rows.some((r) => r.state === "dropped")).toBe(false);
    expect(row("fx-defer").setAside).toEqual({ count: 2, labels: ["Renamed “Ship it” to “Ship the changes page”", "Labeled “Ship the changes page” Review"] });
    // A dropped entry whose cause left the history stands alone, inert.
    const orphan = { id: "fx-orphan", label: "Pinned “x”", ts: NOW - 1000, status: "dropped" as const, droppedBy: "gone", mode: "generic" as const };
    const m = undoTimelineRows({ ...fx.snapshot, items: [orphan, ...fx.snapshot.items] }, fx.state, NOW, WINDOW);
    expect(row("fx-orphan", m).state).toBe("dropped");
    expect(row("fx-orphan", m).act).toBeNull();
  });

  test("expiry: the last minute counts down in 10s steps, then the row leaves the keyboard window", () => {
    // fx-defer is 4m20s old: 40s of keyboard reach left.
    expect(row("fx-defer").secondsLeft).toBe(40);
    expect(row("fx-defer").detail).toBe("can undo for 40s more");
    expect(row("fx-defer").expired).toBe(false);
    const later = undoTimelineRows(fx.snapshot, fx.state, NOW + 41_000, WINDOW);
    expect(row("fx-defer", later).expired).toBe(true);
    expect(row("fx-defer", later).secondsLeft).toBeNull();
    // A generic entry past the window is still reachable from the timeline.
    expect(row("fx-defer", later).act?.kind).toBe("back");
    expect(row("fx-defer", later).detail).toContain("older than 5 minutes");
    // A manual one is closed for good.
    expect(row("fx-manual").act).toBeNull();
    expect(row("fx-manual").detail).toBe("too old to take back");
  });

  test("the clock signature moves only on a minute or an expiry step", () => {
    const sig = undoTimelineNowSig(fx.snapshot, WINDOW);
    const base = NOW - (NOW % 60_000);
    expect(sig(base + 1_000)).toBe(sig(base + 2_000));
    // fx-defer crosses from 40s to 30s left between these two.
    expect(sig(NOW + 9_000)).not.toBe(sig(NOW + 11_000));
    expect(sig(NOW)).not.toBe(sig(NOW + 41_000));
  });

  test("partial, conflict, refused and external rows say what happened", () => {
    expect(row("fx-file").state).toBe("partial");
    expect(row("fx-file").detail).toBe("2 rows changed since, left as they are");
    expect(row("fx-file").fold?.label).toBe("3 sessions");
    expect(row("fx-pin").detail).toBe("undone just now");
    expect(row("fx-conflict").detail).toBe("changed since, can't be taken back");
    expect(row("fx-conflict").act).toBeNull();
    expect(row("fx-refused").detail).toBe("the server refused this change");
    expect(row("fx-refused").act).toBeNull();
    expect(row("fx-org").state).toBe("external");
    expect(row("fx-org").act).toEqual({ kind: "org" });
    expect(row("fx-org").detail).toBe("org change · opens the org record");
    expect(undoActLabel(row("fx-org").act)).toBe("Open in org record");
  });

  test("objects resolve live through the recent-visit shape", () => {
    expect(row("fx-pin").visits[0]?.title).toBe("Fix the auth race on sign-in");
    expect(row("fx-status").visits[0]?.objectType).toBe("task");
    expect(row("fx-status").detail).toContain("ct-4102");
    const renamed = { ...fx.state, tasks: { "fx-task": { ...fx.state.tasks["fx-task"], title: "Renamed live" } } };
    expect(row("fx-status", undoTimelineRows(fx.snapshot, renamed, NOW, WINDOW)).visits[0]?.title).toBe("Renamed live");
    expect(describeUndoObject({}, "tasks", "t1")).toEqual({ kind: "page", key: "page:/tasks/t1", ts: 0, path: "/tasks/t1", label: undefined });
    expect(describeUndoObject({ buckets: { b1: { name: "Review" } } }, "buckets", "b1")).toEqual({ kind: "view", key: "label:b1", ts: 0, label: "Review" });
    expect(describeUndoObject({ bucketAssignments: { a1: { conversation_id: "c1" } } }, "bucketAssignments", "a1")).toEqual({ kind: "session", key: "c1", ts: 0 });
    expect(describeUndoObject({}, "pending", "x")).toBeNull();
  });
});
