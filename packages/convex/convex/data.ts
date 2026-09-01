import { Id } from "./_generated/dataModel";
import { resolveTeamForPath, DirectoryMapping, isTeamMember, teamVisibleConvTeam } from "./privacy";
import { invalidScope, forbidden } from "./lib/auth";
import {
  linkedConversationId,
  requireTeamMembership,
  workspaceKey,
  computeWorkspaceKey,
  resolveWorkspaceKey,
  parseWorkspaceKey,
  type WorkspaceKey,
} from "./lib/access";

type Workspace =
  | { type: "team"; teamId: Id<"teams"> }
  | { type: "personal"; userId: Id<"users"> };

type DataContextOpts = {
  userId: Id<"users">;
  project_path?: string;
  workspace?: "personal" | "team";
  team_id?: Id<"teams">;
};

const SCOPED_TABLES = new Set([
  "tasks", "plans", "docs", "projects", "decisions", "patterns",
]);

export type DataContext = Awaited<ReturnType<typeof createDataContext>>;

// ── Scoped fetch: shared workspace query pattern ──────────────────────
// Merges user + team records, resolves effective team through conversations,
// and filters by workspace. Eliminates the duplicate 3-branch fetching logic
// that each webList was reimplementing independently.

type ScopedFetchOpts = {
  userId: Id<"users">;
  teamId?: Id<"teams">;
  workspace?: "personal" | "team" | "all";
  limit?: number;
  stripFields?: string[];
};

// The row's ACCESS workspace key: the stored field when present, else the
// write-time compute against a pre-fetched conversation map (legacy rows
// minted before the backfill). Every list filter and the shipped-row stamp
// key on this ONE value — never on the raw team tag.
export function resolveWorkspaceKeyBatch(record: any, convMap: Map<string, any>): WorkspaceKey {
  if (typeof record.workspace === "string" && record.workspace) return record.workspace;
  const cid = linkedConversationId(record);
  const conv = cid ? convMap.get(cid) : undefined;
  return computeWorkspaceKey(record, conv ?? null);
}

// The team a row's ACCESS key names, or undefined for personal / unknown
// variants. Kept for callers that still think in "effective team" terms; new
// code should compare workspace keys directly.
export function resolveEffectiveTeam(record: any, convMap: Map<string, any>): Id<"teams"> | undefined {
  const ws = parseWorkspaceKey(resolveWorkspaceKeyBatch(record, convMap));
  return ws?.type === "team" ? ws.teamId : undefined;
}

