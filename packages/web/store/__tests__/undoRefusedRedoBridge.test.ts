import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { setGestureChannelFactory } from "../gestureBridge";
import { declareViewNav } from "../viewNav";
import { performRedo, performUndo } from "../undoStack";

// A redo the engine refuses (a field the gesture never captured changed since
// the undo) has already run the action body on a draft it throws away. The
// body's sibling-window broadcast must be thrown away with it: a sibling that
// applied it would hide a row this window kept, under a bridge lock that
// outlives the server's live row.
const ID = "a".repeat(32);
const ME = "m".repeat(32);
const posted: any[] = [];
const factory = (_name: string) =>
  ({
    postMessage(data: any) { posted.push(structuredClone(data)); },
    addEventListener() {},
    removeEventListener() {},
    close() {},
  }) as unknown as BroadcastChannel;

const row = (over: Record<string, unknown> = {}) => ({
  _id: ID, session_id: "s", title: "Row A", updated_at: 1, agent_type: "claude_code", message_count: 1,
  is_idle: true, has_pending: false, user_id: ME, ...over,
});
const s = () => useInboxStore.getState() as any;

function seed() {
  declareViewNav("gesture");
  useInboxStore.setState({
    sessions: { [ID]: row() },
    conversations: { [ID]: { _id: ID, is_own: true, title: "Row A" } },
    messages: {}, pendingMessages: {}, pagination: {}, pendingSessionCreates: {}, pending: {},
    currentSessionId: null, viewingDismissedId: null, currentUser: { _id: ME }, clientState: {},
  } as any);
}

beforeEach(() => { _resetUndoStacks(); posted.length = 0; setGestureChannelFactory(factory); seed(); });
afterEach(() => { setGestureChannelFactory(null); });

for (const verb of ["killSession", "stashSession"] as const) {
  test(`a refused ${verb} redo tells no sibling window anything`, () => {
    s()[verb](ID);
    expect(performUndo()).toBe(true);
    // Another device pins the row after the undo.
    s().syncTable("sessions", [row({ updated_at: 2, is_pinned: true, inbox_pinned_at: 5 })], { isDelta: true });
    expect(s().sessions[ID].is_pinned).toBe(true);
    const before = posted.length;
    performRedo();
    expect(getUndoHistory().redoOrder.length + getUndoHistory().items.length).toBeGreaterThan(0);
    expect(s().sessions[ID].is_pinned).toBe(true);
    expect(s().sessions[ID].inbox_dismissed_at ?? null).toBeNull();
    expect(s().sessions[ID].inbox_stashed_at ?? null).toBeNull();
    expect(posted.slice(before).filter((m) => m.kind === "hide" || m.kind === "pin")).toEqual([]);
  });
}

// A redo the vet sends down the field-restore path (redoPartial) never re-runs
// the action, so the action's own announcement never goes out. The replay
// must announce the exact values it wrote, as an undo's replay does, or
// sibling windows keep the undone pin.
test("a pin redo landed as a field restore tells sibling windows the restored pin", () => {
  s().pinSession(ID);
  const pinnedAt = s().sessions[ID].inbox_pinned_at;
  expect(typeof pinnedAt).toBe("number");
  expect(performUndo()).toBe(true);
  expect(!!s().sessions[ID].is_pinned).toBe(false);
  // Another device snoozes the row after the undo. Re-running pinSession
  // would clear that snooze, a cell the undo never judged: the vet refuses
  // the re-run and the redo writes the captured pin values instead.
  s().syncTable("sessions", [row({ updated_at: 2, inbox_snoozed_until: Date.now() + 3_600_000 })], { isDelta: true });
  const before = posted.length;
  performRedo();
  expect(s().sessions[ID].is_pinned).toBe(true);
  expect(s().sessions[ID].inbox_pinned_at).toBe(pinnedAt);
  expect(s().sessions[ID].inbox_snoozed_until).toBeGreaterThan(0);
  const sent = posted.slice(before);
  // The vetoed re-run's fresh-stamp pin is dropped with its draft.
  expect(sent.filter((m) => m.kind === "pin")).toEqual([]);
  const fields = sent.filter((m) => m.kind === "fields" && m.id === ID);
  expect(fields.length).toBe(1);
  expect(fields[0].exact).toBe(true);
  expect(fields[0].fields).toMatchObject({ is_pinned: true, inbox_pinned_at: pinnedAt });
});
