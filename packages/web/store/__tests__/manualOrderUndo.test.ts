import { beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { performRedo, performUndo } from "../undoStack";

// Dragging inbox cards is an edit like every sibling reorder (label chips,
// task order, decision stacks): one entry per drag, block drags included,
// that puts the order back.
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function row(id: string, title: string): InboxSession {
  return { _id: id, session_id: `sess-${id}`, title, updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false } as InboxSession;
}
const stamp = () => (useInboxStore.getState().clientState as any).ui?.["inbox_manual_order:ts"] as number;
const order = () => (useInboxStore.getState().clientState as any).ui?.inbox_manual_order;

describe("dragging inbox cards is undoable", () => {
  beforeEach(() => {
    _resetUndoStacks();
    useInboxStore.setState({
      sessions: { [A]: row(A, "Alpha"), [B]: row(B, "Beta"), [C]: row(C, "Gamma") },
      conversations: {},
      pending: {},
      clientState: { ui: { inbox_manual_order: { [C]: 10 } } },
    } as any);
  });

  test("one card: one entry naming it, undo and redo", () => {
    useInboxStore.getState().setSessionManualOrders({ [A]: 5 });
    expect(order()).toEqual({ [C]: 10, [A]: 5 });
    expect(getUndoHistory().items[0]!.label).toBe("Moved “Alpha”");
    const stamped = stamp();
    performUndo();
    expect(order()).toEqual({ [C]: 10 });
    // Restamped, so the restored order wins last-writer-wins on other devices.
    expect(stamp()).toBeGreaterThanOrEqual(stamped);
    performRedo();
    expect(order()).toEqual({ [C]: 10, [A]: 5 });
  });

  test("a block of cards: one entry for the whole drag", () => {
    useInboxStore.getState().setSessionManualOrders({ [A]: 5, [B]: 6, [C]: 7 });
    const items = getUndoHistory().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Moved 3 sessions");
    performUndo();
    expect(order()).toEqual({ [C]: 10 });
  });

  test("other settings in the UI bag stay unrecorded", () => {
    useInboxStore.getState().updateClientUI({ sidebar_width: 300 } as any);
    expect(getUndoHistory().items).toHaveLength(0);
  });
});
