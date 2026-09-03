import { describe, expect, test, beforeEach } from "bun:test";
import { useInboxStore } from "../inboxStore";

// Client half of the sync-log migration (docs/architecture/sync-log-migration.md
// D5/D8): ack stamping onto pending entries, position-based retirement, and the
// scope-revocation purge. All store-local sync() functions — no server involved.

const CID = "a".repeat(32); // convex-id shaped

beforeEach(() => {
  useInboxStore.setState({
    pending: {},
    syncMeta: {},
    tasks: {},
    docs: {},
    plans: {},
    projects: {},
  } as any);
});

describe("stampSyncAck", () => {
  test("stamps entries for every store key backed by the patched table", () => {
    useInboxStore.setState({
      pending: {
        [`sessions:${CID}:inbox_dismissed_at`]: { type: "field", value: 5, ts: 100 },
        [`conversations:${CID}:inbox_dismissed_at`]: { type: "field", value: 5, ts: 100 },
      },
    } as any);
    useInboxStore.getState().stampSyncAck(
      { conversations: { [CID]: { inbox_dismissed_at: 5 } } },
      [{ scope_key: "user:u1", position: 7 }],
      200,
    );
    const pending = useInboxStore.getState().pending as any;
    expect(pending[`sessions:${CID}:inbox_dismissed_at`].ack).toEqual([{ s: "user:u1", p: 7 }]);
    expect(pending[`conversations:${CID}:inbox_dismissed_at`].ack).toEqual([{ s: "user:u1", p: 7 }]);
  });

  test("never stamps an entry newer than the dispatch send (a later local write owns it)", () => {
    useInboxStore.setState({
      pending: { [`conversations:${CID}:title`]: { type: "field", value: "newer", ts: 300 } },
    } as any);
    useInboxStore.getState().stampSyncAck(
      { conversations: { [CID]: { title: "older" } } },
      [{ scope_key: "user:u1", position: 7 }],
      200,
    );
    expect((useInboxStore.getState().pending as any)[`conversations:${CID}:title`].ack).toBeUndefined();
  });

  test("retires immediately when the scope cursor already passed the position", () => {
    useInboxStore.setState({
      pending: { [`conversations:${CID}:title`]: { type: "field", value: "x", ts: 100 } },
      syncMeta: { "synclog:v1:user:u1": { cursor: 10 } },
    } as any);
    useInboxStore.getState().stampSyncAck(
      { conversations: { [CID]: { title: "x" } } },
      [{ scope_key: "user:u1", position: 7 }],
      200,
    );
    expect((useInboxStore.getState().pending as any)[`conversations:${CID}:title`]).toBeUndefined();
  });

  test("ignores singleton buckets and unknown tables", () => {
    useInboxStore.setState({
      pending: { [`conversations:${CID}:title`]: { type: "field", value: "x", ts: 100 } },
    } as any);
    useInboxStore.getState().stampSyncAck(
      { client_state: { _: { theme: "dark" } }, nonsense: { [CID]: { a: 1 } } },
      [{ scope_key: "user:u1", position: 7 }],
      200,
    );
    expect((useInboxStore.getState().pending as any)[`conversations:${CID}:title`].ack).toBeUndefined();
  });
});

describe("retireAckedPending", () => {
  test("retires entries acked at or below the applied position, same scope only", () => {
    useInboxStore.setState({
      pending: {
        "conversations:a:title": { type: "field", value: 1, ts: 1, ack: [{ s: "user:u1", p: 5 }] },
        "conversations:b:title": { type: "field", value: 1, ts: 1, ack: [{ s: "user:u1", p: 9 }] },
        "tasks:c": { type: "exclude", ts: 1, ack: [{ s: "team:t1", p: 3 }] },
        "tasks:d:status": { type: "field", value: 1, ts: 1 },
      },
    } as any);
    useInboxStore.getState().retireAckedPending("user:u1", 7);
    const pending = useInboxStore.getState().pending as any;
    expect(pending["conversations:a:title"]).toBeUndefined(); // 5 <= 7
    expect(pending["conversations:b:title"]).toBeDefined(); // 9 > 7
    expect(pending["tasks:c"]).toBeDefined(); // other scope
    expect(pending["tasks:d:status"]).toBeDefined(); // no ack — value echo owns it
  });
});

