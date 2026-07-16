import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { create as mutativeCreate } from "mutative";
import { groupPatchesByTable } from "../mutativeMiddleware";
import {
  computeManualSortKey,
  computeReorderUpdates,
  convBucketMap,
  groupSessionsForLabelView,
  groupSessionsByPlan,
  hydrateMergeValue,
  sortLabels,
  useInboxStore,
  visualOrderSessions,
  type BucketAssignmentItem,
  type BucketItem,
  type InboxSession,
} from "../inboxStore";

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

// Real Convex ids are 32 chars; these pass isConvexId so actions dispatch-path
// logic treats them as server-known rows.
const convexId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);

const bucket = (id: string, name: string, extra: Partial<BucketItem> = {}): BucketItem => ({
  _id: id,
  name,
  created_at: 1,
  updated_at: 1,
  ...extra,
});

describe("convBucketMap", () => {
  it("maps conversation ids to bucket ids, dropping null tombstones to undefined", () => {
    const assignments: Record<string, BucketAssignmentItem> = {
      a1: { _id: "a1", conversation_id: "c1", bucket_id: "b1", updated_at: 1 },
      a2: { _id: "a2", conversation_id: "c2", bucket_id: null, updated_at: 1 },
    };
    const map = convBucketMap(assignments);
    expect(map["c1"]).toBe("b1");
    expect(map["c2"]).toBeUndefined();
  });

  it("real server rows beat hydrated optimistic stubs for the same conversation", () => {
    // The bucketassign- stub is immortal on disk (no exclude is ever planted),
    // so boot hydration unions it back until live sync rekeys it. If the user
    // re-bucketed the conversation since, the frozen stub must not win —
    // regardless of object iteration order.
    const real = convexId("real1");
    const assignments: Record<string, BucketAssignmentItem> = {
      "bucketassign-c1": { _id: "bucketassign-c1", conversation_id: "c1", bucket_id: "old-bucket", updated_at: 5 },
      [real]: { _id: real, conversation_id: "c1", bucket_id: "new-bucket", updated_at: 2 },
    };
    expect(convBucketMap(assignments)["c1"]).toBe("new-bucket");
    // Reversed insertion order — same winner.
    const reversed: Record<string, BucketAssignmentItem> = {
      [real]: assignments[real],
      "bucketassign-c1": assignments["bucketassign-c1"],
    };
    expect(convBucketMap(reversed)["c1"]).toBe("new-bucket");
  });

  it("among rows of equal realness, the newer assignment wins", () => {
    const r1 = convexId("r1");
    const r2 = convexId("r2");
    const assignments: Record<string, BucketAssignmentItem> = {
      [r1]: { _id: r1, conversation_id: "c1", bucket_id: "older", updated_at: 1 },
      [r2]: { _id: r2, conversation_id: "c1", bucket_id: "newer", updated_at: 9 },
    };
    expect(convBucketMap(assignments)["c1"]).toBe("newer");
  });
});

describe("visualOrderSessions bucket filter", () => {
  it("scopes keyboard order to the active bucket while leaving project filter intact", () => {
    const sessions: Record<string, InboxSession> = {
      a: session("a", { is_idle: false }),
      b: session("b", { is_idle: false }),
    };
    const bucketByConv = { a: "bucket1" } as Record<string, string | undefined>;
    const all = visualOrderSessions(sessions, new Set(), null, undefined, {});
    expect(all.map((s) => s._id).sort()).toEqual(["a", "b"]);
    const scoped = visualOrderSessions(sessions, new Set(), null, undefined, {
      bucketFilter: "bucket1",
      bucketByConv,
    });
    expect(scoped.map((s) => s._id)).toEqual(["a"]);
  });
});