export async function scopedFetch(
  ctx: { db: any },
  table: string,
  opts: ScopedFetchOpts
): Promise<{ records: any[]; convMap: Map<string, any> }> {
  const { userId, workspace } = opts;
  // teamId is client-supplied. Only honor it if the caller actually belongs to
  // that team — otherwise a foreign team_id would read that team's records.
  if (workspace === "team" && !opts.teamId) {
    invalidScope("team_id is required for the team workspace");
  }
  if (opts.teamId) {
    await requireTeamMembership(ctx, userId, opts.teamId);
  }
  const teamId = opts.teamId;
  const fetchLimit = opts.limit;
  const strip = opts.stripFields;
  // Hard cap prevents unbounded iteration when callers omit a limit
  const hardCap = fetchLimit || 2000;

  let userRecords: any[] = [];
  let teamRecords: any[] = [];

  // When stripFields is set, iterate with `for await` so only one full record
  // is in the V8 heap at a time — heavy fields are dropped before accumulating.
  const stripSet = strip ? new Set(strip) : null;
  const runQuery = async (q: any): Promise<any[]> => {
    if (stripSet) {
      const results: any[] = [];
      for await (const r of q) {
        const light: any = {};
        for (const k of Object.keys(r)) {
          if (!stripSet.has(k)) light[k] = r[k];
        }
        results.push(light);
        if (results.length >= hardCap) break;
      }
      return results;
    }
    return q.take(hardCap);
  };

  if (workspace === "personal") {
    userRecords = await runQuery(
      ctx.db.query(table).withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).order("desc")
    );
  } else if (workspace === "all") {
    userRecords = await runQuery(
      ctx.db.query(table).withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).order("desc")
    );
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    for (const m of memberships) {
      const teamRecs = await runQuery(
        ctx.db.query(table).withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id)).order("desc")
      );
      teamRecords.push(...teamRecs);
    }
  } else {
    userRecords = await runQuery(
      ctx.db.query(table).withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).order("desc")
    );
    if (teamId) {
      teamRecords = await runQuery(
        ctx.db.query(table).withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).order("desc")
      );
    }
  }

  // Merge + dedupe (user first, then team additions)
  const seen = new Set<string>();
  const all: any[] = [];
  for (const r of userRecords) { seen.add(String(r._id)); all.push(r); }
  for (const r of teamRecords) {
    if (!seen.has(String(r._id))) all.push(r);
  }

  // Batch-resolve linked conversations — keep only the fields used by
  // resolveEffectiveTeam and common callers to avoid holding large blobs
  // (title_embedding, git_diff, git_diff_staged) that blow the 64MB limit.
  const convIds = new Set<string>();
  for (const r of all) {
    const cid = linkedConversationId(r);
    if (cid) convIds.add(cid);
  }
  const convMap = new Map<string, any>();
  for (const cid of convIds) {
    const conv = await ctx.db.get(cid as any);
    if (conv) convMap.set(cid, {
      team_id: conv.team_id,
      is_private: conv.is_private,
      auto_shared: conv.auto_shared,
      team_visibility: conv.team_visibility,
      git_root: conv.git_root,
      started_at: conv.started_at,
      project_path: conv.project_path,
    });
  }

  // Filter by effective team. Workspace boundaries are strict: a team view
  // returns ONLY records whose effective team is that team, and the personal
  // view returns ONLY records with no effective team. A teamless record lives
  // in its owner's personal workspace and nowhere else — it must never follow
  // the user into a team space (that was the "personal task shows up in the
  // Union team view" leak).
  // One equality against the viewer's workspace key. Boundaries are strict: a
  // team view returns ONLY rows keyed to that team, the personal view ONLY
  // rows keyed to the viewer. A personal row never follows the user into a
  // team space, and one team's rows never appear in another's.
  let records: any[];
  if (workspace === "all") {
    // No team filter — caller wants every record the user can see across
    // their memberships plus their own untagged items.
    records = all;
  } else if ((workspace === "team" || !workspace) && teamId) {
    const key = workspaceKey({ type: "team", teamId });
    records = all.filter(r => resolveWorkspaceKeyBatch(r, convMap) === key);
  } else if (workspace === "personal") {
    const key = workspaceKey({ type: "personal", userId });
    records = all.filter(r => resolveWorkspaceKeyBatch(r, convMap) === key);
  } else {
    records = all;
  }

  stampEffectiveTeam(records, convMap);
  return { records, convMap };
}

// Normalize workspace truth onto rows we ship to clients: `workspace` becomes
// the resolved ACCESS key and team_id the team that key names (undefined for
// personal). Client-side workspace filters and the docs crawl's absent-prune
// key on these, so shipping the resolved values keeps every layer — server
// filter, client filter, prune scope — agreeing on one value. Mutates in
// place (rows are per-request copies, same as enrichTasks).
export function stampEffectiveTeam(records: any[], convMap: Map<string, any>): void {
  for (const r of records) {
    const key = resolveWorkspaceKeyBatch(r, convMap);
    r.workspace = key;
    const ws = parseWorkspaceKey(key);
    r.team_id = ws?.type === "team" ? ws.teamId : undefined;
  }
}

export function scopeByProject<T extends Record<string, any>>(
  items: T[],
  projectPath?: string | null
): T[] {
  if (!projectPath) return items;
  return items.filter(item => !item.project_path || item.project_path.startsWith(projectPath) || (item.git_root && item.git_root.startsWith(projectPath)));
}

