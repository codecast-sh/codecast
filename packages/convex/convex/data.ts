import { Id } from "./_generated/dataModel";
import { resolveTeamForPath, DirectoryMapping } from "./privacy";

type Workspace =
  | { type: "team"; teamId: Id<"teams"> }
  | { type: "personal"; userId: Id<"users"> }
  | { type: "unscoped" };

type DataContextOpts = {
  userId: Id<"users">;
  project_path?: string;
  workspace?: "personal" | "team";
  team_id?: Id<"teams">;
  active_team_id?: Id<"teams">;
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
  workspace?: "personal" | "team";
  limit?: number;
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
  if (conv) {
    return (!conv.is_private || conv.auto_shared) ? conv.team_id : undefined;
  }
  return record.team_id;
}

export async function scopedFetch(
  ctx: { db: any },
  table: string,
  opts: ScopedFetchOpts
): Promise<{ records: any[]; convMap: Map<string, any> }> {
  const { userId, teamId, workspace } = opts;
  const fetchLimit = opts.limit || 500;

  let userRecords: any[] = [];
  let teamRecords: any[] = [];

  if (workspace === "personal") {
    userRecords = await ctx.db.query(table)
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .order("desc")
      .take(fetchLimit);
  } else {
    userRecords = await ctx.db.query(table)
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .order("desc")
      .take(fetchLimit);
    if (teamId) {
      teamRecords = await ctx.db.query(table)
        .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
        .order("desc")
        .take(fetchLimit);
    }
  }

  // Merge + dedupe (user first, then team additions)
  const seen = new Set<string>();
  const all: any[] = [];
  for (const r of userRecords) { seen.add(String(r._id)); all.push(r); }
  for (const r of teamRecords) {
    if (!seen.has(String(r._id))) all.push(r);
  }

  // Batch-resolve linked conversations
  const convIds = new Set<string>();
  for (const r of all) {
    const cid = getLinkedConvId(r);
    if (cid) convIds.add(cid);
  }
  const convMap = new Map<string, any>();
  for (const cid of convIds) {
    const conv = await ctx.db.get(cid as any);
    if (conv) convMap.set(cid, conv);
  }

  // Filter by effective team
  let records: any[];
  if ((workspace === "team" || !workspace) && teamId) {
    records = all.filter(r => {
      const eff = resolveEffectiveTeam(r, convMap);
      return eff && String(eff) === String(teamId);
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
    raw: ctx.db,

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
      if (!SCOPED_TABLES.has(table) || workspace.type === "unscoped") {
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

    get unscoped() {
      return {
        query: (table: string) => ctx.db.query(table),
        get: (id: any) => ctx.db.get(id),
        patch: (id: any, fields: Record<string, any>) =>
          ctx.db.patch(id, { ...fields, updated_at: Date.now() }),
        delete: (id: any) => ctx.db.delete(id),
        insert: (table: string, fields: Record<string, any>) => {
          const now = Date.now();
          return ctx.db.insert(table, {
            ...fields,
            user_id: opts.userId,
            created_at: fields.created_at ?? now,
            updated_at: now,
          });
        },
        raw: ctx.db,
      };
    },
  };

  return self;
}

async function resolveWorkspace(ctx: { db: any }, opts: DataContextOpts): Promise<Workspace> {
  if (opts.workspace === "personal") {
    return { type: "personal", userId: opts.userId };
  }
  if (opts.workspace === "team" && opts.team_id) {
    return { type: "team", teamId: opts.team_id };
  }
  if (opts.project_path) {
    const mappings: DirectoryMapping[] = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", opts.userId))
      .collect();
    const result = resolveTeamForPath(mappings, opts.project_path, undefined);
    if (result.teamId) return { type: "team", teamId: result.teamId };
    if (opts.active_team_id) return { type: "team", teamId: opts.active_team_id };
    return { type: "personal", userId: opts.userId };
  }
  if (opts.active_team_id) return { type: "team", teamId: opts.active_team_id };
  return { type: "unscoped" };
}

function canAccess(doc: any, userId: Id<"users">, workspace: Workspace): boolean {
  if (String(doc.user_id) === String(userId)) return true;
  if (workspace.type === "team" && String(doc.team_id) === String(workspace.teamId)) return true;
  if (workspace.type === "unscoped") return true;
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
    paginate: (opts: any) => q.paginate(opts),
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
    paginate: (opts: any) => q.paginate(opts),
  });
  return wrap(inner);
}
