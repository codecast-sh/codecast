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

const initialUser = (useInboxStore.getState() as any).currentUser;
function seed() {
  const rows = [row(IDLE), row(BUSY, { agent_status: "working", updated_at: NOW - 1000 }), row(SEAT, { standing_role_id: "r1" })];
  useInboxStore.setState({
    sessions: Object.fromEntries(rows.map((r) => [r._id, r])),
    conversations: Object.fromEntries(rows.map((r) => [r._id, { ...r }])),
    pending: {},
    currentSessionId: null,
    clientState: {},
    currentUser: initialUser,
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
      sessions: { ...s.sessions, [CHILD]: row(CHILD, { session_id: "agent-a0a0a06d6964", agent_status: "working", updated_at: NOW - 1000, parent_conversation_id: IDLE, is_subagent: true }) },
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
      const child = row(CHILD, { session_id: "agent-a0a0a06b6964", parent_conversation_id: IDLE, is_subagent: true, ...extra });
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
    const kid = (id: string, extra: Record<string, unknown>) => row(id, { session_id: `agent-a0a0a0${id}`, parent_conversation_id: IDLE, is_subagent: true, status: "completed", ...extra });
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

  test("a fleet-queued worker is in flight: closing it sets it aside; closing its lead leaves it up, as its own card", () => {
    const Q = "8".repeat(32);
    const q = row(Q, { parent_conversation_id: IDLE, is_subagent: true, message_count: 0, subagent_slot: "queued" });
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [Q]: q }, conversations: { ...s.conversations, [Q]: { ...q } } }));
    expect(useInboxStore.getState().closeSessions([IDLE])?.aside).toEqual([]);
    expect(get(IDLE).inbox_dismissed_at).toBeGreaterThan(0);
    expect(get(Q).inbox_dismissed_at ?? null).toBeNull();
    expect(get(Q).inbox_adopted_at).toBeGreaterThan(0);
    seed();
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [Q]: q }, conversations: { ...s.conversations, [Q]: { ...q } } }));
    expect(useInboxStore.getState().closeSessions([Q])?.aside).toEqual([Q]);
  });

  test("a close of a lead takes its agent- subagent and leaves its spawned child running, adopted, as the server does", () => {
    const SUB = "d".repeat(32);
    const SPAWNED = "e".repeat(32);
    const kids = {
      [SUB]: row(SUB, { session_id: "agent-a009f4fcdcbf7ef81", parent_conversation_id: IDLE, is_subagent: true }),
      // Mid-turn: it has its own process, so it does not hold the lead's close.
      [SPAWNED]: row(SPAWNED, { session_id: "ca19ce3d-spawned", parent_conversation_id: IDLE, is_subagent: true, agent_status: "working", updated_at: NOW - 1000 }),
    };
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...kids }, conversations: { ...s.conversations, ...kids } }));
    expect(useInboxStore.getState().closeSession(IDLE)?.aside).toEqual([]);
    expect(get(IDLE).inbox_closed_at).toBe(get(IDLE).inbox_dismissed_at);
    expect(get(SUB).inbox_closed_at).toBe(get(SUB).inbox_dismissed_at);
    expect(get(SUB).inbox_dismissed_at).toBeGreaterThan(0);
    expect(get(SPAWNED).inbox_dismissed_at ?? null).toBeNull();
    expect(get(SPAWNED).inbox_closed_at ?? null).toBeNull();
    expect(get(SPAWNED).inbox_adopted_at).toBeGreaterThan(0);
    const patches = sent.find((s) => s.action === "closeSession")!.patches.conversations;
    expect(Object.keys(patches).sort()).toEqual([IDLE, SUB, SPAWNED].sort());
    expect(patches[SPAWNED]).toEqual({ inbox_adopted_at: get(SPAWNED).inbox_adopted_at });
  });

  test("only a spawned child that still holds something is adopted; finished ones stay nested under the closed lead", () => {
    const LIVE = "e".repeat(32);
    const DONE = ["1", "2", "3"].map((c) => c.repeat(32));
    const kid = (id: string, extra: Record<string, unknown>) => row(id, { session_id: `ca19ce3d-${id[0]}`, parent_conversation_id: IDLE, is_subagent: true, ...extra });
    const kids = {
      [LIVE]: kid(LIVE, {}),
      ...Object.fromEntries(DONE.map((id) => [id, kid(id, { status: "completed", agent_status: "stopped", last_heartbeat: NOW - 3_600_000 })])),
    };
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...kids }, conversations: { ...s.conversations, ...kids } }));
    useInboxStore.getState().closeSession(IDLE);
    expect(get(LIVE).inbox_adopted_at).toBeGreaterThan(0);
    for (const id of DONE) expect([get(id).inbox_adopted_at ?? null, get(id).inbox_dismissed_at ?? null]).toEqual([null, null]);
    expect(Object.keys(sent.find((s) => s.action === "closeSession")!.patches.conversations).sort()).toEqual([IDLE, LIVE].sort());
  });

  test("a close of a lead takes its teammate down with it", () => {
    const MATE = "e".repeat(32);
    const mate = row(MATE, { spawned_by_conversation_id: IDLE, agent_team_name: "crew", agent_name: "reviewer" });
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [MATE]: mate }, conversations: { ...s.conversations, [MATE]: { ...mate } } }));
    useInboxStore.getState().closeSession(IDLE);
    expect(get(MATE).inbox_closed_at).toBe(get(MATE).inbox_dismissed_at);
    expect(get(MATE).inbox_dismissed_at).toBeGreaterThan(0);
  });

  test("adopts only within the window the server reads: a live child behind 200 newer ones is left nested", () => {
    const OLD = "e".repeat(32);
    const kids: Record<string, InboxSession> = {
      [OLD]: row(OLD, { session_id: "ca19ce3d-old", parent_conversation_id: IDLE, is_subagent: true, started_at: 1 }),
    };
    for (let i = 0; i < 200; i++) {
      const id = `k${String(i).padStart(31, "0")}`;
      kids[id] = row(id, { session_id: `agent-a0a0a0${i}`, parent_conversation_id: IDLE, is_subagent: true, started_at: 1000 + i, inbox_dismissed_at: 5, inbox_killed_at: 5 });
    }
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...kids }, conversations: { ...s.conversations, ...kids } }));
    useInboxStore.getState().closeSession(IDLE);
    expect(get(OLD).inbox_adopted_at ?? null).toBeNull();
  });

  test("a teammate's spawned child under the viewer's lead is not adopted, and not sent", () => {
    const FOREIGN = "e".repeat(32);
    const kid = row(FOREIGN, { session_id: "ca19ce3d-theirs", parent_conversation_id: IDLE, is_subagent: true, user_id: "someone-else" });
    useInboxStore.setState((s: any) => ({ currentUser: { _id: "me" }, sessions: { ...s.sessions, [FOREIGN]: kid }, conversations: { ...s.conversations, [FOREIGN]: { ...kid, is_own: false } } }));
    useInboxStore.getState().closeSession(IDLE);
    expect(get(FOREIGN).inbox_adopted_at ?? null).toBeNull();
    expect(Object.keys(sent.find((s) => s.action === "closeSession")!.patches.conversations)).toEqual([IDLE]);
  });

  test("a codex child goes down with its lead, as before", () => {
    const CODEX = "e".repeat(32);
    const kid = row(CODEX, { session_id: "019a0000-codex-thread", agent_type: "codex", parent_conversation_id: IDLE, is_subagent: true, headless_launch: true });
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [CODEX]: kid }, conversations: { ...s.conversations, [CODEX]: { ...kid } } }));
    useInboxStore.getState().closeSession(IDLE);
    expect(get(CODEX).inbox_closed_at).toBe(get(CODEX).inbox_dismissed_at);
    expect(get(CODEX).inbox_adopted_at ?? null).toBeNull();
  });

  test("a codex child /cli/spawn started (headless_launch false) stays up, adopted", () => {
    const CODEX = "e".repeat(32);
    const kid = row(CODEX, { session_id: "019a0000-codex-station", agent_type: "codex", parent_conversation_id: IDLE, is_subagent: true, headless_launch: false });
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [CODEX]: kid }, conversations: { ...s.conversations, [CODEX]: { ...kid } } }));
    useInboxStore.getState().closeSession(IDLE);
    expect(get(CODEX).inbox_dismissed_at ?? null).toBeNull();
    expect(get(CODEX).inbox_adopted_at).toBeGreaterThan(0);
  });

  test("a kill of a lead still takes its spawned child down, unadopted", () => {
    const SPAWNED = "e".repeat(32);
    const kid = row(SPAWNED, { session_id: "ca19ce3d-spawned", parent_conversation_id: IDLE, is_subagent: true });
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [SPAWNED]: kid }, conversations: { ...s.conversations, [SPAWNED]: { ...kid } } }));
    useInboxStore.getState().killSession(IDLE);
    expect(get(SPAWNED).inbox_dismissed_at).toBeGreaterThan(0);
    expect(get(SPAWNED).inbox_adopted_at ?? null).toBeNull();
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
