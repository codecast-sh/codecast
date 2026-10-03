import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { performUndo } from "../undoStack";

// Every field gesture is a store action with an undo spec, and the engine
// records every cell the action wrote. The rule these tests pin: a gesture's
// undo restores EVERY field the action touched, not just the one the gesture
// is named after. Each of these actions clears a snooze on the way
// (clearSessionSnoozeInDraft), so undoing one has to give the snooze back —
// the hand-written versions of defer and pin did not, and silently ate it.
const ID = "jx7testconv000000000000000000000";
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
  beforeEach(() => { _resetUndoStacks(); seed(); });

  test("defer clears the snooze, and undo puts it back on both rows", () => {
    useInboxStore.getState().deferSession(ID);
    expect(row().is_deferred).toBe(true);
    expect(row().inbox_snoozed_until).toBe(null);

    performUndo();
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    expect(conv().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    expect(row().is_deferred ?? null).toBe(null);
  });

  test("a rest verdict is undone whole: verdict, stamp, and the snooze it cleared", () => {
    useInboxStore.getState().setSessionRest(ID, "dormant");
    expect(row().user_rest).toBe("dormant");
    expect(row().inbox_snoozed_until).toBe(null);

    performUndo();
    expect(row().user_rest ?? null).toBe(null);
    expect(row().inbox_rest ?? null).toBe(null);
    expect(row().inbox_rest_at ?? null).toBe(null);
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
  });

  test("pin the same way, and its undo releases the pending locks it took", () => {
    useInboxStore.getState().pinSession(ID);
    expect(row().is_pinned).toBe(true);
    expect(row().inbox_snoozed_until).toBe(null);

    performUndo();
    expect(row().is_pinned ?? null).toBe(null);
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    // The pin's own locks are released: what holds the row until the server
    // echoes is a lock on each RESTORED value, never on the pin.
    const locks = Object.entries(useInboxStore.getState().pending as Record<string, any>)
      .filter(([k]) => k.startsWith(`sessions:${ID}:`));
    expect(locks.length).toBeGreaterThan(0);
    for (const [key, lock] of locks) {
      expect(lock.value ?? null).toBe(key.endsWith(":inbox_snoozed_until") ? SNOOZE_UNTIL : null);
    }
  });

  test("the undo dispatches the restored stamps, so the server converges too", () => {
    // applyUndoPatches is a no-op action whose ARGUMENT is the authoritative
    // patch set; the durable outbox carries it so a reload cannot lose the
    // undo's server half.
    const undoPatches: Array<Record<string, any>> = [];
    const owner = {};
    useInboxStore.getState()._setDispatch(async (action, _args, patches) => {
      if (action === "applyUndoPatches") undoPatches.push((patches ?? {}) as Record<string, any>);
      return null;
    }, { owner });
    try {
      useInboxStore.getState().deferSession(ID);
      performUndo();
      const stamps = undoPatches.flatMap((p) => Object.values(p.conversations ?? {}));
      expect(stamps.some((f: any) => f.inbox_snoozed_until === SNOOZE_UNTIL)).toBe(true);
      expect(stamps.some((f: any) => f.inbox_deferred_at === null)).toBe(true);
    } finally {
      useInboxStore.getState()._clearDispatch(owner);
    }
  });

  // B2: the forward write's locks held the forward value, so a push that still
  // carried it (the server applied the gesture before the undo landed) used to
  // put it back. The undo replaces those locks with the restored values.
  const lockedOn = () => Object.keys(useInboxStore.getState().pending).filter((k) => k.includes(ID));
  const push = (fields: Record<string, any>) => {
    useInboxStore.getState().syncTable("sessions", [{ _id: ID, title: "Test session", updated_at: 1, ...fields }] as any);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID, title: "Test session", ...fields }] as any);
  };

  test("defer: a stale push after the undo does not re-defer, and the echo leaves no lock", () => {
    useInboxStore.getState().deferSession(ID);
    const deferredAt = row().inbox_deferred_at;
    performUndo();

    push({ inbox_deferred_at: deferredAt, inbox_snoozed_until: null });
    expect(row().inbox_deferred_at ?? null).toBe(null);
    expect(conv().inbox_deferred_at ?? null).toBe(null);
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);

    push({ inbox_snoozed_until: SNOOZE_UNTIL });
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    expect(lockedOn()).toEqual([]);
  });

  test("rest verdict: a stale push after the undo does not re-file, and the echo leaves no lock", () => {
    useInboxStore.getState().setSessionRest(ID, "done");
    const restAt = row().inbox_rest_at;
    performUndo();

    push({ inbox_rest: "done", inbox_rest_at: restAt, inbox_snoozed_until: null });
    expect(conv().inbox_rest ?? null).toBe(null);
    expect(row().inbox_rest ?? null).toBe(null);
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);

    push({ inbox_snoozed_until: SNOOZE_UNTIL });
    expect(lockedOn()).toEqual([]);
  });

  test("pin: a stale push after the undo does not re-pin, and the echo leaves no lock", () => {
    useInboxStore.getState().pinSession(ID);
    const pinnedAt = row().inbox_pinned_at;
    performUndo();

    push({ inbox_pinned_at: pinnedAt, is_pinned: true, inbox_snoozed_until: null });
    expect(row().inbox_pinned_at ?? null).toBe(null);
    expect(conv().inbox_pinned_at ?? null).toBe(null);

    push({ inbox_snoozed_until: SNOOZE_UNTIL });
    expect(row().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    expect(lockedOn()).toEqual([]);
  });
});

// An agent, model or project switch is applied to the live session (a /model
// message, switchSessionAgent, reconfigureSession), which a field restore
// cannot reverse, so none of them lands on the stack.
describe("live switches are not undoable", () => {
  beforeEach(() => { _resetUndoStacks(); seed({ agent_type: "claude_code", model: "opus" }); });

  test("switching agent, model, definition or project records nothing", () => {
    const s = useInboxStore.getState();
    s.setConversationAgent(ID, "codex");
    s.setConversationModel(ID, "gpt-5");
    s.setConversationAgentDefinition(ID, "reviewer");
    s.updateSessionProject(ID, "/tmp/other");
    expect(getUndoHistory().items).toHaveLength(0);
    expect(performUndo()).toBe(false);
    expect(row().agent_type).toBe("codex");
  });
});