describe("assignSessionToBucket", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      buckets: {},
      bucketAssignments: {},
      pending: {},
      activeBucketFilter: null,
      activeProjectFilter: null,
    });
  });

  it("adds a stub assignment row for a first-time filing", () => {
    const convId = convexId("conv1");
    useInboxStore.getState().assignSessionToBucket(convId, "bucketA");
    const rows = Object.values(useInboxStore.getState().bucketAssignments);
    expect(rows.length).toBe(1);
    expect(rows[0]._id).toBe(`bucketassign-${convId}`);
    expect(rows[0].conversation_id).toBe(convId);
    expect(rows[0].bucket_id).toBe("bucketA");
  });

  it("rewrites the existing row on reassignment and tombstones on unassign", () => {
    const convId = convexId("conv2");
    useInboxStore.setState({
      bucketAssignments: {
        row1: { _id: "row1", conversation_id: convId, bucket_id: "bucketA", updated_at: 1 },
      },
    });
    useInboxStore.getState().assignSessionToBucket(convId, "bucketB");
    let rows = Object.values(useInboxStore.getState().bucketAssignments);
    expect(rows.length).toBe(1);
    expect(rows[0]._id).toBe("row1");
    expect(rows[0].bucket_id).toBe("bucketB");

    useInboxStore.getState().assignSessionToBucket(convId, null);
    rows = Object.values(useInboxStore.getState().bucketAssignments);
    expect(rows.length).toBe(1);
    expect(rows[0].bucket_id).toBeUndefined();
  });

  it("a stub-conversation assignment follows the rekey to the real id (fork label inheritance)", () => {
    const stubId = "forkstub123";
    const realId = convexId("forkreal");
    useInboxStore.getState().assignSessionToBucket(stubId, "bucketA");
    (useInboxStore.getState() as any)._rekeySession(stubId, realId);
    const map = convBucketMap(useInboxStore.getState().bucketAssignments);
    expect(map[stubId]).toBeUndefined();
    expect(map[realId]).toBe("bucketA");
  });

  it("discardForkStub removes the stub's assignment row", () => {
    const stubId = "forkstub456";
    useInboxStore.getState().assignSessionToBucket(stubId, "bucketA");
    useInboxStore.getState().discardForkStub(stubId);
    expect(Object.values(useInboxStore.getState().bucketAssignments).length).toBe(0);
  });
});

describe("bucket filter mutual exclusivity", () => {
  const resetFilters = () => {
    useInboxStore.setState({
      activeBucketFilter: null,
      activeProjectFilter: null,
      activeProjectPath: null,
      pending: {},
    });
  };
  beforeEach(resetFilters);
  // The store is module-global across test files — leaked filters break other
  // suites' navigation assertions.
  afterEach(resetFilters);

  it("setting a bucket filter clears the project filter and vice versa", () => {
    const store = useInboxStore.getState();
    store.setActiveProjectFilter("codecast", "/x/codecast");
    store.setActiveBucketFilter("b1");
    expect(useInboxStore.getState().activeBucketFilter).toBe("b1");
    expect(useInboxStore.getState().activeProjectFilter).toBeNull();

    useInboxStore.getState().setActiveProjectFilter("codecast", "/x/codecast");
    expect(useInboxStore.getState().activeProjectFilter).toBe("codecast");
    expect(useInboxStore.getState().activeBucketFilter).toBeNull();
  });
});

describe("cycleInboxViewMode", () => {
  beforeEach(() => {
    useInboxStore.setState({
      buckets: {},
      clientState: {},
      pending: {},
    });
  });

  it("cycles grouped → recent → time → grouped when no buckets exist", () => {
    const store = useInboxStore.getState();
    expect(store.inboxViewMode()).toBe("grouped");
    store.cycleInboxViewMode();
    expect(useInboxStore.getState().inboxViewMode()).toBe("recent");
    useInboxStore.getState().cycleInboxViewMode();
    expect(useInboxStore.getState().inboxViewMode()).toBe("time");
    useInboxStore.getState().cycleInboxViewMode();
    expect(useInboxStore.getState().inboxViewMode()).toBe("grouped");
  });

  it("includes the bucket mode when buckets exist and honors the legacy boolean", () => {
    useInboxStore.setState({
      buckets: { b1: bucket("b1", "perf") },
      clientState: { ui: { inbox_flat_view: true } },
    });
    // Legacy boolean true reads as "time" when the mode is unset.
    expect(useInboxStore.getState().inboxViewMode()).toBe("time");
    useInboxStore.getState().cycleInboxViewMode();
    expect(useInboxStore.getState().inboxViewMode()).toBe("bucket");
    // The coherence write keeps the boolean false outside "time".
    expect(useInboxStore.getState().clientState.ui?.inbox_flat_view).toBe(false);
    useInboxStore.getState().cycleInboxViewMode();
    expect(useInboxStore.getState().inboxViewMode()).toBe("grouped");
  });

  it("skips an all-archived bucket set", () => {
    useInboxStore.setState({
      buckets: { b1: bucket("b1", "perf", { archived_at: 5 }) },
      clientState: { ui: { inbox_view_mode: "time" } },
    });
    useInboxStore.getState().cycleInboxViewMode();
    expect(useInboxStore.getState().inboxViewMode()).toBe("grouped");
  });
});

