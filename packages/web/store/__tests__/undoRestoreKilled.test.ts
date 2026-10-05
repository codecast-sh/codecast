import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { performUndo } from "../undoStack";
import { UNDO_SPECS } from "../undo/policy";

// The server turns any write that sets inbox_dismissed_at over a row without
// one into a kill (cleanup.ts classifyHideTransition): teardown queued on the
// daemon, status completed, schedules canceled. So a gesture that brought a
// killed row back must never be undone by writing its dismissed stamp again:
// the agent may be running by then, and the stale guard sees only the inbox
// stamps. Such a gesture is not recorded; a restore of a stashed row still is.
const ID = "k".repeat(32);
const KILLED_AT = 1700000000000;
const owner = Symbol("restore-killed");
let sent: Array<{ action: string; args: unknown[]; patches: any }> = [];

const row = (extra: Record<string, unknown> = {}) =>
  ({ _id: ID, session_id: "sess-k", title: "Old worker", updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false, ...extra }) as InboxSession;

function seed(extra: Record<string, unknown>) {
  useInboxStore.setState({
    sessions: { [ID]: row(extra) },
    conversations: { [ID]: { _id: ID, title: "Old worker", ...extra } },
    pending: {},
    currentSessionId: null,
    clientState: {},
  } as any);
}

const killed = { inbox_dismissed_at: KILLED_AT, inbox_killed_at: KILLED_AT, status: "completed" };
const labels = () => getUndoHistory().items.map((i) => i.label);
const reKills = () => sent.some((s) => Object.values<any>(s.patches?.conversations ?? {}).some((f) => !!f.inbox_dismissed_at) || ["killSession", "killSessions"].includes(s.action));

describe("undoing a restore of a killed session", () => {
  beforeEach(() => {
    _resetUndoStacks();
    sent = [];
    useInboxStore.getState()._setDispatch(async (action, args, patches) => {
      sent.push({ action, args, patches });
      return null;
    }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("restoreSession of a killed row is not recorded, so ⌘Z cannot re-kill a revived agent", () => {
    seed(killed);
    useInboxStore.getState().restoreSession(ID);
    expect(labels()).toEqual([]);
    // The agent revived after the restore.
    useInboxStore.getState().syncTable("sessions", [row({ inbox_dismissed_at: null, inbox_killed_at: null, status: "active", message_count: 5 })]);
    sent = [];
    performUndo();
    expect(reKills()).toBe(false);
  });

  test("patchConversation clearing a kill (the /sessions restore) is not recorded either", () => {
    seed(killed);
    useInboxStore.getState().patchConversation(ID, { inbox_dismissed_at: null, inbox_stashed_at: null } as any);
    expect(labels()).toEqual([]);
    sent = [];
    performUndo();
    expect(reKills()).toBe(false);
  });

  test("a restore of a stashed row stays undoable", () => {
    seed({ inbox_stashed_at: KILLED_AT });
    useInboxStore.getState().restoreSession(ID);
    expect(labels()).toEqual(["Restored “Old worker”"]);
  });

  // The class guard: no spec, present or future, records a call that cleared
  // a kill, because the rule wraps every spec rather than living in one.
  test("every undo spec declines a call that cleared a killed row's stamp", () => {
    const before = { sessions: { [ID]: row(killed) }, conversations: { [ID]: { _id: ID, ...killed } } };
    const changes = [{ store: "sessions", id: ID, field: "inbox_dismissed_at", before: KILLED_AT, hadBefore: true, after: null, hadAfter: true }];
    for (const [name, spec] of Object.entries(UNDO_SPECS)) {
      const label = spec.label({ action: name, args: [ID, {}], before, after: before, result: null, changes } as any);
      expect([name, label]).toEqual([name, null]);
    }
  });
});
