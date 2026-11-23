import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { performUndo } from "../undoStack";
import { animatedCloseSessions } from "../undoActions";

// Close: a session mid-turn is set aside (stash) and keeps running; every
// other one is hidden like a kill, role seats included, with nothing asked.
// Both go out under the close action names, which tell the server to keep
// the session's triggers and queue (dispatch.ts EXPLICIT_CLOSE_ACTIONS).
const IDLE = "a".repeat(32);
const BUSY = "b".repeat(32);
const SEAT = "c".repeat(32);
const NOW = Date.now();
const owner = Symbol("close-session");
let sent: Array<{ action: string; args: unknown[]; patches: any; result: any }> = [];

const row = (id: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, session_id: `s-${id}`, title: `Row ${id[0]}`, agent_type: "claude_code", message_count: 8, agent_status: "idle", updated_at: NOW - 3_600_000, last_heartbeat: NOW - 1000, ...extra }) as InboxSession;

function seed() {
  const rows = [row(IDLE), row(BUSY, { agent_status: "working", updated_at: NOW - 1000 }), row(SEAT, { standing_role_id: "r1" })];
  useInboxStore.setState({
    sessions: Object.fromEntries(rows.map((r) => [r._id, r])),
    conversations: Object.fromEntries(rows.map((r) => [r._id, { ...r }])),
    pending: {},
    currentSessionId: null,
    clientState: {},
  } as any);
}

const get = (id: string) => useInboxStore.getState().sessions[id] as any;

