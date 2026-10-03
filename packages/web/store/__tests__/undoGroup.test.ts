import { beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { performUndo, performRedo } from "../undoStack";
import { animatedHideSessions, fileSessionsAsRest } from "../undoActions";
import { labelSessions } from "../../lib/labelSessions";

// Filing a selection is one gesture, so it is one undo: every row's exit
// animation runs first, then all of them are filed inside one undoGroup.
const IDS = ["a", "b", "c"].map((ch) => ch.repeat(32));
const SNOOZE_UNTIL = 1800000000000;

function seed() {
  const sessions: Record<string, unknown> = {};
  const conversations: Record<string, unknown> = {};
  for (const [i, id] of IDS.entries()) {
    // The middle row was snoozed: filing clears it, and the undo gives it back.
    const extra = i === 1 ? { inbox_snoozed_until: SNOOZE_UNTIL } : {};
    sessions[id] = { _id: id, title: `Row ${i}`, updated_at: 1, ...extra };
    conversations[id] = { _id: id, title: `Row ${i}`, ...extra };
  }
  useInboxStore.setState({ pending: {}, sessions, conversations } as any);
}

const rest = (id: string) => (useInboxStore.getState().sessions[id] as any)?.inbox_rest ?? null;

describe("fileSessionsAsRest", () => {
  beforeEach(() => { _resetUndoStacks(); seed(); });

  test("three rows file as one entry, and one undo restores all three", async () => {
    await fileSessionsAsRest(IDS, "done");
    expect(IDS.map(rest)).toEqual(["done", "done", "done"]);

    const items = getUndoHistory().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Filed 3 sessions as Done");
    expect(items[0]!.children).toHaveLength(3);

    expect(performUndo()).toBe(true);
    expect(IDS.map(rest)).toEqual([null, null, null]);
    expect((useInboxStore.getState().sessions[IDS[1]!] as any).inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    expect(getUndoHistory().items[0]!.status).toBe("undone");

    expect(performRedo()).toBe(true);
    expect(IDS.map(rest)).toEqual(["done", "done", "done"]);
  });

  test("one row keeps the action's own label", async () => {
    await fileSessionsAsRest([IDS[0]!], "dormant");
    expect(getUndoHistory().items[0]!.label).toBe("Filed “Row 0” as Dormant");
  });

  test("killed rows are skipped and record nothing", async () => {
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [IDS[0]!]: { ...s.sessions[IDS[0]!], inbox_killed_at: 5 } } }));
    await fileSessionsAsRest([IDS[0]!], "done");
    expect(rest(IDS[0]!)).toBe(null);
    expect(getUndoHistory().items).toHaveLength(0);
  });
});

describe("animatedHideSessions", () => {
  beforeEach(() => { _resetUndoStacks(); seed(); });
  const stashed = (id: string) => !!(useInboxStore.getState().sessions[id] as any)?.inbox_stashed_at;

  test("stashing a three-row selection is one entry, and one undo brings all three back", async () => {
    await animatedHideSessions(IDS, "stash");
    expect(IDS.map(stashed)).toEqual([true, true, true]);
    const items = getUndoHistory().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Stashed 3 sessions");

    expect(performUndo()).toBe(true);
    expect(IDS.map(stashed)).toEqual([false, false, false]);
  });

  test("killing a three-row selection is one entry", async () => {
    expect(await animatedHideSessions(IDS, "kill")).toEqual(IDS);
    const items = getUndoHistory().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toStartWith("Killed 3 sessions");
  });

  test("one row keeps the action's own label", async () => {
    await animatedHideSessions([IDS[0]!], "stash");
    expect(getUndoHistory().items[0]!.label).toBe("Stashed “Row 0”");
  });
});

describe("labelSessions", () => {
  const BUCKET = "e".repeat(32);
  beforeEach(() => {
    _resetUndoStacks();
    seed();
    useInboxStore.setState({ buckets: { [BUCKET]: { _id: BUCKET, name: "infra" } }, bucketAssignments: {} } as any);
  });

  test("the group label counts the rows it filed, not the stubs it skipped", () => {
    labelSessions([IDS[0]!, IDS[1]!, "stub-not-yet-created"], BUCKET);
    const items = getUndoHistory().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Labeled 2 sessions infra");
  });
});
