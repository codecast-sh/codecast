// Access matrix: which rows each identity receives from the queries that feed
// the store's workspace-scoped collections, and from the sync log.
//
// Five identities over one seeded world:
//  owner     member of T; owns a team row, a private-in-team row (team_id T,
//            workspace user:owner) and a personal row
//  teammate  member of T
//  stranger  member of O; owns a row in O
//  removed   was a member of T, removed before the reads
//  outsider  signed in, in no team
// Each identity must receive exactly its expected rows, whatever workspace
// arguments it sends. A row outside that set is a leak. A collection whose
// rows cannot take some placement (a live flow is always a team's) seeds only
// the placements it can, plus any its access rule must refuse (EXPECTED_FOR).
//
// The feed list comes from CLIENT_SYNC_REGISTRY: every feed of a
// workspaceScoped key is either exercised here (FEED_CASES) or named in
// NOT_YET_COVERED, a list that may only shrink. Registering a new feed fails
// this test until it is covered.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { makeChangeTrackedDb } from "./changeLog";
import { makeSyncAckCollector, teamScopeKey, userScopeKey } from "./syncLog";
import { CLIENT_SYNC_REGISTRY } from "../../web/store/clientSyncRegistry";

const MATRIX_KEYS = ["tasks", "docs", "plans", "projects"] as const;

// Keys whose rows reach the store through a bespoke useSync* hook rather than
// a registry `feeds` entry: the list queries those hooks mount, plus the byIds
// reads the sync log's applier falls back to (hooks/useSyncChangeFeed.ts).
const HOOK_FEEDS: Record<(typeof MATRIX_KEYS)[number], string[]> = {
  tasks: ["tasks.webList", "tasks.webListPaginated", "tasks.webGetByIds"],
  docs: ["docs.webListPaginated", "docs.webGetByIds"],
  plans: ["plans.webGetByIds"],
  projects: ["projects.webList", "projects.webGetByIds"],
};

// Registered feeds of workspace-scoped keys this matrix does not seed yet.
// Shrink it by adding a case; never grow it to get a new feed past the test.
const NOT_YET_COVERED = new Set([
  "expectations.overview", "lineTrial.cards", "lineTrial.projects", "lineTrial.runs",
  "modObjects.webList", "initiatives.webList", "agentDefinitions.list", "secrets.list",
  "agentDefinitions.listChains", "issueSync.listSources", "workflows.webList", "workflows.webGet",
  "workflows.webGetBySlug", "workflows.webPool", "workflow_runs.graphOfRun", "signals.webList",
  "signals.forTask", "lineWorkspace.labels", "lineWorkspace.deploys", "lineTimeline.page",
  "ingest.listSources", "ingest.listGroups", "ingest.getGroup", "ingest.listEvents",
  "replays.list", "replays.get", "metrics.listWatches", "orgChanges.list",
]);

type Ids = Awaited<ReturnType<typeof seed>>;
type Who = "owner" | "teammate" | "stranger" | "removed" | "outsider";
const WHO: Who[] = ["owner", "teammate", "stranger", "removed", "outsider"];

// Argument variants every list feed is called with: an identity asking for a
// workspace it does not hold must get nothing back (or an error).
const listArgs = (ids: Ids) => [
  {},
  { workspace: "personal" },
  { workspace: "team", team_id: ids.T },
  { workspace: "team", team_id: ids.O },
  { team_id: ids.T },
  { workspace: "all" },
];
const paginated = (variants: Record<string, unknown>[]) => variants.map((a) => ({ ...a, paginationOpts: { numItems: 200, cursor: null } }));
const byIdsArgs = (ids: Ids) => [{ ids: Object.values(ids.rows).flatMap((r) => Object.values(r)).map(String) }];

const FEED_CASES: Record<string, (ids: Ids) => Record<string, unknown>[]> = {
  "tasks.webList": listArgs,
  "tasks.webListPaginated": (ids) => paginated(listArgs(ids)),
  "docs.webListPaginated": (ids) => paginated(listArgs(ids).filter((a) => a.workspace !== "all")),
  "plans.webList": listArgs,
  "projects.webList": (ids) => listArgs(ids).filter((a) => a.workspace !== "all"),
  "tasks.webGetByIds": byIdsArgs,
  "docs.webGetByIds": byIdsArgs,
  "plans.webGetByIds": byIdsArgs,
  "projects.webGetByIds": byIdsArgs,
  "liveFlows.forTeam": (ids) => [{ team_id: ids.T }, { team_id: ids.O }],
  "flowLibrary.sessionFlows": (ids) => [{}, { team_id: ids.T }, { team_id: ids.O }],
  // Every workspace a placement names, the owner's personal one and the viewer's own.
  "flowMap.forTeam": (ids) => [...new Set([...Object.values(ids.rows.flowMaps), ...WHO.map((w) => `user:${ids[w]}`)])].map((workspace) => ({ workspace })),
  // Every workspace the viewer holds a key for, in one answer.
  "teamKit.webListTeamKitItems": () => [{}],
};