export async function createDataContext(ctx: { db: any }, opts: DataContextOpts) {
  const workspace = await resolveWorkspace(ctx, opts);
  const key = workspaceKey(workspace);
  const projectPath = opts.project_path;

  const self = {
    workspace,
    workspaceKey: key,
    userId: opts.userId,
    projectPath,

    // Every scoped insert carries BOTH axes: team_id (routing) and workspace
    // (access). At the data-context boundary they agree, because the context
    // was resolved from one workspace choice; the two only diverge later
    // through conversation-visibility propagation (private work routed to a
    // team). A caller may pass an explicit `workspace` to mint that divergence
    // deliberately.
    async insert(table: string, fields: Record<string, any>) {
      const now = Date.now();
      const doc: Record<string, any> = {
        ...fields,
        user_id: opts.userId,
        created_at: fields.created_at ?? now,
        updated_at: now,
      };
      if (SCOPED_TABLES.has(table)) {
        doc.team_id = workspace.type === "team" ? workspace.teamId : undefined;
        doc.workspace = typeof fields.workspace === "string" && fields.workspace ? fields.workspace : key;
        if (projectPath && !doc.project_path) {
          doc.project_path = projectPath;
        }
      }
      return ctx.db.insert(table, doc);
    },

    query(table: string) {
      const applyProjectScope = SCOPED_TABLES.has(table) && projectPath;
      if (!SCOPED_TABLES.has(table)) {
        return applyProjectScope
          ? wrapProjectQuery(ctx.db.query(table), projectPath)
          : ctx.db.query(table);
      }
      // by_workspace is the chokepoint index. Legacy rows (no stored key yet)
      // ride the old routing index for the team space / owner index for the
      // personal space, filtered by their computed key — same answer, one
      // predicate, until the backfill retires the fallback.
      const base = wrapWorkspaceQuery(ctx, table, workspace, key, opts.userId);
      return applyProjectScope ? wrapProjectQuery(base, projectPath) : base;
    },

    async get(id: any) {
      const doc = await ctx.db.get(id);
      if (!doc) return null;
      if (!(await canAccess(ctx, doc, opts.userId, workspace, key))) return null;
      return doc;
    },

    async patch(id: any, fields: Record<string, any>) {
      const doc = await ctx.db.get(id);
      if (!doc || !(await canAccess(ctx, doc, opts.userId, workspace, key))) {
        throw new Error("Not found or no access");
      }
      return ctx.db.patch(id, { ...fields, updated_at: Date.now() });
    },

    async delete(id: any) {
      const doc = await ctx.db.get(id);
      if (!doc || !(await canAccess(ctx, doc, opts.userId, workspace, key))) {
        throw new Error("Not found or no access");
      }
      return ctx.db.delete(id);
    },

  };

  return self;
}

// Deleting a team has no cascade for everything stamped with its id, so a
// team reference must be checked against the row before it is treated as an
// access boundary. Missing team = the reference is debris, not a denial.
async function teamExists(ctx: { db: any }, teamId: Id<"teams">): Promise<boolean> {
  return !!(await ctx.db.get(teamId));
}

async function resolveWorkspace(ctx: { db: any }, opts: DataContextOpts): Promise<Workspace> {
  if (opts.workspace === "personal") {
    return { type: "personal", userId: opts.userId };
  }
  if (opts.workspace === "team" && opts.team_id) {
    // An explicit team that no longer exists is dangling data, not an access
    // question — the same rule as the mapping branch below. Callers derive
    // this team from a conversation's stamp (tasks/plans/docs create), and a
    // row stamped before its team was deleted must fall through to the
    // directory rule, not fail "team membership required" (codecast repo,
    // 2026-08-30: 4347 conversations carried a team deleted in April).
    if (await teamExists(ctx, opts.team_id)) {
      await requireTeamMembership(ctx, opts.userId, opts.team_id);
      return { type: "team", teamId: opts.team_id };
    }
  } else if (opts.workspace === "team") {
    invalidScope("team_id is required for the team workspace");
  }
  if (opts.project_path) {
    // Directory mappings are the whole rule: a mapped path scopes to its team,
    // an unmapped path is "Only Me" and scopes to the personal workspace. No
    // active-team fallback here — that fallback is how work items created from
    // private directories used to leak into the user's team (ct-38419).
    const mappings: DirectoryMapping[] = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", opts.userId))
      .collect();
    const result = resolveTeamForPath(mappings, opts.project_path, undefined);
    if (result.teamId) {
      // A mapping whose team row was deleted is dangling data, not an access
      // question: failing closed here bricked every task/plan/doc operation
      // from the mapped directory with no way to self-heal (codecast repo,
      // 2026-08-30 — the team died in April, the mapping survived). A missing
      // team resolves as unmapped; a LIVE team without membership still fails
      // closed exactly as before.
      if (!(await teamExists(ctx, result.teamId))) {
        return { type: "personal", userId: opts.userId };
      }
      if (!(await isTeamMember(ctx, opts.userId, result.teamId))) {
        forbidden("Forbidden: directory mapping points to a team the user cannot access");
      }
      return { type: "team", teamId: result.teamId };
    }
    return { type: "personal", userId: opts.userId };
  }
  return { type: "personal", userId: opts.userId };
}

