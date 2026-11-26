import { describe, expect, it, setSystemTime } from "bun:test";
import { SUBAGENT_PRODUCING_GRACE_MS } from "@codecast/shared/contracts";
import { __resetInboxPlacementCacheForTests, computeVisualOrder, drawnUnderParentIds, flatHeaderCount, flatViewSessions, subagentKeepOf, type InboxSession, type SubagentFilter } from "../inboxStore";
import { coarseNowOf, INBOX_CLOCK_MS, subscribeCoarseTick, tickCoarseClocks } from "../../hooks/useCoarseNow";
import { placeSections } from "./placeTestHarness";

// Under the owners model a subagent belongs to the session that started it, so
// it is in nobody's inbox; the server still sends it under that session, and
// the placement nests it under the session's card for display only.

const ME = "users_me";
const T0 = Date.now();
const PARENT = "p1234567890123456789012345678901";
const CHILD = "c1234567890123456789012345678901";
const ORPHAN = "o1234567890123456789012345678901";
const WORKER = "w1234567890123456789012345678901";
const OTHER = "q1234567890123456789012345678901";

const row = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `sess-${id}`,
  user_id: ME,
  agent_type: "claude_code",
  agent_status: "idle",
  is_idle: true,
  has_pending: false,
  message_count: 3,
  updated_at: T0 - 60_000,
  agent_status_updated_at: T0 - 60_000,
  last_role_is_user: false,
  title: id,
  ...(over as any),
});
const owned = (id: string, owner: string, over: Partial<InboxSession> = {}) =>
  row(id, { owners_model: true, owned_by_me: false, owner_session_id: owner, parent_conversation_id: owner, is_subagent: true, ...(over as any) });
const place = (rows: InboxSession[], opts: Parameters<typeof placeSections>[3] = {}) =>
  placeSections(Object.fromEntries(rows.map((s) => [s._id, s])), new Set(), undefined, { currentUser: { _id: ME }, ...opts });
// A child whose turn ended, as the real ones are: no live status of its own.
const finished = (id: string, owner: string) => owned(id, owner, { agent_status: undefined, status: "completed", updated_at: T0 - 5 * 60_000 } as any);
const busy = (id: string, owner: string) => owned(id, owner, { agent_status: "working", is_idle: false, updated_at: T0 - 2_000, agent_status_updated_at: T0 - 2_000, last_heartbeat: T0 - 2_000, daemon_alive_until: T0 + 85_000 } as any);
const lead = () => row(PARENT, { owners_model: true, owned_by_me: true });
const sectioned = (p: ReturnType<typeof place>) =>
  [...p.questions, ...p.needsInput, ...p.working, ...p.done, ...p.dormant, ...p.pinned, ...p.newSessions].map((s) => s._id);

describe("a subagent its session owns rides that session's card", () => {
  it("nests under the parent's card and takes no section of its own", () => {
    const p = place([row(PARENT, { owners_model: true, owned_by_me: true }), owned(CHILD, PARENT)]);
    expect((p.subsByParent.get(PARENT) ?? []).map((s) => s._id)).toEqual([CHILD]);
    expect(sectioned(p)).toContain(PARENT);
    expect(sectioned(p)).not.toContain(CHILD);
  });

  it("is not drawn when its parent is not in the viewer's inbox", () => {
    const p = place([row(PARENT, { owners_model: true, owned_by_me: false }), owned(CHILD, PARENT)]);
    expect([...p.subsByParent.values()].flat().map((s) => s._id)).not.toContain(CHILD);
    expect(sectioned(p)).toEqual([]);
  });

  it("a closed, killed, stashed or snoozed child is not drawn", () => {
    const p = place([
      row(PARENT, { owners_model: true, owned_by_me: true }),
      owned(CHILD, PARENT, { inbox_killed_at: T0 - 1000 } as any),
      owned(ORPHAN, PARENT, { inbox_dismissed_at: T0 - 1000, inbox_closed_at: T0 - 1000 } as any),
      owned(WORKER, PARENT, { inbox_stashed_at: T0 - 1000 } as any),
      owned(OTHER, PARENT, { inbox_snoozed_until: T0 + 3_600_000 } as any),
    ]);
    expect(p.subsByParent.get(PARENT) ?? []).toEqual([]);
  });

  it("only the newest 20 children by start, as the inbox read sends them", () => {
    const kids = Array.from({ length: 22 }, (_, i) => owned(`k${String(i).padStart(2, "0")}`.padEnd(32, "0"), PARENT, { started_at: T0 - 3_600_000 + i * 1000, updated_at: T0 - (i === 0 ? 1000 : 60_000) } as any));
    const p = place([lead(), ...kids]);
    const nested = (p.subsByParent.get(PARENT) ?? []).map((s) => s._id);
    expect(nested).toHaveLength(20);
    // The two started first are past the horizon, however recently one moved.
    expect(nested).not.toContain(kids[0]._id);
    expect(nested).not.toContain(kids[1]._id);
  });
});