describe("purgeTeamScopeRows", () => {
  test("purges only rows whose workspace is the revoked team, planting excludes", () => {
    useInboxStore.setState({
      tasks: {
        t1: { _id: "t1", workspace: "team:T", title: "gone" },
        t2: { _id: "t2", workspace: "user:u1", title: "kept" },
      },
      docs: { d1: { _id: "d1", workspace: "team:T" } },
    } as any);
    useInboxStore.getState().purgeTeamScopeRows("T");
    const s = useInboxStore.getState() as any;
    expect(s.tasks.t1).toBeUndefined();
    expect(s.tasks.t2).toBeDefined();
    expect(s.docs.d1).toBeUndefined();
    expect(s.pending["tasks:t1"]).toMatchObject({ type: "exclude" });
    expect(s.pending["docs:d1"]).toMatchObject({ type: "exclude" });
    expect(s.pending["tasks:t2"]).toBeUndefined();
  });
});

describe("clearSyncMeta", () => {
  test("drops the key outright (recordSyncMeta only advances)", () => {
    useInboxStore.setState({ syncMeta: { "synclog:v1:team:T": { cursor: 9 } } } as any);
    useInboxStore.getState().clearSyncMeta("synclog:v1:team:T");
    expect(useInboxStore.getState().syncMeta["synclog:v1:team:T"]).toBeUndefined();
  });
});

describe("catchUpScope (review C19)", () => {
  const { catchUpScope, scopeMetaKey } = require("../../hooks/useSyncChangeFeed");

  const scriptedConvex = (pages: any[]) => {
    const calls: any[] = [];
    return {
      calls,
      query: async (_fn: any, args: any) => {
        calls.push(args);
        return pages.shift();
      },
    };
  };
  const cursorOf = (scope: string) =>
    (useInboxStore.getState().syncMeta as any)[scopeMetaKey(scope)]?.cursor;

  test("cold scope stamps at the handed head without fetching", async () => {
    const convex = scriptedConvex([]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 41, floor: 0 }, new Set());
    expect(cursorOf("user:u1")).toBe(41);
    expect(convex.calls).toHaveLength(0);
  });

  test("newborn scope stamps cursor 0 (review C8) and later replays from it", async () => {
    const convex = scriptedConvex([]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 0, floor: 0 }, new Set());
    expect(cursorOf("user:u1")).toBe(0); // persisted, not rejected by forward-only
  });

  test("resync (floor above cursor) clears crawl watermarks and restamps at head", async () => {
    useInboxStore.setState({
      syncMeta: {
        [scopeMetaKey("team:T")]: { cursor: 5 },
        ['tasks:v2:{"team_id":"T","workspace":"team"}']: { cursor: 99, backfilledAt: 1 },
        ['docs:v2:{"workspace":"personal"}']: { cursor: 7, backfilledAt: 1 },
      },
    } as any);
    const convex = scriptedConvex([]);
    await catchUpScope(convex, { scope_key: "team:T", position: 50, floor: 10 }, new Set());
    const meta = useInboxStore.getState().syncMeta as any;
    expect(meta[scopeMetaKey("team:T")].cursor).toBe(50);
    expect(meta['tasks:v2:{"team_id":"T","workspace":"team"}']).toBeUndefined(); // cleared (C6)
    expect(meta['docs:v2:{"workspace":"personal"}']).toBeDefined(); // other scope untouched
  });

  test("empty page with advanced nextFrom moves the cursor (coalescing holes)", async () => {
    useInboxStore.setState({ syncMeta: { [scopeMetaKey("user:u1")]: { cursor: 3 } } } as any);
    const convex = scriptedConvex([
      { actions: [], nextFrom: 9, hasMore: false },
    ]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 9, floor: 0 }, new Set());
    expect(cursorOf("user:u1")).toBe(9);
  });

  test("authorization miss on a team scope purges and drops the cursor (review C3)", async () => {
    useInboxStore.setState({
      syncMeta: { [scopeMetaKey("team:T")]: { cursor: 3 } },
      tasks: { t1: { _id: "t1", workspace: "team:T" } },
    } as any);
    const convex = scriptedConvex([
      { actions: [], nextFrom: 3, hasMore: false, authorized: false },
    ]);
    const purged = new Set<string>();
    await catchUpScope(convex, { scope_key: "team:T", position: 9, floor: 0 }, purged);
    expect(cursorOf("team:T")).toBeUndefined();
    expect((useInboxStore.getState() as any).tasks.t1).toBeUndefined();
    expect(purged.has("T")).toBe(true);
  });
});