// Owner always; otherwise the row's ACCESS key must equal the context's key.
// team_id is never consulted here — a team-routed private row (team_id: T,
// workspace: user:<owner>) is invisible to every other member of T.
async function canAccess(
  ctx: { db: any },
  doc: any,
  userId: Id<"users">,
  _workspace: Workspace,
  key: WorkspaceKey,
): Promise<boolean> {
  if (String(doc.user_id) === String(userId)) return true;
  return (await resolveWorkspaceKey(ctx, doc)) === key;
}

// Chokepoint query for a scoped table: rows whose ACCESS key equals the
// context's key. Reads by_workspace, then unions the legacy rows (no stored key
// yet) from the old routing/owner index, filtered by their computed key —
// so the answer is identical before and after the backfill.
function wrapWorkspaceQuery(
  ctx: { db: any },
  table: string,
  workspace: Workspace,
  key: WorkspaceKey,
  userId: Id<"users">,
): any {
  const legacyBase = () => workspace.type === "team"
    ? ctx.db.query(table).withIndex("by_team_id", (q: any) => q.eq("team_id", workspace.teamId))
    : ctx.db.query(table).withIndex("by_user_id", (q: any) => q.eq("user_id", userId));
  const keyed = () => ctx.db.query(table).withIndex("by_workspace", (q: any) => q.eq("workspace", key));

  const build = (mods: Array<(q: any) => any>) => {
    let a = keyed();
    let b = legacyBase();
    for (const m of mods) { a = m(a); b = m(b); }
    return [a, b];
  };
  const merge = async (mods: Array<(q: any) => any>): Promise<any[]> => {
    const [a, b] = build(mods);
    const out: any[] = await a.collect();
    const seen = new Set(out.map((d: any) => String(d._id)));
    for (const d of await b.collect()) {
      if (seen.has(String(d._id))) continue;
      if (typeof d.workspace === "string" && d.workspace) continue; // keyed elsewhere
      if ((await resolveWorkspaceKey(ctx, d)) === key) { seen.add(String(d._id)); out.push(d); }
    }
    return out;
  };

  const wrap = (mods: Array<(q: any) => any>): any => ({
    filter: (fn: any) => wrap([...mods, (q) => q.filter(fn)]),
    order: (dir: any) => wrap([...mods, (q) => q.order(dir)]),
    withIndex: (_name: string, _fn: any) => wrap(mods), // scope index is fixed
    async collect() { return merge(mods); },
    async first() { return (await merge(mods))[0] ?? null; },
    async take(n: number) { return (await merge(mods)).slice(0, n); },
    async paginate(opts: any) {
      // Pagination rides the keyed index; legacy rows (no stored key) join
      // only after the backfill. Every page is still filtered by the key so
      // the boundary never depends on the index alone.
      const [a] = build(mods);
      const result = await a.paginate(opts);
      const page: any[] = [];
      for (const d of result.page) {
        if ((await resolveWorkspaceKey(ctx, d)) === key) page.push(d);
      }
      return { ...result, page };
    },
  });
  return wrap([]);
}

function wrapProjectQuery(inner: any, projectPath: string): any {
  const matchesProject = (d: any) => !d.project_path || d.project_path.startsWith(projectPath) || (d.git_root && d.git_root.startsWith(projectPath));
  const wrap = (q: any) => ({
    filter: (fn: any) => wrap(q.filter(fn)),
    order: (dir: any) => wrap(q.order(dir)),
    async collect() {
      const results = await q.collect();
      return results.filter(matchesProject);
    },
    async first() {
      const results = await q.collect();
      return results.find(matchesProject) ?? null;
    },
    async take(n: number) {
      const results = await q.collect();
      return results.filter(matchesProject).slice(0, n);
    },
    withIndex: (name: string, fn: any) => wrap(q.withIndex(name, fn)),
    async paginate(opts: any) {
      const result = await q.paginate(opts);
      return { ...result, page: result.page.filter(matchesProject) };
    },
  });
  return wrap(inner);
}
