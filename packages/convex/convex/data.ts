import { Id } from "./_generated/dataModel";
import { resolveTeamForPath, DirectoryMapping, isTeamMember, teamVisibleConvTeam } from "./privacy";
import { invalidScope, forbidden } from "./lib/auth";
import { requireTeamMembership } from "./lib/access";

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

function getLinkedConvId(record: any): string | undefined {
  if (record.conversation_id) return String(record.conversation_id);
  if (record.created_from_conversation) return String(record.created_from_conversation);
  if (record.related_conversation_ids?.[0]) return String(record.related_conversation_ids[0]);
  if (record.conversation_ids?.[0]) return String(record.conversation_ids[0]);
  return undefined;
}

export function resolveEffectiveTeam(record: any, convMap: Map<string, any>): Id<"teams"> | undefined {
  const cid = getLinkedConvId(record);
  const conv = cid ? convMap.get(cid) : undefined;
  if (conv) return teamVisibleConvTeam(conv);
  return record.team_id;
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
    const cid = getLinkedConvId(r);
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

  // Filter by effective team. In team view, also include the user's own
  // untagged records (no conv-derived team and no team_id) — orphans created
  // before any team was active follow the user into their active workspace
  // rather than vanishing.
  let records: any[];
  if (workspace === "all") {
    // No team filter — caller wants every record the user can see across
    // their memberships plus their own untagged items.
    records = all;
  } else if ((workspace === "team" || !workspace) && teamId) {
    records = all.filter(r => {
      const eff = resolveEffectiveTeam(r, convMap);
      if (eff) return String(eff) === String(teamId);
      return String(r.user_id) === String(userId);
    });
  } else if (workspace === "personal") {
    records = all.filter(r => !resolveEffectiveTeam(r, convMap));
  } else {
    records = all;
  }

  return { records, convMap };
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
  const projectPath = opts.project_path;

  const self = {
    workspace,
    userId: opts.userId,
    projectPath,

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
      if (workspace.type === "team") {
        const base = ctx.db.query(table)
          .withIndex("by_team_id", (q: any) => q.eq("team_id", workspace.teamId));
        return applyProjectScope ? wrapProjectQuery(base, projectPath) : base;
      }
      const personal = wrapPersonalQuery(
        ctx.db.query(table)
          .withIndex("by_user_id", (q: any) => q.eq("user_id", opts.userId))
      );
      return applyProjectScope ? wrapProjectQuery(personal, projectPath) : personal;
    },

    async get(id: any) {
      const doc = await ctx.db.get(id);
      if (!doc) return null;
      if (!canAccess(doc, opts.userId, workspace)) return null;
      return doc;
    },

    async patch(id: any, fields: Record<string, any>) {
      const doc = await ctx.db.get(id);
      if (!doc || !canAccess(doc, opts.userId, workspace)) {
        throw new Error("Not found or no access");
      }
      return ctx.db.patch(id, { ...fields, updated_at: Date.now() });
    },

    async delete(id: any) {
      const doc = await ctx.db.get(id);
      if (!doc || !canAccess(doc, opts.userId, workspace)) {
        throw new Error("Not found or no access");
      }
      return ctx.db.delete(id);
    },

  };

  return self;
}

async function resolveWorkspace(ctx: { db: any }, opts: DataContextOpts): Promise<Workspace> {
  if (opts.workspace === "personal") {
    return { type: "personal", userId: opts.userId };
  }
  if (opts.workspace === "team" && opts.team_id) {
    await requireTeamMembership(ctx, opts.userId, opts.team_id);
    return { type: "team", teamId: opts.team_id };
  }
  if (opts.workspace === "team") {
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
      if (!(await isTeamMember(ctx, opts.userId, result.teamId))) {
        forbidden("Forbidden: directory mapping points to a team the user cannot access");
      }
      return { type: "team", teamId: result.teamId };
    }
    return { type: "personal", userId: opts.userId };
  }
  return { type: "personal", userId: opts.userId };
}

function canAccess(doc: any, userId: Id<"users">, workspace: Workspace): boolean {
  if (String(doc.user_id) === String(userId)) return true;
  if (workspace.type === "team" && String(doc.team_id) === String(workspace.teamId)) return true;
  return false;
}

function wrapPersonalQuery(inner: any): any {
  const wrap = (q: any) => ({
    filter: (fn: any) => wrap(q.filter(fn)),
    order: (dir: any) => wrap(q.order(dir)),
    async collect() {
      const results = await q.collect();
      return results.filter((d: any) => !d.team_id);
    },
    async first() {
      const results = await q.collect();
      return results.find((d: any) => !d.team_id) ?? null;
    },
    async take(n: number) {
      const results = await q.collect();
      return results.filter((d: any) => !d.team_id).slice(0, n);
    },
    withIndex: (name: string, fn: any) => wrap(q.withIndex(name, fn)),
    async paginate(opts: any) {
      const result = await q.paginate(opts);
      return { ...result, page: result.page.filter((d: any) => !d.team_id) };
    },
  });
  return wrap(inner);
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
