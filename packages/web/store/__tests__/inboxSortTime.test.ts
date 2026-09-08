import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { INBOX_CREATE_GRACE_MS } from "@codecast/shared/contracts";
import {
  placeInboxRows,
  sortSessions,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlaceInboxState,
} from "../inboxStore";

// Order INSIDE a section (ct-49550). The bucket says which group a row is in;
// the shared per-class sort time says where it sits, so a section is ordered by
// when something happened to each row instead of by conversation id. These
// assertions are over the CHOKEPOINT (placeInboxRows) — the same call the
// sidebar and mobile render from.
//
// Each section keeps its own DIRECTION and only changes which stamp it reads:
// Needs Input and Done are queues the reader clears top-down (oldest first),
// Working and the flat active order put the freshest on top, Dormant orders by
// the wake it parks on.

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

// A live daemon and fresh activity as of `t`: without them every reported
// status decays and each row below would settle into needs_input before its own
// class could be asserted.
const liveAt = (t: number) => ({ is_connected: true, daemon_alive_until: t + HOUR, last_heartbeat: t - 5_000, updated_at: t - MIN });

function rowAt(t: number, key: string, extra: Partial<InboxSession>): InboxSession {
  return {
    _id: id(key), session_id: `s-${key}`, agent_type: "claude_code", user_id: ME, status: "active",
    title: `Session ${key}`, message_count: 6, is_idle: false, has_pending: false,
    ...liveAt(t),
    ...extra,
  } as InboxSession;
}
const row = (key: string, extra: Partial<InboxSession>) => rowAt(NOW, key, extra);
function state(rows: InboxSession[]): PlaceInboxState {
  const sessions: Record<string, InboxSession> = {};
  for (const r of rows) sessions[r._id] = r;
  return {
    sessions,
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
const place = (rows: InboxSession[]) => placeInboxRows(state(rows), { scope: "mine", now: NOW });
const titles = (rows: InboxSession[]) => rows.map((r) => r.title);

describe("in-bucket order — one stamp per class", () => {
  // The id tiebreak alone put "a…" above "z…" whatever had just happened to
  // either row: the ids here are deliberately in the WRONG order for every
  // expectation below, so a passing assertion can only come from the stamps.
  // The queue reads the state START, not the row's updated_at: a message that
  // synced long after the row settled used to reorder the whole queue.
  it("needs input is a queue by when the state started, oldest first", () => {
    const p = place([
      row("a", { is_idle: true, agent_status: "idle", agent_status_updated_at: NOW - MIN, updated_at: NOW - 3 * HOUR, title: "Session fresh" }),
      row("z", { is_idle: true, agent_status: "idle", agent_status_updated_at: NOW - 2 * HOUR, updated_at: NOW - MIN, title: "Session stale" }),
    ]);
    expect(titles(p.needsInput)).toEqual(["Session stale", "Session fresh"]);
  });

  it("done is a queue by when the turn ended, not by when the status last moved", () => {
    const p = place([
      row("a", { is_idle: true, agent_status: "done", agent_status_updated_at: NOW - 4 * HOUR, turn_completed_at: NOW - 5 * MIN, title: "Session fresh delivery" }),
      row("z", { is_idle: true, agent_status: "done", agent_status_updated_at: NOW - MIN, turn_completed_at: NOW - 3 * HOUR, title: "Session old delivery" }),
    ]);
    expect(titles(p.done)).toEqual(["Session old delivery", "Session fresh delivery"]);
  });

  // The point of the working rule: both rows are producing right now, so the
  // only thing that separates them is when each last came back to the user.
  it("working orders by the most recent prior attention event", () => {
    const p = place([
      row("a", { agent_status: "working", agent_status_updated_at: NOW - 90 * MIN, turn_completed_at: NOW - 90 * MIN, title: "Session grinding" }),
      row("z", { agent_status: "working", agent_status_updated_at: NOW - MIN, turn_completed_at: NOW - 2 * MIN, title: "Session just back" }),
    ]);
    expect(titles(p.working)).toEqual(["Session just back", "Session grinding"]);
  });

  it("dormant orders by the named wake, soonest first, and an unnamed wake files last", () => {
    const parked = (key: string, title: string, wakeupAt?: number) =>
      row(key, {
        is_idle: true, agent_status: "dormant", agent_status_updated_at: NOW - 5 * MIN, updated_at: NOW - 5 * MIN, title,
        ...(wakeupAt ? { loop_state: { status: "armed", wakeup_at: wakeupAt, event_at: NOW - 5 * MIN } } : {}),
      } as Partial<InboxSession>);
    const p = place([
      parked("a", "Session unnamed"),
      parked("b", "Session later", NOW + 3 * HOUR),
      parked("z", "Session soon", NOW + 10 * MIN),
    ]);
    expect(titles(p.dormant)).toEqual(["Session soon", "Session later", "Session unnamed"]);
  });

  // A session the user just started has none of those events yet, so ambient
  // output on older rows used to push it out of sight.
  it("a session created inside the grace holds the top of its section", () => {
    const pair = (t: number) => [
      rowAt(t, "a", { agent_status: "working", agent_status_updated_at: NOW - MIN, turn_completed_at: NOW - MIN, title: "Session busy" }),
      rowAt(t, "z", { agent_status: "working", agent_status_updated_at: NOW - 2 * MIN, started_at: NOW - 2 * MIN, title: "Session brand new" }),
    ];
    expect(titles(place(pair(NOW)).working)).toEqual(["Session brand new", "Session busy"]);
    // Past the window the floor lifts and the row's own stamps speak again.
    const after = NOW - 2 * MIN + INBOX_CREATE_GRACE_MS + MIN;
    nowSpy.mockReturnValue(after);
    __resetInboxPlacementCacheForTests();
    expect(titles(placeInboxRows(state(pair(after)), { scope: "mine", now: after }).working)).toEqual(["Session busy", "Session brand new"]);
  });

  // sortSessions is the second reader of the comparator (the flat lists), so
  // it must order a class the same way the sections do.
  it("sortSessions reads the same key", () => {
    const rows = [
      row("a", { is_idle: true, agent_status: "idle", agent_status_updated_at: NOW - 2 * HOUR, title: "Session stale" }),
      row("z", { is_idle: true, agent_status: "idle", agent_status_updated_at: NOW - MIN, title: "Session fresh" }),
    ];
    const sessions: Record<string, InboxSession> = {};
    for (const r of rows) sessions[r._id] = r;
    expect(titles(sortSessions(sessions))).toEqual(["Session fresh", "Session stale"]);
  });

  // The classes stay separated: a fresh stamp inside one section can never
  // lift a row above a section that outranks it.
  it("the class tuple still wins over the stamp", () => {
    const p = place([
      row("a", { is_idle: true, agent_status: "done", turn_completed_at: NOW - MIN, title: "Session done fresh" }),
      row("z", { is_idle: true, agent_status: "idle", agent_status_updated_at: NOW - 5 * HOUR, title: "Session blocked stale" }),
    ]);
    expect(titles(p.sorted)).toEqual(["Session blocked stale", "Session done fresh"]);
  });
});
