import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { performUndo } from "../undoStack";
import { undoableDeferSession, undoablePinSession, undoableSetSessionRest } from "../undoActions";

// Every field gesture routes through undoableFieldGesture, which names the
// fields it stamps in one place. The rule these tests pin: a gesture's undo
// restores EVERY field the action touched, not just the one the gesture is
// named after. Each of these actions clears a snooze on the way
// (clearSessionSnoozeInDraft), so undoing one has to give the snooze back —
// the hand-written versions of defer and pin did not, and silently ate it.
const ID = "jx7testconv00000000000000000000";
const SNOOZE_UNTIL = 1800000000000;

const seed = (extra: Record<string, any> = {}) => {
  useInboxStore.setState({
    pending: {},
    sessions: { [ID]: { _id: ID, title: "Test session", updated_at: 1, inbox_snoozed_until: SNOOZE_UNTIL, ...extra } } as any,
    conversations: { [ID]: { _id: ID, title: "Test session", inbox_snoozed_until: SNOOZE_UNTIL, ...extra } } as any,
  });
};

const row = () => useInboxStore.getState().sessions[ID] as any;
const conv = () => useInboxStore.getState().conversations[ID] as any;

describe("undoable field gestures restore every field the action touched", () => {
  beforeEach(() => { seed(); });

  test("defer clears the snooze, and undo puts it back on both rows", () => {
    undoableDeferSession(ID);
    expect(row().is_deferred).toBe(true);
    expect(row().inbox_snoozed_until).toBe(null);

    performUndo();
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    expect(conv().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    expect(row().is_deferred ?? null).toBe(null);
  });

  test("a rest verdict is undone whole: verdict, stamp, and the snooze it cleared", () => {
    undoableSetSessionRest(ID, "dormant");
    expect(row().user_rest).toBe("dormant");
    expect(row().inbox_snoozed_until).toBe(null);

    performUndo();
    expect(row().user_rest ?? null).toBe(null);
    expect(row().inbox_rest ?? null).toBe(null);
    expect(row().inbox_rest_at ?? null).toBe(null);
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
  });

  test("pin the same way, and its undo releases the pending locks it took", () => {
    undoablePinSession(ID);
    expect(row().is_pinned).toBe(true);
    expect(row().inbox_snoozed_until).toBe(null);

    performUndo();
    expect(row().is_pinned ?? null).toBe(null);
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    const locks = Object.keys(useInboxStore.getState().pending).filter((k) => k.startsWith(`sessions:${ID}:`));
    expect(locks).toEqual([]);
  });

  test("the undo dispatches the restored stamps, so the server converges too", () => {
    // applyUndoPatches is a no-op action whose ARGUMENT is the authoritative
    // patch set; the durable outbox carries it so a reload cannot lose the
    // undo's server half.
    const undoPatches: Array<Record<string, any>> = [];
    const owner = {};
    useInboxStore.getState()._setDispatch(async (action, args) => {
      if (action === "applyUndoPatches") undoPatches.push(args[0] as Record<string, any>);
      return null;
    }, { owner });
    try {
      undoableDeferSession(ID);
      performUndo();
      const stamps = undoPatches.flatMap((p) => Object.values(p.conversations ?? {}));
      expect(stamps.some((f: any) => f.inbox_snoozed_until === SNOOZE_UNTIL)).toBe(true);
      expect(stamps.some((f: any) => f.inbox_deferred_at === null)).toBe(true);
    } finally {
      useInboxStore.getState()._clearDispatch(owner);
    }
  });
});
