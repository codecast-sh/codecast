import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  placeInboxRows,
  useInboxStore,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlaceInboxState,
} from "../inboxStore";

// A close of a lead leaves its `cast spawn` child running (it has its own
// process). Such a child is a nested row that only ever shows beneath its
// lead, so the close adopts it: it must stand in the inbox as its own card
// while the lead is closed, never running unseen.

const NOW = 1_800_000_000_000 + 25_000;
const ME = "u".repeat(32);
const LEAD = "l".repeat(32);
const SUB = "a".repeat(32);
const SPAWNED = "c".repeat(32);

// The store is one singleton per process: put back what this file found, so a
// plain multi-file run hands the next file the store it would have had.
const STORE_KEYS = ["sessions", "conversations", "pending", "currentSessionId", "clientState", "currentUser"] as const;
let saved: Record<string, unknown> = {};
let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  const st = useInboxStore.getState() as any;
  saved = Object.fromEntries(STORE_KEYS.map((k) => [k, st[k]]));
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  __resetInboxPlacementCacheForTests();
});
afterEach(() => {
  nowSpy.mockRestore();
  useInboxStore.setState(saved as any);
  __resetInboxPlacementCacheForTests();
});

function row(id: string, extra: Partial<InboxSession> = {}): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", user_id: ME, status: "active",
    message_count: 6, is_idle: true, has_pending: false, title: `t-${id.slice(0, 1)}`, updated_at: NOW - 60_000,
    started_at: NOW - 3_600_000, ...extra,
  } as InboxSession;
}
const lead = (extra: Partial<InboxSession> = {}) => row(LEAD, { title: "Tycho v1 build", ...extra });
const spawned = (extra: Partial<InboxSession> = {}) =>
  row(SPAWNED, { session_id: "ca19ce3d-0000-4000-8000-000000000001", is_subagent: true, parent_conversation_id: LEAD, title: "Hey Tycho wake word model", is_idle: false, agent_status: "working", updated_at: NOW - 1000, ...extra } as Partial<InboxSession>);
const sub = () => row(SUB, { session_id: "agent-a009f4fcdcbf7ef81", is_subagent: true, parent_conversation_id: LEAD } as Partial<InboxSession>);

function state(sessions: Record<string, InboxSession>): PlaceInboxState {
  return {
    sessions,
    killedShelf: { ids: [] },
    sessionsWithQueuedMessages: new Set(),
    pendingMessages: {},
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: true } },
    currentUser: { _id: ME },
    sessionDecisions: {},
    questionResolutions: {},
    pendingSessionCreates: {},
    blockedReviveRequestedAt: {},
    currentSessionId: null,
    sessionsProjection: {},
    teamInboxIds: new Set(),
    pending: {},
  } as unknown as PlaceInboxState;
}

const SECTIONS = ["questions", "pinned", "newSessions", "needsInput", "done", "dormant", "working"] as const;
const flatIds = (placed: ReturnType<typeof placeInboxRows>) => SECTIONS.flatMap((k) => placed[k].map((s) => s._id));
const byId = (rows: InboxSession[]) => Object.fromEntries(rows.map((r) => [r._id, r]));
const closed = { inbox_dismissed_at: NOW - 5000, inbox_closed_at: NOW - 5000 };

describe("a spawned child of a closed lead", () => {
  it("unadopted, it would be on no list while it runs (why the close adopts it)", () => {
    const placed = placeInboxRows(state(byId([lead(closed), spawned()])), { scope: "mine", now: NOW });
    expect(flatIds(placed)).not.toContain(SPAWNED);
  });

  it("adopted by the close, it files as its own card in its own section", () => {
    const placed = placeInboxRows(state(byId([lead(closed), spawned({ inbox_adopted_at: NOW - 5000 })])), { scope: "mine", now: NOW });
    expect(placed.working.map((s) => s._id)).toContain(SPAWNED);
    expect(flatIds(placed)).not.toContain(LEAD);
  });

  it("once the lead is back, it nests under the lead again when they share a section", () => {
    const placed = placeInboxRows(state(byId([lead({ is_idle: false, agent_status: "working", updated_at: NOW - 1000 }), spawned({ inbox_adopted_at: NOW - 5000 })])), { scope: "mine", now: NOW });
    expect(placed.subsByParent.get(LEAD)?.map((s) => s._id)).toContain(SPAWNED);
    expect(flatIds(placed)).not.toContain(SPAWNED);
  });
});

describe("the store's Close, end to end into placement", () => {
  it("closing the lead hides it and its Task subagent; the spawned child stands as its own card", () => {
    const rows = [lead(), sub(), spawned()];
    useInboxStore.setState({
      sessions: byId(rows),
      conversations: Object.fromEntries(rows.map((r) => [r._id, { ...r }])),
      pending: {},
      currentSessionId: null,
      clientState: {},
      currentUser: { _id: ME },
    } as any);
    useInboxStore.getState().closeSession(LEAD);
    const sessions = useInboxStore.getState().sessions as Record<string, InboxSession>;
    expect(sessions[SUB].inbox_dismissed_at).toBeGreaterThan(0);
    const placed = placeInboxRows(state(sessions), { scope: "mine", now: NOW });
    const ids = flatIds(placed);
    expect(ids).toContain(SPAWNED);
    expect(ids).not.toContain(LEAD);
    expect(ids).not.toContain(SUB);
    expect([...placed.subsByParent.values()].flat().map((s) => s._id)).not.toContain(SUB);

    // Restoring the lead takes back the adoption its close stamped: the child nests under it again.
    useInboxStore.getState().restoreSession(LEAD);
    const after = useInboxStore.getState().sessions as Record<string, InboxSession>;
    expect(after[SPAWNED].inbox_adopted_at ?? null).toBeNull();
    __resetInboxPlacementCacheForTests();
    const back = placeInboxRows(state(after), { scope: "mine", now: NOW });
    expect(back.subsByParent.get(LEAD)?.map((s) => s._id)).toContain(SPAWNED);
    expect(flatIds(back)).not.toContain(SPAWNED);
    expect(flatIds(back)).toContain(LEAD);
  });

  it("close, then kill from the closed view, then restore: the child nests under the lead again", () => {
    const rows = [lead(), spawned()];
    useInboxStore.setState({
      sessions: byId(rows),
      conversations: Object.fromEntries(rows.map((r) => [r._id, { ...r }])),
      pending: {},
      currentSessionId: null,
      clientState: {},
      currentUser: { _id: ME },
    } as any);
    useInboxStore.getState().closeSession(LEAD);
    expect((useInboxStore.getState().sessions as any)[SPAWNED].inbox_adopted_at).toBeGreaterThan(0);
    useInboxStore.getState().killSession(LEAD);
    expect((useInboxStore.getState().sessions as any)[SPAWNED].inbox_adopted_at ?? null).toBeNull();
    useInboxStore.getState().restoreSession(LEAD);
    const after = useInboxStore.getState().sessions as Record<string, InboxSession>;
    expect(after[SPAWNED].inbox_adopted_at ?? null).toBeNull();
    __resetInboxPlacementCacheForTests();
    const back = placeInboxRows(state(after), { scope: "mine", now: NOW });
    expect(back.subsByParent.get(LEAD)?.map((s) => s._id)).toContain(SPAWNED);
  });
});