describe("groupSessionsForLabelView", () => {
  const buckets: Record<string, BucketItem> = {
    bAlpha: bucket("bAlpha", "alpha"),
    bZeta: bucket("bZeta", "zeta"),
    bGone: bucket("bGone", "gone", { archived_at: 9 }),
  };

  it("orders label groups by name, projects by size with other last, items by recency", () => {
    const items = [
      session("l1", { updated_at: 10, git_root: "/x/web" }),
      session("l2", { updated_at: 20, git_root: "/x/web" }),
      session("p1", { git_root: "/x/web" }),
      session("p2", { git_root: "/x/web" }),
      session("p3", { git_root: "/x/api" }),
      session("u1", {}),
      session("z1", { git_root: "/x/api" }),
    ];
    const byConv = { l1: "bZeta", l2: "bZeta", z1: "bAlpha", u1: "bGone" } as Record<string, string | undefined>;
    const { labelGroups, projectGroups } = groupSessionsForLabelView(items, buckets, byConv);

    expect(labelGroups.map((g) => g.bucket.name)).toEqual(["alpha", "zeta"]);
    // Recency within a group: l2 (20) before l1 (10).
    expect(labelGroups[1].items.map((s) => s._id)).toEqual(["l2", "l1"]);
    // u1's bucket is archived → falls through to project tier; no git_root → "other" last.
    expect(projectGroups.map((g) => g.name)).toEqual(["web", "api", "other"]);
    expect(projectGroups[2].items.map((s) => s._id)).toEqual(["u1"]);
  });

  it("dedupes repeated sessions across input segments", () => {
    const dup = session("dup", { git_root: "/x/web" });
    const { projectGroups } = groupSessionsForLabelView([dup, dup], {}, {});
    expect(projectGroups[0].items.length).toBe(1);
  });
});

describe("groupSessionsByPlan", () => {
  const plan = (short_id: string, title: string) => ({ _id: short_id, short_id, title, status: "active" });

  it("groups every plan (even a plan of one), sorts by size then label, items by recency", () => {
    const items = [
      session("a1", { updated_at: 10, active_plan: plan("pl-1", "Alpha") }),
      session("a2", { updated_at: 20, active_plan: plan("pl-1", "Alpha") }),
      session("b1", { updated_at: 5, active_plan: plan("pl-2", "Beta") }),
      session("solo", { active_plan: plan("pl-3", "Gamma") }),
      session("np1", { git_root: "/x/web" }),
      session("np2", { git_root: "/x/api" }),
    ];
    const { planGroups, projectGroups } = groupSessionsByPlan(items);

    // pl-1 has 2 members → leads; the two singletons follow, tie broken by label.
    expect(planGroups.map((g) => g.key)).toEqual(["pl-1", "pl-2", "pl-3"]);
    // A plan of one still gets its own group — the opposite of the status view's
    // ≥2 flood guard.
    expect(planGroups[2].items.map((s) => s._id)).toEqual(["solo"]);
    // Heading reuses the orchestration label format.
    expect(planGroups[0].label).toBe("pl-1 · Alpha");
    // Recency within a group: a2 (20) before a1 (10).
    expect(planGroups[0].items.map((s) => s._id)).toEqual(["a2", "a1"]);
    // Planless sessions fall to project groups.
    expect(projectGroups.map((g) => g.name)).toEqual(["web", "api"]);
  });

  it("dedupes repeated sessions across input segments", () => {
    const dup = session("dup", { active_plan: plan("pl-9", "Dup") });
    const { planGroups } = groupSessionsByPlan([dup, dup]);
    expect(planGroups[0].items.length).toBe(1);
  });
});