describe("closeSessions", () => {
  beforeEach(() => {
    _resetUndoStacks();
    sent = [];
    seed();
    useInboxStore.getState()._setDispatch(async (action, args, patches, result) => {
      sent.push({ action, args, patches, result });
      return null;
    }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("a running session is set aside; an idle one and a role's own are closed", () => {
    useInboxStore.getState().closeSessions([IDLE, BUSY, SEAT]);
    expect(get(BUSY).inbox_stashed_at).toBeGreaterThan(0);
    expect(get(BUSY).inbox_dismissed_at ?? null).toBeNull();
    expect(get(IDLE).inbox_dismissed_at).toBeGreaterThan(0);
    expect(get(SEAT).inbox_dismissed_at).toBeGreaterThan(0);
  });

  test("an idle lead whose subagent is mid-turn is set aside, and nothing in its group is stopped", () => {
    const CHILD = "d".repeat(32);
    useInboxStore.setState((s: any) => ({
      sessions: { ...s.sessions, [CHILD]: row(CHILD, { agent_status: "working", updated_at: NOW - 1000, parent_conversation_id: IDLE, is_subagent: true }) },
    }));
    useInboxStore.getState().closeSession(IDLE);
    expect(get(IDLE).inbox_stashed_at).toBeGreaterThan(0);
    expect(get(IDLE).inbox_dismissed_at ?? null).toBeNull();
    expect(get(CHILD).inbox_dismissed_at ?? null).toBeNull();
    const close = sent.find((s) => s.action === "closeSession");
    expect(close?.result).toEqual({ aside: [IDLE] });
    expect(Object.values<any>(close?.patches.conversations ?? {}).some((f) => !!f.inbox_dismissed_at)).toBe(false);
  });

  test("a lead whose nested child holds any in-flight fact is set aside, and the child is untouched", () => {
    const CHILD = "d".repeat(32);
    const cases: Record<string, Record<string, unknown>> = {
      loop: { loop_state: { status: "armed", wakeup_at: NOW + 600_000, armed_at: NOW, event_at: NOW } },
      limit: { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000 },
      workflow: { workflow_run_id: "w1", workflow_run_status: "running", workflow_run_kind: "workflow" },
      queued: { has_pending: true },
      awaiting: { awaiting_input: true },
    };
    for (const [name, extra] of Object.entries(cases)) {
      seed();
      const child = row(CHILD, { parent_conversation_id: IDLE, is_subagent: true, ...extra });
      useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [CHILD]: child }, conversations: { ...s.conversations, [CHILD]: { ...child } } }));
      const out = useInboxStore.getState().closeSession(IDLE);
      expect([name, out?.aside]).toEqual([name, [IDLE]]);
      expect([name, get(IDLE).inbox_dismissed_at ?? null]).toEqual([name, null]);
      expect([name, get(CHILD).inbox_dismissed_at ?? null, get(CHILD).inbox_closed_at ?? null]).toEqual([name, null, null]);
    }
  });

  test("a close of a lead neither re-stamps nor sends its already-closed and killed children; a finished one goes with it", () => {
    const CLOSED_KID = "e".repeat(32);
    const KILLED_KID = "f".repeat(32);
    const DONE_KID = "9".repeat(32);
    const kid = (id: string, extra: Record<string, unknown>) => row(id, { parent_conversation_id: IDLE, is_subagent: true, status: "completed", ...extra });
    const kids = {
      [CLOSED_KID]: kid(CLOSED_KID, { status: "active", inbox_dismissed_at: 5, inbox_closed_at: 5 }),
      [KILLED_KID]: kid(KILLED_KID, { inbox_dismissed_at: 5, inbox_killed_at: 5 }),
      [DONE_KID]: kid(DONE_KID, {}),
    };
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...kids }, conversations: { ...s.conversations, ...kids } }));
    useInboxStore.getState().closeSession(IDLE);
    expect(get(CLOSED_KID).inbox_dismissed_at).toBe(5);
    expect(get(KILLED_KID).inbox_dismissed_at).toBe(5);
    expect(get(DONE_KID).inbox_dismissed_at).toBeGreaterThan(5);
    const sentRows = Object.keys(sent.find((s) => s.action === "closeSession")!.patches.conversations);
    expect(sentRows.sort()).toEqual([IDLE, DONE_KID].sort());
  });

  test("a fleet-queued worker is in flight: closing it, or its lead, sets it aside", () => {
    const Q = "8".repeat(32);
    const q = row(Q, { parent_conversation_id: IDLE, is_subagent: true, message_count: 0, subagent_slot: "queued" });
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [Q]: q }, conversations: { ...s.conversations, [Q]: { ...q } } }));
    expect(useInboxStore.getState().closeSessions([IDLE])?.aside).toEqual([IDLE]);
    expect(get(Q).inbox_dismissed_at ?? null).toBeNull();
  });

  test("a close writes inbox_closed_at equal to its dismissed stamp, and sends it", () => {
    useInboxStore.getState().closeSession(IDLE);
    expect(get(IDLE).inbox_closed_at).toBe(get(IDLE).inbox_dismissed_at);
    const close = sent.find((s) => s.action === "closeSession")!;
    const fields = close.patches.conversations[IDLE];
    expect(fields.inbox_closed_at).toBe(fields.inbox_dismissed_at);
  });

  test("an armed /loop or a queued message is in flight: the session is set aside, not stopped", () => {
    const LOOP = "e".repeat(32);
    const QUEUED = "f".repeat(32);
    useInboxStore.setState((s: any) => ({
      sessions: {
        ...s.sessions,
        [LOOP]: row(LOOP, { loop_state: { status: "armed", wakeup_at: NOW + 600_000, armed_at: NOW, event_at: NOW } }),
        [QUEUED]: row(QUEUED, { has_pending: true }),
      },
    }));
    const out = useInboxStore.getState().closeSessions([LOOP, QUEUED, IDLE]);
    expect(out?.aside.sort()).toEqual([LOOP, QUEUED].sort());
    for (const id of [LOOP, QUEUED]) {
      expect(get(id).inbox_stashed_at).toBeGreaterThan(0);
      expect(get(id).inbox_dismissed_at ?? null).toBeNull();
    }
    expect(get(IDLE).inbox_dismissed_at).toBeGreaterThan(0);
  });

  test("it goes out as one closeSessions dispatch naming the session it set aside", () => {
    useInboxStore.getState().closeSessions([IDLE, BUSY]);
    const close = sent.find((s) => s.action === "closeSessions");
    expect(close?.result).toEqual({ aside: [BUSY] });
    expect(close?.patches.conversations[IDLE].inbox_dismissed_at).toBeGreaterThan(0);
    expect(close?.patches.conversations[BUSY].inbox_stashed_at).toBeGreaterThan(0);
    expect(sent.some((s) => s.action === "killSession" || s.action === "killSessions")).toBe(false);
  });

  test("one undo entry, labeled Closed, puts every row back", async () => {
    await animatedCloseSessions([IDLE, BUSY]);
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Closed 2 sessions"]);
    expect(performUndo()).toBe(true);
    expect(get(IDLE).inbox_dismissed_at ?? null).toBeNull();
    expect(get(BUSY).inbox_stashed_at ?? null).toBeNull();
  });

  test("undo of a close the server set aside clears the stash too, so the session is back in the list", async () => {
    await animatedCloseSessions([IDLE]);
    // The server's own read set it aside: its echo stashes the row, with the
    // close's own stamp, instead (dispatch.ts).
    const t = get(IDLE).inbox_dismissed_at;
    const asideRow = (r: any) => ({ ...r, inbox_dismissed_at: null, inbox_closed_at: t, inbox_stashed_at: t });
    useInboxStore.setState((s: any) => ({
      sessions: { ...s.sessions, [IDLE]: asideRow(s.sessions[IDLE]) },
      conversations: { ...s.conversations, [IDLE]: asideRow(s.conversations[IDLE]) },
    }));
    sent = [];
    expect(performUndo()).toBe(true);
    expect(get(IDLE).inbox_stashed_at ?? null).toBeNull();
    expect(get(IDLE).inbox_dismissed_at ?? null).toBeNull();
    // The undo's send leaves through the outbox.
    await new Promise((r) => setTimeout(r, 50));
    const cleared = sent.some((s) => Object.values<any>(s.patches?.conversations ?? {}).some((f) => "inbox_stashed_at" in f && f.inbox_stashed_at == null));
    expect(cleared).toBe(true);
  });

  test("a single close keeps the session's name in its label", async () => {
    await animatedCloseSessions([SEAT]);
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Closed “Row c”"]);
    expect(sent.some((s) => s.action === "closeSession")).toBe(true);
  });
});