// A feed whose answer is not a list of rows: what the web feeder hands the
// store, so the matrix reads the rows the store would hold.
const SELECT: Record<string, (res: any) => unknown> = {
  // useFlowMap: one row keyed by its workspace.
  "flowMap.forTeam": (m) => (m ? [{ _id: m.workspace }] : []),
  // useSyncTeamKit: the answer's items.
  "teamKit.webListTeamKitItems": (r) => r?.items ?? [],
};

function registeredFeeds(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, entry] of Object.entries(CLIENT_SYNC_REGISTRY) as [string, any][]) {
    if (!entry.workspaceScoped) continue;
    for (const feed of entry.feeds ?? []) out.set(feed, key);
    for (const feed of HOOK_FEEDS[key as keyof typeof HOOK_FEEDS] ?? []) out.set(feed, key);
  }
  return out;
}

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (raw) => {
    const db = makeChangeTrackedDb(raw.db, makeSyncAckCollector());
    const now = Date.now();
    const user = (name: string) => db.insert("users", { name });
    const owner = await user("Owner");
    const teammate = await user("Teammate");
    const stranger = await user("Stranger");
    const removed = await user("Removed");
    const outsider = await user("Outsider");
    const T = await db.insert("teams", { name: "T", created_at: now, invite_code: "t" });
    const O = await db.insert("teams", { name: "O", created_at: now, invite_code: "o" });
    const join = (user_id: any, team_id: any, role = "member") => db.insert("team_memberships", { user_id, team_id, role, joined_at: now });
    await join(owner, T, "admin");
    await join(teammate, T);
    await join(stranger, O, "admin");
    await db.delete(await join(removed, T));

    // One row per placement, per table.
    const placements = {
      team: { user_id: owner, team_id: T, workspace: `team:${T}` },
      private: { user_id: owner, team_id: T, workspace: `user:${owner}` },
      personal: { user_id: owner, workspace: `user:${owner}` },
      other: { user_id: stranger, team_id: O, workspace: `team:${O}` },
    };
    let n = 0;
    const base = (place: string) => ({ title: `${place} row`, created_at: now, updated_at: now });
    const rows: Record<string, Record<string, string>> = { tasks: {}, docs: {}, plans: {}, projects: {}, liveFlows: {}, sessionFlows: {}, flowMaps: {}, teamKitItems: {} };
    for (const [place, p] of Object.entries(placements)) {
      rows.tasks[place] = await db.insert("tasks", { ...p, ...base(place), short_id: `ct-${++n}`, task_type: "task", priority: "medium", source: "human", status: "open" });
      rows.docs[place] = await db.insert("docs", { ...p, ...base(place), content: "body", doc_type: "note", source: "human" });
      rows.plans[place] = await db.insert("plans", { ...p, ...base(place), short_id: `pl-${++n}`, status: "active", source: "human" });
      rows.projects[place] = await db.insert("projects", { ...p, ...base(place), status: "active" });
      const workflow_id = await db.insert("workflows", { ...p, name: `${place} flow`, slug: `${place}-flow`, nodes: [], edges: [], created_at: now, updated_at: now } as any);
      const run = await db.insert("workflow_runs", { ...p, workflow_id, workflow_name: `${place} flow`, status: "completed", node_statuses: [], created_at: now, updated_at: now } as any);
      rows.sessionFlows[place] = await db.insert("session_flows", { ...p, graph_hash: `g-${place}`, from: "graph", name: `${place} flow`, source: "", nodes: [], edges: [], file: "flow.cast", files: [], graph_nodes: [], first_run_id: run, last_run_at: now, created_at: now });
      // A live flow is a team's (createLiveFlowCore); the private one is the row its access rule must refuse.
      if (place !== "personal") rows.liveFlows[place] = await db.insert("live_flows", { ...p, workflow_id, on: false, changed_by: p.user_id, changed_at: now, created_at: now });
      // A flow map is one per workspace, so the private and personal placements share one.
      if (place !== "private") rows.flowMaps[place] = p.workspace;
      rows.teamKitItems[place] = await db.insert("team_kit_items", { slug: `authored/${p.user_id}/skill/${place}-kit`, ...(p.team_id ? { team_id: p.team_id } : {}), workspace: p.workspace, kind: "skill", name: `${place}-kit`, author_user_id: p.user_id, current_version: 1, current_hash: `h-${place}`, surfaces: [], created_at: now, updated_at: now } as any);
    }
    return { owner, teammate, stranger, removed, outsider, T, O, rows };
  });
}