describe("visualOrder follows the active view mode", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      buckets: {},
      bucketAssignments: {},
      pending: {},
      pendingMessages: {},
      pendingSessionCreates: {},
      sessionsWithQueuedMessages: new Set(),
      activeBucketFilter: null,
      activeProjectFilter: null,
      currentSessionId: null,
      liveInboxIds: new Set(),
      clientState: {},
    });
  });
  afterEach(() => {
    useInboxStore.setState({ sessions: {}, buckets: {}, bucketAssignments: {}, clientState: {} });
  });

  it("bucket mode walks pinned, then label groups, then project groups", () => {
    useInboxStore.setState({
      sessions: {
        pin: session("pin", { is_pinned: true, updated_at: 1, git_root: "/x/web" }),
        lab: session("lab", { updated_at: 2, git_root: "/x/web" }),
        web1: session("web1", { updated_at: 9, git_root: "/x/web" }),
        web2: session("web2", { updated_at: 3, git_root: "/x/web" }),
      },
      buckets: { b1: bucket("b1", "mylabel") },
      bucketAssignments: {
        r1: { _id: "r1", conversation_id: "lab", bucket_id: "b1", updated_at: 1 },
      },
      clientState: { ui: { inbox_view_mode: "bucket" } },
    });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["pin", "lab", "web1", "web2"]);
  });

  it("time mode sorts newest-created first regardless of status grouping", () => {
    useInboxStore.setState({
      sessions: {
        old: session("old", { started_at: 100, updated_at: 500, is_pinned: true }),
        mid: session("mid", { started_at: 200, updated_at: 100 }),
        fresh: session("fresh", { started_at: 300, updated_at: 50 }),
      },
      clientState: { ui: { inbox_view_mode: "time" } },
    });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["fresh", "mid", "old"]);
  });

  it("recent mode sorts newest-activity first (updated_at), inverting the creation order", () => {
    useInboxStore.setState({
      sessions: {
        old: session("old", { started_at: 100, updated_at: 500, is_pinned: true }),
        mid: session("mid", { started_at: 200, updated_at: 100 }),
        fresh: session("fresh", { started_at: 300, updated_at: 50 }),
      },
      clientState: { ui: { inbox_view_mode: "recent" } },
    });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["old", "mid", "fresh"]);
  });

  // Regression: Ctrl+J/K skipped New Session cards outside grouped view. The flat
  // (time/recent) panel renders EVERY non-hidden session — never-engaged blanks
  // included — but nav used to walk only the categorized status buckets, which
  // drop those blanks. A 0-message blank that is not the current session lands in
  // no status bucket, so it must appear in flat nav (matching the render) yet stay
  // out of grouped nav (matching the grouped render's deliberate hiding).
  it("flat (time/recent) mode walks never-engaged blank sessions so Ctrl+J/K can't skip New Session cards", () => {
    useInboxStore.setState({
      sessions: {
        blank: session("blank", { message_count: 0, started_at: 250, updated_at: 250 }),
        work: session("work", { message_count: 3, started_at: 100, updated_at: 100 }),
      },
      clientState: { ui: { inbox_view_mode: "time" } },
    });
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["blank", "work"]);
    useInboxStore.setState({ clientState: { ui: { inbox_view_mode: "recent" } } });
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["blank", "work"]);
  });

  it("grouped (by status) mode still hides the never-engaged blank — the behavior flat view diverges from", () => {
    useInboxStore.setState({
      sessions: {
        blank: session("blank", { message_count: 0, started_at: 250, updated_at: 250 }),
        work: session("work", { message_count: 3, started_at: 100, updated_at: 100 }),
      },
      clientState: { ui: { inbox_view_mode: "grouped" } },
    });
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["work"]);
  });

  // Regression: in grouped/bucket view, Ctrl+J/K landed on "old" sessions the
  // panel hides when "show old sessions" is off, so the highlight sat still while
  // the selection jumped onto an off-screen card. The panel renders these views
  // from partitionOldSessions(...).visibleSessions; nav must walk the SAME set.
  // (isOldSession only applies to real Convex ids, hence the 32-char fixtures.)
  const LIVE_ID = "live".padEnd(32, "0"); // 32-char Convex-format id, in the live set
  const OLD_ID = "olds".padEnd(32, "1");  // 32-char id, NOT in the live set → "old"
  for (const mode of ["grouped", "bucket"] as const) {
    it(`${mode} mode skips "old" (not-live) sessions when show_old is off, matching the render`, () => {
      const sessions = {
        [LIVE_ID]: session(LIVE_ID, { message_count: 3, updated_at: 200, git_root: "/x/web" }),
        [OLD_ID]: session(OLD_ID, { message_count: 3, updated_at: 100, git_root: "/x/web" }),
      };
      // show_old off (the every-boot default): the old card is hidden on
      // screen, so nav drops it too.
      useInboxStore.setState({
        sessions,
        liveInboxIds: new Set([LIVE_ID]),
        showOldSessions: false,
        clientState: { ui: { inbox_view_mode: mode } },
      });
      expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual([LIVE_ID]);
      // show_old on (ephemeral browse gesture): both render and nav include the
      // old session (membership is the contract here; the intra-status tiebreak
      // differs by mode).
      useInboxStore.setState({
        sessions,
        liveInboxIds: new Set([LIVE_ID]),
        showOldSessions: true,
        clientState: { ui: { inbox_view_mode: mode } },
      });
      expect(useInboxStore.getState().visualOrder().map((s) => s._id).sort()).toEqual([LIVE_ID, OLD_ID].sort());
    });
  }

  it("time mode: a manual pin overrides creation order; un-pinned rows stay by creation", () => {
    useInboxStore.setState({
      sessions: {
        old: session("old", { started_at: 100, updated_at: 1 }),
        mid: session("mid", { started_at: 200, updated_at: 1 }),
        fresh: session("fresh", { started_at: 300, updated_at: 1 }),
      },
      // Pin "old" above "fresh": key just over fresh's creation stamp.
      clientState: { ui: { inbox_view_mode: "time", inbox_manual_order: { old: 100_000 } } },
    });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["old", "fresh", "mid"]);
  });

  it("setSessionManualOrder pins a row and persists the key in the synced ui bag", () => {
    useInboxStore.setState({
      sessions: {
        a: session("a", { started_at: 100, updated_at: 1 }),
        b: session("b", { started_at: 200, updated_at: 1 }),
      },
      clientState: { ui: { inbox_view_mode: "time" } },
    });
    useInboxStore.getState().setSessionManualOrder("a", 999_999);
    expect(useInboxStore.getState().clientState.ui?.inbox_manual_order).toEqual({ a: 999_999 });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["a", "b"]); // a's pin now outranks b's later creation
  });
});

