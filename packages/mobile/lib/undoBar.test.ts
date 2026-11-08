import { beforeEach, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { dismissUndoBar, holdKill, runHeldKill, UNDO_BAR_MS, useUndoBar } from "./undoBar";

const A = "a".repeat(32);
const B = "b".repeat(32);
const row = (id: string) => (useInboxStore.getState().sessions as any)[id];
const bar = () => useUndoBar.getState().item;

beforeEach(() => {
  runHeldKill();
  _resetUndoStacks();
  useUndoBar.setState({ item: null, heldKillId: null });
  useInboxStore.setState({
    pending: {}, currentSessionId: null, clientState: {},
    sessions: { [A]: { _id: A, title: "First", updated_at: 1 }, [B]: { _id: B, title: "Second", updated_at: 1 } },
    conversations: { [A]: { _id: A, title: "First" }, [B]: { _id: B, title: "Second" } },
  } as any);
});

test("a stash shows its own Undo, which puts the row back", () => {
  useInboxStore.getState().stashSession(A);
  expect(row(A).inbox_stashed_at).toBeTruthy();
  expect(bar()?.title).toBe("Stashed “First”");
  bar()!.onUndo!();
  expect(row(A).inbox_stashed_at ?? null).toBe(null);
  // The engine announces the undo on the same bar, with nothing to undo.
  expect(bar()?.title).toContain("Stashed “First”");
  expect(bar()?.onUndo).toBeUndefined();
});

test("a held kill touches nothing until it runs, and Undo drops it", () => {
  holdKill(A);
  expect(bar()?.title).toBe("Killing “First”");
  expect(bar()?.durationMs).toBe(UNDO_BAR_MS);
  expect(useUndoBar.getState().heldKillId).toBe(A);
  expect(row(A).inbox_dismissed_at ?? null).toBe(null);
  bar()!.onUndo!();
  expect(bar()).toBe(null);
  expect(useUndoBar.getState().heldKillId).toBe(null);
  runHeldKill();
  expect(row(A).inbox_dismissed_at ?? null).toBe(null);
});

test("a held kill runs when the bar drains, without a second Undo bar", () => {
  holdKill(A);
  dismissUndoBar(bar()!.key);
  expect(row(A).inbox_dismissed_at).toBeTruthy();
  expect(bar()).toBe(null);
  expect(getUndoHistory().items).toHaveLength(0);
});

test("a new bar runs the held kill first", () => {
  holdKill(A);
  useInboxStore.getState().stashSession(B);
  expect(row(A).inbox_dismissed_at).toBeTruthy();
  expect(useUndoBar.getState().heldKillId).toBe(null);
  expect(bar()?.title).toBe("Stashed “Second”");
});

test("a stale key does not take down a newer bar", () => {
  useInboxStore.getState().stashSession(A);
  const first = bar()!.key;
  useInboxStore.getState().stashSession(B);
  dismissUndoBar(first);
  expect(bar()?.title).toBe("Stashed “Second”");
});