describe("owned children stay on their session's card", () => {
  it("the team scope never gives one a card of its own", () => {
    const p = place([lead(), owned(CHILD, PARENT)], { scope: "team", teamInboxIds: new Set([PARENT, CHILD]) });
    expect(sectioned(p)).toContain(PARENT);
    expect(sectioned(p)).not.toContain(CHILD);
  });

  it("the team board keeps a spawned worker the session owns as a card of its own", () => {
    const worker = owned(WORKER, PARENT, { parent_conversation_id: undefined, is_subagent: false, spawned_by_conversation_id: PARENT } as any);
    const p = place([lead(), worker], { scope: "team", teamInboxIds: new Set([PARENT, WORKER]) });
    expect(sectioned(p)).toContain(WORKER);
  });

  it("the team board keeps an owned child whose session's card is not on it", () => {
    const p = place([owned(CHILD, PARENT)], { scope: "team", teamInboxIds: new Set([CHILD]) });
    expect(sectioned(p)).toContain(CHILD);
  });

  it("a spawned worker the session owns is not nested: it has no parent pointer", () => {
    const worker = owned(WORKER, PARENT, { parent_conversation_id: undefined, is_subagent: false, spawned_by_conversation_id: PARENT } as any);
    const p = place([lead(), worker]);
    expect([...p.subsByParent.values()].flat().map((s) => s._id)).not.toContain(WORKER);
  });

  it("the open one stays nested under the card and in no section or count", () => {
    const p = place([lead(), owned(CHILD, PARENT)], { currentSessionId: CHILD });
    expect((p.subsByParent.get(PARENT) ?? []).map((s) => s._id)).toEqual([CHILD]);
    expect(sectioned(p)).not.toContain(CHILD);
    expect([...p.nestedSectionOf.keys()]).not.toContain(CHILD);
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("the open one keeps a card of its own when its session's card is absent", () => {
    const p = place([row(PARENT, { owners_model: true, owned_by_me: false }), owned(CHILD, PARENT)], { currentSessionId: CHILD });
    expect(sectioned(p)).toContain(CHILD);
  });
});

describe("flat views list owned children under their card", () => {
  const flat = (p: ReturnType<typeof place>, opts: { full: boolean; filter?: SubagentFilter; focusedId?: string | null }) =>
    flatViewSessions(p.sorted, p.subsByParent, {
      mode: "recent",
      showSubagents: opts.full,
      focusedId: opts.focusedId ?? null,
      keepSub: opts.full ? subagentKeepOf(opts.filter ?? "all", T0, opts.focusedId, {}) : undefined,
    }).map((s) => s._id);

  it("A card each lists them directly under the card, as the filter keeps them", () => {
    const p = place([lead(), row(OTHER, { updated_at: T0 - 1000 }), busy(CHILD, PARENT), finished(ORPHAN, PARENT)]);
    const all = flat(p, { full: true });
    expect(all.slice(all.indexOf(PARENT), all.indexOf(PARENT) + 3).sort()).toEqual([PARENT, CHILD, ORPHAN].sort());
    expect(flat(p, { full: true, filter: "active" })).toEqual(expect.arrayContaining([PARENT, CHILD]));
    expect(flat(p, { full: true, filter: "active" })).not.toContain(ORPHAN);
    expect(flat(p, { full: true, filter: "active_done" })).toContain(ORPHAN);
  });

  // A row listed under its card reads as drawn there (the card's and the
  // phone row's nested state); one whose card is off the list stands alone.
  it("says which listed rows are drawn under their card", () => {
    const p = place([lead(), busy(CHILD, PARENT), finished(ORPHAN, PARENT)]);
    const list = flatViewSessions(p.sorted, p.subsByParent, { mode: "recent", showSubagents: true, keepSub: () => true });
    expect([...drawnUnderParentIds(list, p.subsByParent)].sort()).toEqual([CHILD, ORPHAN].sort());
    expect(drawnUnderParentIds(list.filter((s) => s._id !== PARENT), p.subsByParent).size).toBe(0);
  });

  // The All header counts as the grouped ones do: an owned child under its
  // card adds nothing; standing alone (its card off the list) it is a card.
  it("the All header leaves out the owned children drawn under their card", () => {
    const p = place([lead(), row(OTHER, { updated_at: T0 - 1000 }), busy(CHILD, PARENT), finished(ORPHAN, PARENT)]);
    const list = flatViewSessions(p.sorted, p.subsByParent, { mode: "recent", showSubagents: true, keepSub: () => true });
    expect(list).toHaveLength(4);
    expect(flatHeaderCount(list, drawnUnderParentIds(list, p.subsByParent))).toBe(2);
    const alone = list.filter((s) => s._id !== PARENT);
    expect(flatHeaderCount(alone, drawnUnderParentIds(alone, p.subsByParent))).toBe(3);
  });

  it("the other modes list only the open one, under its card", () => {
    const p = place([row(OTHER, { updated_at: T0 - 1000 }), lead(), finished(CHILD, PARENT)], { currentSessionId: CHILD });
    const ids = flat(p, { full: false, focusedId: CHILD });
    expect(ids.indexOf(CHILD)).toBe(ids.indexOf(PARENT) + 1);
    expect(ids.filter((id) => id === CHILD)).toHaveLength(1);
    expect(flat(place([lead(), finished(CHILD, PARENT)]), { full: false })).toEqual([PARENT]);
  });
});

describe("keyboard order in a flat view follows Which ones", () => {
  const order = (filter: SubagentFilter) => computeVisualOrder({
    sessions: Object.fromEntries([lead(), busy(CHILD, PARENT), finished(ORPHAN, PARENT)].map((s) => [s._id, s])),
    sessionsWithQueuedMessages: new Set<string>(),
    pendingMessages: {},
    currentSessionId: null,
    pendingSessionCreates: {},
    bucketAssignments: {},
    buckets: {},
    currentUser: { _id: ME },
    clientState: { ui: { inbox_view_mode: "recent", subagent_rows: "full", subagent_filter: filter, inbox_show_old: true } },
  }).map((s) => s._id);

  it("walks only the nested cards the filter keeps", () => {
    expect(order("active")).toEqual([PARENT, CHILD]);
    expect(order("all").sort()).toEqual([PARENT, CHILD, ORPHAN].sort());
  });
});

// The list is drawn on the inbox clock (useCoarseNow(INBOX_CLOCK_MS)), which
// lags the wall clock by up to a tick: a subagent quiet just under its
// producing grace there is Working, and kept, while the wall clock already
// calls it Done. The keyboard order reads the same clock.
describe("keyboard order in a flat view reads the clock the list is drawn on", () => {
  it("walks a quiet subagent the drawn list keeps, near the producing grace", () => {
    setSystemTime(new Date(T0));
    const stop = subscribeCoarseTick(INBOX_CLOCK_MS, () => {});
    try {
      tickCoarseClocks();
      const drawnAt = coarseNowOf(INBOX_CLOCK_MS);
      const quietAt = drawnAt - SUBAGENT_PRODUCING_GRACE_MS + 5_000;
      const quiet = owned(CHILD, PARENT, { agent_status: undefined, is_idle: undefined, status: "active", updated_at: quietAt, agent_status_updated_at: quietAt } as any);
      // Past the grace on the wall clock; the inbox clock has not ticked.
      setSystemTime(new Date(drawnAt + 10_000));
      expect(subagentKeepOf("active", drawnAt, null, {})(quiet)).toBe(true);
      __resetInboxPlacementCacheForTests();
      const ids = computeVisualOrder({
        sessions: Object.fromEntries([lead(), quiet].map((s) => [s._id, s])),
        sessionsWithQueuedMessages: new Set<string>(),
        pendingMessages: {},
        currentSessionId: null,
        pendingSessionCreates: {},
        bucketAssignments: {},
        buckets: {},
        currentUser: { _id: ME },
        clientState: { ui: { inbox_view_mode: "recent", subagent_rows: "full", subagent_filter: "active", inbox_show_old: true } },
      }).map((s) => s._id);
      expect(ids).toEqual([PARENT, CHILD]);
    } finally {
      stop();
      setSystemTime();
    }
  });
});

describe("keyboard order from an open owned child in a grouped view", () => {
  const order = (currentSessionId: string | null) => {
    __resetInboxPlacementCacheForTests();
    return computeVisualOrder({
      sessions: Object.fromEntries([lead(), row(OTHER, { updated_at: T0 - 120_000 }), finished(CHILD, PARENT)].map((s) => [s._id, s])),
      sessionsWithQueuedMessages: new Set<string>(),
      pendingMessages: {},
      currentSessionId,
      pendingSessionCreates: {},
      bucketAssignments: {},
      buckets: {},
      currentUser: { _id: ME },
      clientState: { ui: { inbox_view_mode: "grouped", subagent_rows: "folded", inbox_show_old: true } },
    }).map((s) => s._id);
  };

  it("walks on from right after its session's card", () => {
    const closed = order(null);
    expect(closed).not.toContain(CHILD);
    const open = order(CHILD);
    expect(open.indexOf(CHILD)).toBe(open.indexOf(PARENT) + 1);
    expect(open.filter((id) => id !== CHILD)).toEqual(closed);
  });
});
