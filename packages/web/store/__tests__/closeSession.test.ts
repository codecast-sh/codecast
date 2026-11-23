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

  test("a single close keeps the session's name in its label", async () => {
    await animatedCloseSessions([SEAT]);
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Closed “Row c”"]);
    expect(sent.some((s) => s.action === "closeSession")).toBe(true);
  });
});