// What each identity may see, by placement.
const EXPECTED: Record<Who, string[]> = {
  owner: ["personal", "private", "team"],
  teammate: ["team"],
  stranger: ["other"],
  removed: [],
  outsider: [],
};

// Collections whose expected set differs from EXPECTED, by the placements they seed.
const EXPECTED_FOR: Record<string, Record<Who, string[]>> = {
  liveFlows: { ...EXPECTED, owner: ["team"] },
  flowMaps: { ...EXPECTED, owner: ["personal", "team"] },
};

function rowIdsOf(result: unknown): string[] {
  const ids: string[] = [];
  const take = (v: unknown) => {
    if (Array.isArray(v)) for (const r of v) if (r && typeof r === "object" && "_id" in r) ids.push(String((r as any)._id));
  };
  take(result);
  if (result && typeof result === "object" && !Array.isArray(result)) for (const v of Object.values(result)) take(v);
  return ids;
}

function placementsOf(ids: Ids, table: string, seen: Iterable<string>): string[] {
  const byId = new Map(Object.entries(ids.rows[table]).map(([place, id]) => [String(id), place]));
  return [...new Set([...seen].map((id) => byId.get(id)).filter((p): p is string => !!p))].sort();
}

const fnRef = (feed: string) => feed.split(".").reduce((o: any, k) => o?.[k], api);

describe("access matrix", () => {
  test("every registered feed of a workspace-scoped key is covered or listed as not yet covered", () => {
    const feeds = registeredFeeds();
    const missing = [...feeds.keys()].filter((f) => !FEED_CASES[f] && !NOT_YET_COVERED.has(f));
    expect(missing).toEqual([]);
    // A stale entry would hide a later regression behind a name nobody registers.
    expect([...NOT_YET_COVERED].filter((f) => !feeds.has(f))).toEqual([]);
    for (const f of Object.keys(FEED_CASES)) expect(fnRef(f)).toBeDefined();
  });

  for (const [feed, argsFor] of Object.entries(FEED_CASES)) {
    test(`${feed}: each identity receives exactly its rows`, async () => {
      const t = convexTest(schema, allModules);
      const ids = await seed(t);
      const table = registeredFeeds().get(feed)!;
      const got: Record<string, string[]> = {};
      for (const who of WHO) {
        const seen: string[] = [];
        for (const args of argsFor(ids)) {
          const res = await t.withIdentity({ subject: ids[who] }).query(fnRef(feed), args).catch(() => null);
          seen.push(...rowIdsOf(SELECT[feed] ? SELECT[feed](res) : res));
        }
        got[who] = placementsOf(ids, table, seen);
      }
      // Owner rows may be split across workspaces; the union must be exact.
      expect(got).toEqual(EXPECTED_FOR[table] ?? EXPECTED);
    });
  }

  test("syncLog.getRange: each identity receives cargo for exactly its rows, across every scope", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const scopes = [teamScopeKey(ids.T), teamScopeKey(ids.O), ...WHO.map((w) => userScopeKey(ids[w]))];
    for (const table of MATRIX_KEYS) {
      const got: Record<string, string[]> = {};
      for (const who of WHO) {
        const seen: string[] = [];
        for (const scope_key of scopes) {
          const page: any = await t.withIdentity({ subject: ids[who] }).query(api.syncLog.getRange, { scope_key, from: 0, limit: 1000, cargo: true });
          for (const a of page.actions) if (a.entity_type === table && a.op === "upsert" && a.patch) seen.push(a.entity_id);
        }
        got[who] = placementsOf(ids, table, seen);
      }
      expect({ table, ...got }).toEqual({ table, ...EXPECTED });
    }
  });
});