describe("computeManualSortKey", () => {
  // Keys are newest-first (descending), with the dragged row already removed.
  it("midpoints between neighbors when dropped in the middle", () => {
    expect(computeManualSortKey([300, 100], 1)).toBe(200);
  });
  it("steps a gap above the top row when dropped first", () => {
    expect(computeManualSortKey([300, 100], 0)).toBe(300 + 60_000);
  });
  it("steps a gap below the bottom row when dropped last", () => {
    expect(computeManualSortKey([300, 100], 2)).toBe(100 - 60_000);
  });
  it("handles an empty remainder (only row)", () => {
    expect(computeManualSortKey([], 0)).toBe(60_000);
  });
});

describe("computeReorderUpdates", () => {
  const ordered = [
    bucket("a", "a", { sort_order: 1024 }),
    bucket("b", "b", { sort_order: 2048 }),
    bucket("c", "c", { sort_order: 3072 }),
  ];

  it("moves with a single fractional write when orders exist", () => {
    // Move c between a and b.
    const updates = computeReorderUpdates(ordered, 2, 1);
    expect(updates).toEqual([{ id: "c", sort_order: 1536 }]);
  });

  it("moving to the front writes below the first order", () => {
    const updates = computeReorderUpdates(ordered, 2, 0);
    expect(updates).toEqual([{ id: "c", sort_order: 0 }]);
  });

  it("moving to the end writes above the last order", () => {
    const updates = computeReorderUpdates(ordered, 0, 2);
    expect(updates).toEqual([{ id: "a", sort_order: 4096 }]);
  });

  it("no-op when the move does not change the order", () => {
    expect(computeReorderUpdates(ordered, 1, 1)).toEqual([]);
  });

  it("renumbers everything on the first-ever reorder (no explicit orders)", () => {
    const fresh = [bucket("x", "x"), bucket("y", "y"), bucket("z", "z")];
    const updates = computeReorderUpdates(fresh, 2, 0);
    expect(updates).toEqual([
      { id: "z", sort_order: 1024 },
      { id: "x", sort_order: 2048 },
      { id: "y", sort_order: 3072 },
    ]);
  });

  it("renumbers when fractional precision collapses", () => {
    const tight = [
      bucket("a", "a", { sort_order: 1 }),
      bucket("b", "b", { sort_order: 1 + Number.EPSILON }),
      bucket("c", "c", { sort_order: 10 }),
    ];
    // Midpoint of two adjacent floats collapses onto a neighbor → full ladder.
    const updates = computeReorderUpdates(tight, 2, 1);
    expect(updates.length).toBe(3);
    expect(updates.map((u) => u.id)).toEqual(["a", "c", "b"]);
  });

  it("sortLabels orders by sort_order then name and drops archived", () => {
    const map = {
      n2: bucket("n2", "beta"),
      n1: bucket("n1", "alpha"),
      o1: bucket("o1", "omega", { sort_order: 10 }),
      gone: bucket("gone", "aaa", { archived_at: 1 }),
    };
    expect(sortLabels(map).map((b) => b.name)).toEqual(["alpha", "beta", "omega"]);
  });
});