describe("applyCargoFields (sync-log-cargo E6)", () => {
  test("merges fields onto the row, pending field lock wins, echo retires the lock, unset drops keys", () => {
    useInboxStore.setState({
      tasks: { t1: { _id: "t1", title: "old", status: "open", closed_at: 1 } },
      pending: { "tasks:t1:status": { type: "field", value: "done", ts: 1 } },
    } as any);
    const ok = useInboxStore.getState().applyCargoFields("tasks", "t1", { title: "new", status: "open" }, ["closed_at"]);
    expect(ok).toBe(true);
    const row = (useInboxStore.getState() as any).tasks.t1;
    expect(row.title).toBe("new");
    expect(row.status).toBe("done"); // lock wins over the stale server value
    expect("closed_at" in row).toBe(false);
    expect((useInboxStore.getState() as any).pending["tasks:t1:status"]).toBeDefined();
    useInboxStore.getState().applyCargoFields("tasks", "t1", { status: "done" }, []);
    expect((useInboxStore.getState() as any).pending["tasks:t1:status"]).toBeUndefined(); // echo retired it
  });
  test("returns false when there is no base row (caller falls back to byIds)", () => {
    expect(useInboxStore.getState().applyCargoFields("docs", "nope", { title: "x" }, [])).toBe(false);
  });
  test("sessions: unset nulls; the conversations meta twin is left to its own feeders", () => {
    useInboxStore.setState({
      sessions: { c1: { _id: "c1", title: "a", subtitle: "s" } },
      conversations: { c1: { _id: "c1", title: "a", subtitle: "s" } },
      pending: {},
    } as any);
    useInboxStore.getState().applyCargoFields("sessions", "c1", { title: "b" }, ["subtitle"]);
    const s = useInboxStore.getState() as any;
    expect(s.sessions.c1.title).toBe("b");
    expect(s.sessions.c1.subtitle).toBeNull();
    expect(s.conversations.c1.title).toBe("a");
  });
  test("a lock on a field the patch OMITS survives (a local clear is a lock with value undefined)", () => {
    useInboxStore.setState({
      tasks: { t1: { _id: "t1", title: "old", status: "open" } },
      pending: { "tasks:t1:assignee": { type: "field", value: undefined, ts: 1 } },
    } as any);
    useInboxStore.getState().applyCargoFields("tasks", "t1", { title: "new" }, []);
    expect((useInboxStore.getState() as any).pending["tasks:t1:assignee"]).toBeDefined();
    useInboxStore.getState().applyCargoFields("tasks", "t1", {}, ["assignee"]);
    expect((useInboxStore.getState() as any).pending["tasks:t1:assignee"]).toBeUndefined();
  });
  test("sessions projection stamps are stripped from cargo like every other channel", () => {
    useInboxStore.setState({ sessions: { c1: { _id: "c1", title: "a" } }, pending: {} } as any);
    useInboxStore.getState().applyCargoFields("sessions", "c1", { title: "b", bucket: "needs_input" } as any, []);
    const row = (useInboxStore.getState() as any).sessions.c1;
    expect(row.title).toBe("b");
    expect(row.bucket).toBeUndefined();
  });
});

