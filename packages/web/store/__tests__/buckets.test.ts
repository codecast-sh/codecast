import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  computeReorderUpdates,
  convBucketMap,
  groupSessionsForLabelView,
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

  it("cycles grouped → time → grouped when no buckets exist", () => {
    const store = useInboxStore.getState();
    expect(store.inboxViewMode()).toBe("grouped");
    store.cycleInboxViewMode();
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