// Boot hydration for buckets: cached labels must paint on first frame, not
// after the server round-trips (the label-bar pop-in this guards against —
// buckets were persisted to IDB but missing from the hand-maintained apply
// pick lists, so the cached rows were read off disk and dropped).
describe("bucket cache hydration merge", () => {
  it("cached buckets land wholesale on a cold store", () => {
    const cached = { b1: bucket("b1", "fullfunnel"), b2: bucket("b2", "simplify") };
    const merge = hydrateMergeValue("buckets", cached, {});
    expect(merge.apply).toBe(true);
    expect(merge.value).toEqual(cached);
  });

  it("live rows win per-id; cache backfills the rest (cache as floor)", () => {
    const cached = { b1: bucket("b1", "old-name"), b2: bucket("b2", "simplify") };
    const live = { b1: bucket("b1", "renamed-live") };
    const merge = hydrateMergeValue("buckets", cached, live);
    expect((merge.value as Record<string, BucketItem>).b1.name).toBe("renamed-live");
    expect((merge.value as Record<string, BucketItem>).b2.name).toBe("simplify");
  });

  it("assignments hydrate the same way", () => {
    const cached: Record<string, BucketAssignmentItem> = {
      a1: { _id: "a1", conversation_id: "c1", bucket_id: "b1", updated_at: 1 },
    };
    const merge = hydrateMergeValue("bucketAssignments", cached, undefined);
    expect(merge.apply).toBe(true);
    expect(merge.value).toEqual(cached);
  });

  it("fill-strategy singletons never clobber a live value", () => {
    expect(hydrateMergeValue("currentUser", { name: "cached" }, { name: "live" }).apply).toBe(false);
    expect(hydrateMergeValue("currentUser", { name: "cached" }, null)).toEqual({ apply: true, value: { name: "cached" } });
    expect(hydrateMergeValue("teamUnreadCount", 5, 2).apply).toBe(false);
  });

  it("arrays fill only an empty slot; scalars replace", () => {
    expect(hydrateMergeValue("teams", [{ id: "t1" }], []).apply).toBe(true);
    expect(hydrateMergeValue("teams", [{ id: "t1" }], [{ id: "live" }]).apply).toBe(false);
    expect(hydrateMergeValue("activeTabId", "tab_a", "tab_b")).toEqual({ apply: true, value: "tab_a" });
  });
});

describe("unarchive reaches the server (fullfunnel regression)", () => {
  // Unarchiving a label sets `archived_at = undefined` in the action draft.
  // Mutative encodes that as a replace-with-undefined patch (or a remove op
  // for `delete`), and sanitizeForConvex strips undefined keys from the
  // dispatch payload — so the clear silently never synced and the bucket
  // stayed archived server-side while every client showed it live. The
  // grouped patch must carry an explicit null, which the server's
  // applyPatches turns into a real field removal.
  const draftClear = (clear: (d: any) => void) => {
    const bucketId = convexId("bkt1");
    const state = {
      buckets: {
        [bucketId]: { _id: bucketId, name: "fullfunnel", archived_at: 123, created_at: 1, updated_at: 1 },
      },
    };
    const [, patches] = mutativeCreate(
      state,
      (d: any) => clear(d.buckets[bucketId]),
      { enablePatches: { pathAsArray: true } }
    );
    return { bucketId, grouped: groupPatchesByTable(patches as any) };
  };

  it("a field set to undefined groups as an explicit null tombstone", () => {
    const { bucketId, grouped } = draftClear((b) => { b.archived_at = undefined; });
    expect(grouped.inbox_buckets[bucketId].archived_at).toBeNull();
  });

  it("a field cleared via delete groups as an explicit null tombstone", () => {
    const { bucketId, grouped } = draftClear((b) => { delete b.archived_at; });
    expect(grouped.inbox_buckets[bucketId].archived_at).toBeNull();
  });
});