describe("applyLogPage with cargo (through catchUpScope)", () => {
  const { catchUpScope, scopeMetaKey } = require("../../hooks/useSyncChangeFeed");
  const scripted = (pages: any[]) => {
    const calls: any[] = [];
    return { calls, query: async (_fn: any, args: any) => { calls.push(args); return pages.shift(); } };
  };
  test("a patch with a base applies directly and issues NO byIds query", async () => {
    useInboxStore.setState({
      syncMeta: { [scopeMetaKey("user:u1")]: { cursor: 3 } },
      tasks: { t1: { _id: "t1", title: "old" } },
      syncLogApplyStats: { direct: 0, refetch: 0 },
    } as any);
    const convex = scripted([
      { actions: [{ position: 4, entity_type: "tasks", entity_id: "t1", op: "upsert", patch: { title: "new" } }], nextFrom: 4, hasMore: false },
    ]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 4, floor: 0 }, new Set());
    expect((useInboxStore.getState() as any).tasks.t1.title).toBe("new");
    expect(convex.calls).toHaveLength(1); // the range only — no byIds
    expect(useInboxStore.getState().syncLogApplyStats).toEqual({ direct: 1, refetch: 0 });
    expect((useInboxStore.getState().syncMeta as any)[scopeMetaKey("user:u1")].cursor).toBe(4);
  });
  test("no base, a delete, and partial cargo all route to byIds (authorized absence prunes)", async () => {
    useInboxStore.setState({
      syncMeta: { [scopeMetaKey("user:u1")]: { cursor: 0 } },
      tasks: { t2: { _id: "t2", title: "keep" } },
      pending: {},
      syncLogApplyStats: { direct: 0, refetch: 0 },
    } as any);
    const convex = scripted([
      { actions: [
        { position: 1, entity_type: "tasks", entity_id: "t9", op: "upsert", patch: { title: "unknown base" } },
        { position: 2, entity_type: "tasks", entity_id: "t2", op: "delete" },
        { position: 3, entity_type: "tasks", entity_id: "t3", op: "upsert", patch: { title: "p" }, full: true, partial: true },
      ], nextFrom: 3, hasMore: false },
      { items: [{ _id: "t3", title: "p", assignee_info: { name: "x" } }] }, // byIds: t9 gone, t2 gone, t3 enriched
    ]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 3, floor: 0 }, new Set());
    const s = useInboxStore.getState() as any;
    expect(convex.calls).toHaveLength(2);
    expect(convex.calls[0].cargo).toBe(true); // opt-in rides the range call
    expect(convex.calls[1].ids.sort()).toEqual(["t2", "t3", "t9"]);
    expect(s.tasks.t2).toBeUndefined(); // authorized absence pruned the delete
    expect(s.tasks.t3.assignee_info).toEqual({ name: "x" }); // full applied, then re-enriched
    expect(s.tasks.t9).toBeUndefined();
    expect(s.syncLogApplyStats).toEqual({ direct: 1, refetch: 3 });
  });
});

describe("applyLogPage: a delete for an id the replica does not hold needs no byIds probe", () => {
  const { catchUpScope, scopeMetaKey } = require("../../hooks/useSyncChangeFeed");
  test("skips the probe", async () => {
    useInboxStore.setState({
      syncMeta: { [scopeMetaKey("team:T")]: { cursor: 0 } },
      tasks: {},
      pending: {},
      syncLogApplyStats: { direct: 0, refetch: 0 },
    } as any);
    const calls: any[] = [];
    const convex = { query: async (_f: any, args: any) => { calls.push(args); return { actions: [
      { position: 1, entity_type: "tasks", entity_id: "private", op: "delete" },
    ], nextFrom: 1, hasMore: false }; } };
    await catchUpScope(convex, { scope_key: "team:T", position: 1, floor: 0 }, new Set());
    expect(calls).toHaveLength(1);
    expect((useInboxStore.getState().syncMeta as any)[scopeMetaKey("team:T")].cursor).toBe(1);
  });
});

