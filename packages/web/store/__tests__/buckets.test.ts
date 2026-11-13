import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { create as mutativeCreate } from "mutative";
import { groupPatchesByTable } from "../mutativeMiddleware";
import {
  chipMatchesSession,
  computeManualSortKey,
  computeReorderUpdates,
  convBucketMap,
  groupSessionsForLabelView,
  groupSessionsByPlan,
  hydrateMergeValue,
  sortLabels,
  useInboxStore,
  type BucketAssignmentItem,
  type BucketItem,
  type InboxSession,
} from "../inboxStore";
import { orderSections } from "./placeTestHarness";
import { bucket, convexId, session } from "./bucketFixtures";

describe("convBucketMap", () => {
  it("reuses the assignment snapshot and invalidates after a move", () => {
    const assignments = { a: { _id: "a", conversation_id: "c", bucket_id: "old", updated_at: 1 } };
    expect(convBucketMap(assignments)).toBe(convBucketMap(assignments));
    expect(convBucketMap({ a: { ...assignments.a, bucket_id: "new" } }).c).toBe("new");
    expect(convBucketMap(assignments).c).toBe("old");
  });
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

describe("orderSections bucket filter", () => {
  const idA = convexId("a"), idB = convexId("b");
  it("scopes keyboard order to the active bucket while leaving project filter intact", () => {
    const sessions: Record<string, InboxSession> = {
      [idA]: session(idA, { is_idle: false }),
      [idB]: session(idB, { is_idle: false }),
    };
    const bucketByConv = { [idA]: "bucket1" } as Record<string, string | undefined>;
    const all = orderSections(sessions, new Set(), null, undefined, {});
    expect(all.map((s) => s._id).sort()).toEqual([idA, idB].sort());
    const scoped = orderSections(sessions, new Set(), null, undefined, {
      bucketFilters: [{ id: "bucket1", exclude: false }],
      bucketByConv,
    });
    expect(scoped.map((s) => s._id)).toEqual([idA]);
  });

  it("negative terms and filterExclude invert the bucket and project scoping", () => {
    const sessions: Record<string, InboxSession> = {
      [idA]: session(idA, { is_idle: false, project_path: "/x/codecast" }),
      [idB]: session(idB, { is_idle: false, project_path: "/x/other" }),
    };
    const bucketByConv = { [idA]: "bucket1" } as Record<string, string | undefined>;
    const bucketExcluded = orderSections(sessions, new Set(), null, undefined, {
      bucketFilters: [{ id: "bucket1", exclude: true }],
      bucketByConv,
    });
    expect(bucketExcluded.map((s) => s._id)).toEqual([idB]);
    const projectExcluded = orderSections(sessions, new Set(), [{ id: "codecast", path: null, exclude: true }]);
    expect(projectExcluded.map((s) => s._id)).toEqual([idB]);
  });

  it("mid-create stubs walk with the list even under a bucket chip (shared predicate)", () => {
    const sessions: Record<string, InboxSession> = {
      stub: session("stub", { is_idle: false }),
      [idA]: session(idA, { is_idle: false }),
    };
    const scoped = orderSections(sessions, new Set(), null, undefined, {
      bucketFilters: [{ id: "bucket1", exclude: false }],
      bucketByConv: { [idA]: "bucket1" },
      stubIds: new Set(["stub"]),
    });
    expect(scoped.map((s) => s._id).sort()).toEqual([idA, "stub"].sort());
  });
});

describe("chipMatchesSession exclude mode", () => {
  const bucketByConv = { [convexId("in")]: "bucket1" } as Record<string, string | undefined>;

  it("hides matches and shows everything else", () => {
    const inBucket = session(convexId("in"));
    const outBucket = session(convexId("out"));
    expect(chipMatchesSession(inBucket, { bucketFilters: [{ id: "bucket1", exclude: true }], bucketByConv })).toBe(false);
    expect(chipMatchesSession(outBucket, { bucketFilters: [{ id: "bucket1", exclude: true }], bucketByConv })).toBe(true);
    const inProj = session(convexId("p1"), { project_path: "/x/codecast" });
    const outProj = session(convexId("p2"), { project_path: "/x/other" });
    const hideCodecast = [{ id: "codecast", path: null, exclude: true }];
    expect(chipMatchesSession(inProj, { projectFilters: hideCodecast, bucketByConv })).toBe(false);
    expect(chipMatchesSession(outProj, { projectFilters: hideCodecast, bucketByConv })).toBe(true);
  });

  it("mid-create stubs pass the bucket chips in both polarities", () => {
    const stub = session("stub-not-convex");
    expect(chipMatchesSession(stub, { bucketFilters: [{ id: "bucket1", exclude: false }], bucketByConv })).toBe(true);
    expect(chipMatchesSession(stub, { bucketFilters: [{ id: "bucket1", exclude: true }], bucketByConv })).toBe(true);
  });
});

describe("chipMatchesSession with a multi-term filter list", () => {
  const a = convexId("la"), b = convexId("lb"), c = convexId("lc");
  const bucketByConv = { [a]: "bucketA", [b]: "bucketB", [c]: "bucketC" } as Record<string, string | undefined>;

  it("include terms are a union over the session's single label", () => {
    const terms = [{ id: "bucketA", exclude: false }, { id: "bucketB", exclude: false }];
    expect(chipMatchesSession(session(a), { bucketFilters: terms, bucketByConv })).toBe(true);
    expect(chipMatchesSession(session(b), { bucketFilters: terms, bucketByConv })).toBe(true);
    expect(chipMatchesSession(session(c), { bucketFilters: terms, bucketByConv })).toBe(false);
    expect(chipMatchesSession(session(convexId("none")), { bucketFilters: terms, bucketByConv })).toBe(false);
  });

  it("an all-negative list hides exactly its labels", () => {
    const terms = [{ id: "bucketA", exclude: true }, { id: "bucketB", exclude: true }];
    expect(chipMatchesSession(session(a), { bucketFilters: terms, bucketByConv })).toBe(false);
    expect(chipMatchesSession(session(b), { bucketFilters: terms, bucketByConv })).toBe(false);
    expect(chipMatchesSession(session(c), { bucketFilters: terms, bucketByConv })).toBe(true);
    expect(chipMatchesSession(session(convexId("none")), { bucketFilters: terms, bucketByConv })).toBe(true);
  });

  it("with any include present, includes decide (a mixed list can't resurrect an excluded label)", () => {
    const terms = [{ id: "bucketA", exclude: false }, { id: "bucketB", exclude: true }];
    expect(chipMatchesSession(session(a), { bucketFilters: terms, bucketByConv })).toBe(true);
    expect(chipMatchesSession(session(b), { bucketFilters: terms, bucketByConv })).toBe(false);
    expect(chipMatchesSession(session(c), { bucketFilters: terms, bucketByConv })).toBe(false);
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
      chipFilterExclude: false,
      pending: {},
    });
  };
  beforeEach(resetFilters);
  // The store is module-global across test files — leaked filters break other
  // suites' navigation assertions.
  afterEach(resetFilters);

  // React Native defines `window` without `location`. A chip tap evicts focus
  // through mountedPathname, which read window.location.pathname and threw
  // "Cannot read property 'pathname' of undefined" (Sentry REACT-NATIVE-G,
  // fatal on every label/project chip tap in the 1.0.4 mobile build).
  it("a chip tap survives a window with no location (React Native)", () => {
    const hadWindow = typeof window !== "undefined";
    const saved = hadWindow ? (globalThis as any).window : undefined;
    (globalThis as any).window = {};
    try {
      expect(() => useInboxStore.getState().setActiveBucketFilter("b1")).not.toThrow();
      expect(useInboxStore.getState().activeBucketFilter).toBe("b1");
      expect(() => useInboxStore.getState().setActiveProjectFilter("codecast", "/x/codecast")).not.toThrow();
    } finally {
      if (hadWindow) (globalThis as any).window = saved;
      else delete (globalThis as any).window;
    }
  });

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

  it("chipFilterExclude tracks the setter's exclude flag and resets on filter changes", () => {
    const store = useInboxStore.getState();
    store.setActiveBucketFilter("b1");
    expect(useInboxStore.getState().chipFilterExclude).toBe(false);
    store.setActiveBucketFilter("b1", true);
    expect(useInboxStore.getState().chipFilterExclude).toBe(true);
    store.setActiveBucketFilter(null);
    expect(useInboxStore.getState().chipFilterExclude).toBe(false);
    expect(useInboxStore.getState().activeBucketFilter).toBeNull();

    // Switching from an excluded label to a project chip starts at include.
    store.setActiveBucketFilter("b1", true);
    store.setActiveProjectFilter("codecast", "/x/codecast");
    const st = useInboxStore.getState();
    expect(st.chipFilterExclude).toBe(false);
    expect(st.activeBucketFilter).toBeNull();
    expect(st.activeProjectFilter).toBe("codecast");

    store.setActiveProjectFilter("codecast", "/x/codecast", true);
    expect(useInboxStore.getState().chipFilterExclude).toBe(true);
    store.setActiveProjectFilter(null, null);
    expect(useInboxStore.getState().chipFilterExclude).toBe(false);
  });

  it("clearing the idle axis never flips the other axis's exclusion into an include", () => {
    const store = useInboxStore.getState();
    store.setActiveBucketFilter("b1", true);
    store.setActiveProjectFilter(null, null);
    let st = useInboxStore.getState();
    expect(st.activeBucketFilter).toBe("b1");
    expect(st.chipFilterExclude).toBe(true);

    store.setActiveBucketFilter(null);
    store.setActiveProjectFilter("codecast", "/x/codecast", true);
    store.setActiveBucketFilter(null);
    st = useInboxStore.getState();
    expect(st.activeProjectFilter).toBe("codecast");
    expect(st.chipFilterExclude).toBe(true);
  });
});

describe("cycleInboxViewMode", () => {
  beforeEach(() => {
    useInboxStore.setState({
      buckets: {},
      clientState: {},
      pending: {},
      inboxViewModesShown: ["grouped", "recent", "time"],
    });
  });
  const cycle = () => {
    useInboxStore.getState().cycleInboxViewMode();
    return useInboxStore.getState().inboxViewMode();
  };

  it("steps through the published tabs in order and wraps", () => {
    expect(useInboxStore.getState().inboxViewMode()).toBe("grouped");
    expect([cycle(), cycle(), cycle()]).toEqual(["recent", "time", "grouped"]);
  });

  it("walks only the tabs on screen, whatever else the store could group by", () => {
    // A goal exists on some session the panel does not list: no Goal tab, so
    // the cycle goes plan → project → reports without a stop in between.
    useInboxStore.setState({
      buckets: { b1: bucket("b1", "perf") },
      clientState: { ui: { inbox_view_mode: "plan" } },
      inboxViewModesShown: ["grouped", "recent", "time", "bucket", "plan", "project", "reports", "trigger"],
    });
    expect([cycle(), cycle(), cycle(), cycle()]).toEqual(["project", "reports", "trigger", "grouped"]);
  });

  it("honors the legacy boolean and keeps it coherent", () => {
    useInboxStore.setState({ clientState: { ui: { inbox_flat_view: true } } });
    // Legacy boolean true reads as "time" when the mode is unset.
    expect(useInboxStore.getState().inboxViewMode()).toBe("time");
    expect(cycle()).toBe("grouped");
    expect(useInboxStore.getState().clientState.ui?.inbox_flat_view).toBe(false);
  });

  it("does nothing while no panel shows the tabs", () => {
    useInboxStore.setState({ inboxViewModesShown: null });
    expect(cycle()).toBe("grouped");
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

  it("groups every plan (even a plan of one), the latest move first, items by recency", () => {
    const items = [
      session("a1", { updated_at: 10, active_plan: plan("pl-1", "Alpha") }),
      session("a2", { updated_at: 20, active_plan: plan("pl-1", "Alpha") }),
      session("b1", { updated_at: 5, active_plan: plan("pl-2", "Beta") }),
      session("solo", { updated_at: 1, active_plan: plan("pl-3", "Gamma") }),
      session("np1", { git_root: "/x/web" }),
      session("np2", { git_root: "/x/api" }),
    ];
    // Every plan in the same state, so the latest move orders them.
    const placements = new Map(items.map((x) => [x._id, { bucket: "working" as const, work_state: "working" as const }]));
    const { planGroups, projectGroups } = groupSessionsByPlan(items, { placements });

    // pl-1 moved last (20), then pl-2 (5), then pl-3 (1).
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

  it("orders plans by where they stand: waiting on a person first, the oldest wait leading", () => {
    const NOW = 100 * 24 * 3600_000;
    const items = [
      session("mov", { updated_at: NOW, active_plan: plan("pl-m", "Moving") }),
      session("park", { updated_at: NOW - 48 * 3600_000, active_plan: plan("pl-p", "Parked") }),
      session("askNew", { updated_at: NOW - 3600_000, active_plan: plan("pl-a", "Asks new") }),
      session("askOld", { updated_at: NOW - 54 * 24 * 3600_000, active_plan: plan("pl-o", "Asks old") }),
    ];
    const placements = new Map<string, { bucket: any; work_state: any }>([
      ["mov", { bucket: "working", work_state: "working" }],
      ["park", { bucket: "dormant", work_state: "dormant" }],
      ["askNew", { bucket: "needs_input", work_state: "needs_input" }],
      // An open `cast decide` files under questions: it waits on a person too.
      ["askOld", { bucket: "questions", work_state: "dormant" }],
    ]);
    const { planGroups } = groupSessionsByPlan(items, { placements, now: NOW });
    expect(planGroups.map((g) => [g.key, g.standing.state])).toEqual([
      ["pl-o", "needs_you"], ["pl-a", "needs_you"], ["pl-m", "moving"], ["pl-p", "parked"],
    ]);
  });

  it("opens each plan with its longest thread", () => {
    const items = [
      session("worker", { updated_at: 20, message_count: 30, active_plan: plan("pl-1", "Alpha") }),
      session("lead", { updated_at: 10, message_count: 5000, active_plan: plan("pl-1", "Alpha") }),
    ];
    expect(groupSessionsByPlan(items).planGroups[0].items.map((s) => s._id)).toEqual(["lead", "worker"]);
  });

  it("never leads with a worker another thread spawned, however long it ran", () => {
    const items = [
      session("worker", { updated_at: 20, message_count: 900, spawned_by_conversation_id: "lead", active_plan: plan("pl-1", "Alpha") }),
      session("lead", { updated_at: 10, message_count: 400, active_plan: plan("pl-1", "Alpha") }),
    ];
    expect(groupSessionsByPlan(items).planGroups[0].items.map((s) => s._id)).toEqual(["lead", "worker"]);
  });

  it("reads every cached session on a plan, and leads with a hidden or stashed driver", () => {
    const NOW = 100 * 24 * 3600_000;
    const p = plan("pl-619", "Eval suite");
    // The eval lead: a role's standing session the inbox hides, working now.
    const lead = session("lead", { updated_at: NOW, message_count: 9000, standing_role_id: "r1", role: { _id: "r1", name: "Eval Suite lead" } as any, active_plan: p });
    // A stashed thread whose turn ended on a question nobody was asked.
    const stashed = session("stashed", { updated_at: NOW, inbox_stashed_at: NOW, active_plan: plan("pl-1008", "Ads") });
    const placements = new Map<string, { bucket: any; work_state: any }>([
      ["lead", { bucket: "hidden", work_state: "working" }],
      ["stashed", { bucket: "stashed", work_state: "needs_input" }],
    ]);
    const { planGroups } = groupSessionsByPlan([], { placements, sessions: { lead, stashed }, now: NOW });
    expect(planGroups.map((g) => [g.key, g.standing.state, g.items[0]._id, g.role?.name ?? null])).toEqual([
      ["pl-1008", "moving", "stashed", null],
      ["pl-619", "moving", "lead", "Eval Suite lead"],
    ]);
  });

  it("lists plans with open work and nobody on them", () => {
    const NOW = 100 * 24 * 3600_000;
    const row = (id: string, extra: object) => ({ _id: id, short_id: id, title: id, status: "draft", updated_at: NOW - 5 * 24 * 3600_000, ...extra }) as any;
    const plans = {
      grouped: row("grouped", { progress: { done: 1, total: 3 } }),
      stalled: row("stalled", { progress: { done: 1, total: 3 } }),
      finished: row("finished", { progress: { done: 3, total: 3 } }),
      empty: row("empty", { progress: { done: 0, total: 0 } }),
      today: row("today", { progress: { done: 1, total: 3 }, updated_at: NOW - 3600_000 }),
      closed: row("closed", { progress: { done: 1, total: 3 }, status: "abandoned" }),
    };
    const items = [session("s", { active_plan: { _id: "grouped", short_id: "grouped", title: "grouped", status: "draft" } })];
    const { restingPlans } = groupSessionsByPlan(items, { plans, now: NOW });
    expect(restingPlans.map((r) => [r.plan._id, r.state]).sort()).toEqual([["finished", "finished"], ["stalled", "stalled"]]);
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

  it("bucket mode walks label groups, then project groups, each pinned row leading its own group", () => {
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
    expect(order).toEqual(["lab", "pin", "web1", "web2"]);
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
  // the selection jumped onto an off-screen card. "Old" is the FOLD of the shared
  // working-set selection now (sync-convergence C4): a member past a 12h activity
  // gap hides behind the toggle; show-old reveals it INSIDE the computation. The
  // panel renders from computeInboxVisible(...).visibleSessions; nav must walk
  // the SAME set. (Membership only applies to real Convex ids — stubs are the
  // create_stub overlay — hence the 32-char fixtures.)
  const LIVE_ID = "live".padEnd(32, "0"); // fresh activity: above the fold
  const EDGE_ID = "edge".padEnd(32, "2"); // at the fold cut: stays visible
  const OLD_ID = "olds".padEnd(32, "1");  // past the cut → folded ("old")
  for (const mode of ["grouped", "bucket"] as const) {
    it(`${mode} mode skips "old" (folded) sessions when show_old is off, matching the render`, () => {
      const now = Date.now();
      const sessions = {
        [LIVE_ID]: session(LIVE_ID, { message_count: 3, updated_at: now, git_root: "/x/web" }),
        [EDGE_ID]: session(EDGE_ID, { message_count: 3, updated_at: now - 13 * 60 * 60 * 1000, git_root: "/x/web" }),
        [OLD_ID]: session(OLD_ID, { message_count: 3, updated_at: now - 14 * 60 * 60 * 1000, git_root: "/x/web" }),
      };
      // show_old off (the default): the folded card is hidden on screen, so nav
      // drops it too.
      useInboxStore.setState({
        sessions,
        clientState: { ui: { inbox_view_mode: mode, inbox_show_old: false } },
      });
      expect(useInboxStore.getState().visualOrder().map((s) => s._id).sort()).toEqual([LIVE_ID, EDGE_ID].sort());
      // show_old on (synced per-user view pref): both render and nav include
      // the folded session (membership is the contract here; the intra-status
      // tiebreak differs by mode).
      useInboxStore.setState({
        sessions,
        clientState: { ui: { inbox_view_mode: mode, inbox_show_old: true } },
      });
      expect(useInboxStore.getState().visualOrder().map((s) => s._id).sort()).toEqual([LIVE_ID, EDGE_ID, OLD_ID].sort());
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

  it("setSessionManualOrders pins a row and persists the key in the synced ui bag", () => {
    useInboxStore.setState({
      sessions: {
        a: session("a", { started_at: 100, updated_at: 1 }),
        b: session("b", { started_at: 200, updated_at: 1 }),
      },
      clientState: { ui: { inbox_view_mode: "time" } },
    });
    useInboxStore.getState().setSessionManualOrders({ a: 999_999 });
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
    expect(hydrateMergeValue("threadUnread", 5, 2).apply).toBe(false);
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
