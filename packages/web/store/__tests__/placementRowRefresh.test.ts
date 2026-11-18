import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  placeInboxRows,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlaceInboxState,
  type PlacedInbox,
} from "../inboxStore";

// A heartbeat changes only fields the placement key leaves out, so the cached
// placement is reused and only the row objects are swapped for the fresh ones.
// Every case compares the reused answer with a full recompute over the same
// rows: same sections, same order, the same (fresh) row objects.

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;
const ME = "u".repeat(32);
const id = (c: string) => c.repeat(32);

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  __resetInboxPlacementCacheForTests();
});
afterEach(() => nowSpy.mockRestore());

function row(key: string, extra: Partial<InboxSession>): InboxSession {
  return {
    _id: id(key), session_id: `s-${key}`, agent_type: "claude_code", user_id: ME, status: "active",
    title: `Session ${key}`, message_count: 6, is_idle: false, has_pending: false,
    is_connected: true, daemon_alive_until: NOW + HOUR, last_heartbeat: NOW - 5_000, updated_at: NOW - MIN,
    ...extra,
  } as InboxSession;
}
function state(rows: InboxSession[]): PlaceInboxState {
  const sessions: Record<string, InboxSession> = {};
  for (const r of rows) sessions[r._id] = r;
  return {
    sessions, sessionsWithQueuedMessages: new Set(), pendingMessages: {},
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: true } },
    currentUser: { _id: ME }, sessionDecisions: {}, questionResolutions: {}, pendingSessionCreates: {},
    blockedReviveRequestedAt: {}, currentSessionId: null, sessionsProjection: {}, teamInboxIds: new Set(), pending: {},
  } as unknown as PlaceInboxState;
}
// The next write: the same store with a new sessions object, as a sync applies it.
function next(st: PlaceInboxState, rows: InboxSession[]): PlaceInboxState {
  const sessions: Record<string, InboxSession> = {};
  for (const r of rows) sessions[r._id] = r;
  return { ...st, sessions };
}
const place = (st: PlaceInboxState) => placeInboxRows(st, { scope: "mine", now: NOW });
function fresh(st: PlaceInboxState): PlacedInbox {
  __resetInboxPlacementCacheForTests();
  return place(st);
}
const SECTIONS = ["sorted", "questions", "pinned", "newSessions", "needsInput", "done", "dormant", "working", "stashed", "snoozed", "dismissed"] as const;
function expectSameAsRecompute(reused: PlacedInbox, st: PlaceInboxState) {
  const full = fresh(st);
  for (const k of SECTIONS) {
    expect(reused[k].map((s) => s._id)).toEqual(full[k].map((s) => s._id));
    // Every row handed out is the current object, never a stale copy.
    for (const s of reused[k]) expect(s).toBe(st.sessions[s._id]);
  }
  for (const s of Object.values(reused.visibleSessions)) expect(s).toBe(st.sessions[s._id]);
  expect(Object.keys(reused.visibleSessions).sort()).toEqual(Object.keys(full.visibleSessions).sort());
  expect(reused.counts).toEqual(full.counts);
}

const base = () => [
  row("a", { agent_status: "working", agent_status_updated_at: NOW - 90 * MIN, turn_completed_at: NOW - 90 * MIN }),
  row("b", { agent_status: "working", agent_status_updated_at: NOW - 10 * MIN, turn_completed_at: NOW - 20 * MIN }),
  row("c", { is_idle: true, agent_status: "done", agent_status_updated_at: NOW - HOUR, turn_completed_at: NOW - HOUR }),
  row("d", { is_idle: true, agent_status: "idle", agent_status_updated_at: NOW - 2 * HOUR }),
];

describe("placement reuse across writes the key leaves out", () => {
  it("a heartbeat hands out the fresh row objects in the same order", () => {
    const rows = base();
    const st0 = state(rows);
    const first = place(st0);
    const beat = rows.map((r) => (r._id === id("a") ? { ...r, last_heartbeat: NOW - 1_000, daemon_alive_until: NOW + 2 * HOUR } : r));
    const st = next(st0, beat);
    const reused = place(st);
    expect(reused.working.map((s) => s._id)).toEqual(first.working.map((s) => s._id));
    expect(reused.working.find((s) => s._id === id("a"))).toBe(st.sessions[id("a")]);
    // Arrays without a changed row keep their identity, so readers of them do not wake.
    expect(reused.done).toBe(first.done);
    expectSameAsRecompute(reused, st);
  });

  it("a new sessions object holding the same rows returns the cached answer itself", () => {
    const st = state(base());
    const first = place(st);
    expect(place({ ...st, sessions: { ...st.sessions } })).toBe(first);
  });

  it("a turn ending reorders the section", () => {
    const rows = base();
    const st0 = state(rows);
    place(st0);
    const moved = rows.map((r) => (r._id === id("a") ? { ...r, turn_completed_at: NOW - MIN } : r));
    const st = next(st0, moved);
    const reused = place(st);
    expect(reused.working.map((s) => s._id)).toEqual([id("a"), id("b")]);
    expectSameAsRecompute(reused, st);
  });

  it("activity on a row ordered by activity reorders it", () => {
    const rows = [
      row("e", { agent_status: "working", updated_at: NOW - 30 * MIN }),
      row("f", { agent_status: "working", updated_at: NOW - 20 * MIN }),
    ];
    const st0 = state(rows);
    place(st0);
    const st = next(st0, rows.map((r) => (r._id === id("e") ? { ...r, updated_at: NOW - 1_000 } : r)));
    expectSameAsRecompute(place(st), st);
  });

  it("a removed row leaves every section", () => {
    const rows = base();
    const st0 = state(rows);
    place(st0);
    const st = next(st0, rows.filter((r) => r._id !== id("b")));
    const reused = place(st);
    expect(reused.sorted.some((s) => s._id === id("b"))).toBe(false);
    expectSameAsRecompute(reused, st);
  });
});