describe("applyLogPage: review findings (sessions twins, seeds, project counts)", () => {
  const { catchUpScope, scopeMetaKey, catchUp } = require("../../hooks/useSyncChangeFeed");
  const scripted = (pages: any[]) => {
    const calls: any[] = [];
    return { calls, query: async (_fn: any, args: any) => { calls.push(args); return pages.shift(); } };
  };
  const base = (extra: any) => ({
    syncMeta: { [scopeMetaKey("user:u1")]: { cursor: 0 } },
    pending: {},
    syncLogApplyStats: { direct: 0, refetch: 0 },
    ...extra,
  });

  test("a delete for a conversation held only as a per-view twin still gets the absence probe", async () => {
    useInboxStore.setState(base({ sessions: {}, conversations: { c1: { _id: "c1", title: "open in a tab" } }, messages: { c1: [] } }) as any);
    const convex = scripted([
      { actions: [{ position: 1, entity_type: "conversations", entity_id: "c1", op: "delete" }], nextFrom: 1, hasMore: false },
      { sessions: [] }, // authorized absence
    ]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 1, floor: 0 }, new Set());
    expect(convex.calls).toHaveLength(2);
    expect(convex.calls[1].ids).toEqual(["c1"]);
    const s = useInboxStore.getState() as any;
    expect(s.conversations.c1).toBeUndefined();
    expect(s.messages.c1).toBeUndefined();
  });

  test("a full sessions cargo with no base is never seeded (a card needs its stamps): byIds only", async () => {
    useInboxStore.setState(base({ sessions: {}, conversations: {}, messages: {} }) as any);
    const convex = scripted([
      { actions: [{ position: 1, entity_type: "conversations", entity_id: "c2", op: "upsert", full: true, patch: { title: "new" } }], nextFrom: 1, hasMore: false },
      { sessions: [{ _id: "c2", title: "new", bucket: "needs_input", status: "active" }] },
    ]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 1, floor: 0 }, new Set());
    expect(convex.calls).toHaveLength(2);
    expect(useInboxStore.getState().syncLogApplyStats).toEqual({ direct: 0, refetch: 1 });
    expect((useInboxStore.getState() as any).sessions.c2.title).toBe("new");
  });

  test("a task status change refetches its held project so the joined counts move", async () => {
    useInboxStore.setState(base({
      tasks: { t1: { _id: "t1", title: "a", status: "open", project_id: "p1" } },
      projects: { p1: { _id: "p1", name: "P", task_counts: { total: 1, done: 0, in_progress: 0 } } },
    }) as any);
    const convex = scripted([
      { actions: [{ position: 1, entity_type: "tasks", entity_id: "t1", op: "upsert", patch: { status: "done" } }], nextFrom: 1, hasMore: false },
      [{ _id: "p1", name: "P", task_counts: { total: 1, done: 1, in_progress: 0 } }], // projects.webGetByIds
    ]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 1, floor: 0 }, new Set());
    expect(convex.calls).toHaveLength(2);
    expect(convex.calls[1].ids).toEqual(["p1"]);
    const s = useInboxStore.getState() as any;
    expect(s.tasks.t1.status).toBe("done"); // the patch applied directly
    expect(s.projects.p1.task_counts.done).toBe(1);
  });

  test("a title edit refetches nothing, and an unheld project is never fetched", async () => {
    useInboxStore.setState(base({
      tasks: { t1: { _id: "t1", title: "a", status: "open", project_id: "p1" }, t2: { _id: "t2", status: "open", project_id: "p9" } },
      projects: { p1: { _id: "p1", name: "P" } },
    }) as any);
    const convex = scripted([
      { actions: [
        { position: 1, entity_type: "tasks", entity_id: "t1", op: "upsert", patch: { title: "b" } },
        { position: 2, entity_type: "tasks", entity_id: "t2", op: "upsert", patch: { status: "done" } },
      ], nextFrom: 2, hasMore: false },
    ]);
    await catchUpScope(convex, { scope_key: "user:u1", position: 2, floor: 0 }, new Set());
    expect(convex.calls).toHaveLength(1);
  });

  test("catchUp stamps syncLogStampedAt once every scope cursor is stamped, and never on an empty heads list", async () => {
    useInboxStore.setState({ syncMeta: {}, syncLogStampedAt: null, syncLogLag: {} } as any);
    await catchUp(scripted([{ heads: [] }]));
    expect(useInboxStore.getState().syncLogStampedAt).toBeNull();
    await catchUp(scripted([{ heads: [{ scope_key: "user:u1", position: 7, floor: 0 }] }]));
    expect(useInboxStore.getState().syncLogStampedAt).not.toBeNull();
    expect((useInboxStore.getState().syncMeta as any)[scopeMetaKey("user:u1")].cursor).toBe(7);
  });
});
