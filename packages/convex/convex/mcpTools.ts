// The MCP read tools (docs/architecture/agent-mcp.md). Each runs as one
// account and asks the rule the app already uses: scopedFetch for lists,
// canAccessDoc/Task/Plan for single rows, accountAdmission for a page,
// sessionCardFor for a session. No tool decides access on its own.
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { MCP_READ_SCOPE } from "@codecast/shared/contracts";
import { scopedFetch } from "./data";
import { canAccessDoc, canAccessPlan, canAccessTask } from "./lib/access";
import { accountAdmission, pagesVisibleTo } from "./artifacts";
import { artifactUrl } from "./lib/artifactRules";
import { sessionCardFor } from "./lib/sessionCard";
import { teamVisibleConvTeam } from "./privacy";
import { workspaceKey, type WorkspaceKey } from "./lib/accessKeys";

/** A refusal the agent should read (bad id, unknown workspace), not a crash. */
export class ToolInputError extends Error {}

type Ctx = { db: any };
type Scope = { workspace: "all" } | { workspace: "personal" } | { workspace: "team"; teamId: Id<"teams"> };

const clampLimit = (n: unknown) => Math.max(1, Math.min(100, typeof n === "number" && n > 0 ? Math.floor(n) : 25));
const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : undefined);
const matches = (q: string | undefined, ...texts: (string | undefined | null)[]) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return texts.some((t) => t?.toLowerCase().includes(needle));
};

async function teamsOf(ctx: Ctx, userId: Id<"users">): Promise<Array<{ id: Id<"teams">; name: string }>> {
  const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const out = [];
  for (const m of memberships) {
    const team = await ctx.db.get(m.team_id);
    if (team) out.push({ id: team._id, name: team.name as string });
  }
  return out;
}

/** The workspace filter an agent named: "personal", a team's name or id, or none. */
async function resolveScope(ctx: Ctx, userId: Id<"users">, name: unknown): Promise<Scope> {
  if (name === undefined || name === null || name === "") return { workspace: "all" };
  if (typeof name !== "string") throw new ToolInputError("workspace must be a string");
  if (name.toLowerCase() === "personal") return { workspace: "personal" };
  const teams = await teamsOf(ctx, userId);
  const hit = teams.find((t) => String(t.id) === name || t.name.toLowerCase() === name.toLowerCase());
  if (!hit) throw new ToolInputError(`No workspace named "${name}". whoami lists the ones this account can read.`);
  return { workspace: "team", teamId: hit.id };
}

function scopeKeys(userId: Id<"users">, scope: Scope): Set<WorkspaceKey> | null {
  if (scope.workspace === "all") return null;
  return new Set([workspaceKey(scope.workspace === "personal" ? { type: "personal", userId } : { type: "team", teamId: scope.teamId })]);
}

async function fetchScoped(ctx: Ctx, table: string, userId: Id<"users">, scope: Scope, stripFields?: string[]) {
  const { records } = await scopedFetch(ctx, table, {
    userId,
    workspace: scope.workspace,
    teamId: scope.workspace === "team" ? scope.teamId : undefined,
    limit: 500,
    stripFields,
  });
  return records.sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

async function workspaceName(ctx: Ctx, key: string | undefined): Promise<string> {
  if (!key || key.startsWith("user:")) return "personal";
  const id = key.startsWith("team:") ? ctx.db.normalizeId("teams", key.slice(5)) : null;
  const team = id ? await ctx.db.get(id) : null;
  return team?.name ?? "team";
}

// ── whoami ──
async function whoami(ctx: Ctx, userId: Id<"users">, auth: AuthKind) {
  const user = await ctx.db.get(userId);
  const teams = await teamsOf(ctx, userId);
  return {
    account: { name: user?.name ?? null, email: user?.email ?? null },
    workspaces: [{ name: "personal" }, ...teams.map((t) => ({ name: t.name, id: String(t.id) }))],
    connection: auth === "grant" ? "connected agent" : "cast token",
    scope: MCP_READ_SCOPE,
    can: "read docs, tasks, plans, published pages and session cards this account can read",
    cannot: "write anything, message sessions, read transcripts or the vault",
  };
}

// ── docs ──
async function listDocs(ctx: Ctx, userId: Id<"users">, args: any) {
  const scope = await resolveScope(ctx, userId, args.workspace);
  const limit = clampLimit(args.limit);
  const keys = scopeKeys(userId, scope);
  let rows: any[];
  if (args.query) {
    // Title search over the whole index, then the one access rule, then the filter.
    const hits = await ctx.db.query("docs").withSearchIndex("search_docs_v2", (q: any) => q.search("title", String(args.query))).take(limit * 5);
    rows = [];
    for (const d of hits) {
      if (d.archived_at || !(await canAccessDoc(ctx, userId, d))) continue;
      if (keys && !keys.has(d.workspace)) continue;
      rows.push(d);
    }
  } else {
    rows = (await fetchScoped(ctx, "docs", userId, scope, ["content", "entries", "embedding"])).filter((d: any) => !d.archived_at);
  }
  const out = [];
  for (const d of rows.slice(0, limit)) {
    out.push({ id: `doc:${d._id}`, title: d.title, type: d.doc_type ?? null, workspace: await workspaceName(ctx, d.workspace), updated_at: iso(d.updated_at) });
  }
  return { docs: out };
}

async function readDoc(ctx: Ctx, userId: Id<"users">, args: any) {
  const raw = String(args.id ?? "").replace(/^doc:/, "");
  const id = ctx.db.normalizeId("docs", raw);
  const doc = id ? await ctx.db.get(id) : null;
  if (!doc || !(await canAccessDoc(ctx, userId, doc))) return { found: false };
  return {
    id: `doc:${doc._id}`,
    title: doc.title,
    type: doc.doc_type ?? null,
    workspace: await workspaceName(ctx, doc.workspace),
    updated_at: iso(doc.updated_at),
    content: doc.content ?? "",
  };
}

// ── tasks ──
async function findByShortId(ctx: Ctx, table: "tasks" | "plans", ref: unknown) {
  const id = String(ref ?? "").trim();
  if (!id) throw new ToolInputError("id is required");
  return ctx.db.query(table).withIndex("by_short_id", (q: any) => q.eq("short_id", id)).first();
}

const taskRow = async (ctx: Ctx, t: any) => ({
  id: t.short_id,
  title: t.title,
  status: t.status,
  priority: t.priority ?? null,
  workspace: await workspaceName(ctx, t.workspace),
  updated_at: iso(t.updated_at),
});

async function listTasks(ctx: Ctx, userId: Id<"users">, args: any) {
  const scope = await resolveScope(ctx, userId, args.workspace);
  const limit = clampLimit(args.limit);
  const rows = (await fetchScoped(ctx, "tasks", userId, scope, ["embedding"]))
    .filter((t: any) => (!args.status || t.status === args.status) && matches(args.query, t.title, t.description, t.short_id));
  const out = [];
  for (const t of rows.slice(0, limit)) out.push(await taskRow(ctx, t));
  return { tasks: out };
}

async function readTask(ctx: Ctx, userId: Id<"users">, args: any) {
  const task = await findByShortId(ctx, "tasks", args.id);
  if (!task || !(await canAccessTask(ctx, userId, task))) return { found: false };
  const comments = await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", task._id)).order("desc").take(50);
  const plan = task.plan_id ? await ctx.db.get(task.plan_id) : null;
  return {
    ...(await taskRow(ctx, task)),
    description: task.description ?? "",
    plan: plan && (await canAccessPlan(ctx, userId, plan)) ? { id: plan.short_id, title: plan.title } : null,
    created_at: iso(task.created_at),
    comments: comments.reverse().map((c: any) => ({ author: c.author, type: c.comment_type, text: c.text, at: iso(c.created_at) })),
  };
}

// ── plans ──
async function listPlans(ctx: Ctx, userId: Id<"users">, args: any) {
  const scope = await resolveScope(ctx, userId, args.workspace);
  const limit = clampLimit(args.limit);
  const rows = (await fetchScoped(ctx, "plans", userId, scope, ["entries", "progress_log", "decision_log", "discoveries", "context_pointers"]))
    .filter((p: any) => matches(args.query, p.title, p.goal, p.short_id));
  const out = [];
  for (const p of rows.slice(0, limit)) {
    out.push({ id: p.short_id, title: p.title, status: p.status, goal: p.goal ?? null, workspace: await workspaceName(ctx, p.workspace), updated_at: iso(p.updated_at) });
  }
  return { plans: out };
}

async function readPlan(ctx: Ctx, userId: Id<"users">, args: any) {
  const plan = await findByShortId(ctx, "plans", args.id);
  if (!plan || !(await canAccessPlan(ctx, userId, plan))) return { found: false };
  const tasks = await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).take(200);
  const visible = [];
  for (const t of tasks) if (await canAccessTask(ctx, userId, t)) visible.push(await taskRow(ctx, t));
  return {
    id: plan.short_id,
    title: plan.title,
    status: plan.status,
    goal: plan.goal ?? null,
    description: plan.description ?? "",
    acceptance_criteria: plan.acceptance_criteria ?? [],
    workspace: await workspaceName(ctx, plan.workspace),
    updated_at: iso(plan.updated_at),
    tasks: visible,
  };
}

// ── pages ──
async function listPages(ctx: Ctx, userId: Id<"users">, args: any) {
  const scope = await resolveScope(ctx, userId, args.workspace);
  const keys = scopeKeys(userId, scope);
  const limit = clampLimit(args.limit);
  const rows = (await pagesVisibleTo(ctx, userId))
    .filter((p) => (!keys || keys.has(p.workspace)) && matches(args.query, p.row.title, p.row.slug))
    .sort((a, b) => b.row.updated_at - a.row.updated_at);
  const out = [];
  for (const p of rows.slice(0, limit)) {
    out.push({
      url: artifactUrl(p.row.slug),
      title: p.row.title,
      author: p.author.name,
      mine: p.mine,
      workspace: await workspaceName(ctx, p.workspace),
      version: p.row.version,
      updated_at: iso(p.row.updated_at),
    });
  }
  return { pages: out };
}

/** "https://codecast.sh/a/<slug>", "codecast.sh/a/<slug>?v=2", or the bare slug. */
export function pageSlug(ref: unknown): string | null {
  const s = String(ref ?? "").trim();
  const m = s.match(/\/a\/([A-Za-z0-9]{6,32})(?:[/?#]|$)/) ?? s.match(/^([A-Za-z0-9]{6,32})$/);
  return m ? m[1] : null;
}

/** The page's metadata and the storage holding its text, or why it stays shut. */
export const pageForRead = internalQuery({
  args: { user_id: v.id("users"), page: v.string() },
  handler: async (ctx, args): Promise<
    | { found: false }
    | { locked: true; url: string; title: string; reason: string }
    | { url: string; title: string; author: string | null; version: number; updated_at: string | undefined; storage_id: Id<"_storage">; format: "markdown" | "html" }
  > => {
    const slug = pageSlug(args.page);
    if (!slug) return { found: false };
    const artifact: Doc<"artifacts"> | null = await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", slug)).first();
    if (!artifact || (artifact as any).deleted_at) return { found: false };
    const url = artifactUrl(slug);
    const admission = await accountAdmission(ctx, artifact, args.user_id);
    if (admission.blocked) return { locked: true, url, title: artifact.title, reason: admission.blocked };
    const author = await ctx.db.get(artifact.user_id);
    return {
      url,
      title: artifact.title,
      author: author?.name ?? null,
      version: artifact.version,
      updated_at: iso(artifact.updated_at),
      storage_id: artifact.source_storage_id ?? artifact.storage_id,
      format: artifact.source_storage_id ? "markdown" : "html",
    };
  },
});

// ── sessions ──
async function listSessions(ctx: Ctx, userId: Id<"users">, args: any) {
  const scope = await resolveScope(ctx, userId, args.workspace);
  const limit = clampLimit(args.limit);
  const seen = new Set<string>();
  const candidates: any[] = [];
  const push = (rows: any[]) => {
    for (const c of rows) if (!seen.has(String(c._id)) && !c.is_subagent) { seen.add(String(c._id)); candidates.push(c); }
  };
  if (scope.workspace !== "team") {
    push(await ctx.db.query("conversations").withIndex("by_user_updated", (q: any) => q.eq("user_id", userId)).order("desc").take(150));
  }
  if (scope.workspace !== "personal") {
    const teams = scope.workspace === "team" ? [{ id: scope.teamId }] : await teamsOf(ctx, userId);
    for (const team of teams) {
      const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team.id)).take(50);
      for (const m of members) {
        push(await ctx.db.query("conversations").withIndex("by_team_user_updated", (q: any) => q.eq("team_id", team.id).eq("user_id", m.user_id)).order("desc").take(15));
      }
    }
  }
  candidates.sort((a, b) => b.updated_at - a.updated_at);
  const out = [];
  for (const c of candidates) {
    // A personal-only filter keeps sessions not shared with any team.
    if (scope.workspace === "personal" && teamVisibleConvTeam(c)) continue;
    if (!matches(args.query, c.title, c.subtitle, c.project_path)) continue;
    const card = await sessionCardFor(ctx, userId, c);
    if (card) out.push(card);
    if (out.length >= limit) break;
  }
  return { sessions: out };
}

async function readSession(ctx: Ctx, userId: Id<"users">, args: any) {
  const ref = String(args.id ?? "").trim();
  if (!ref) throw new ToolInputError("id is required");
  // The short id cards carry (jx7abcd), or the full id a card falls back to when a session has none.
  const byId = ctx.db.normalizeId("conversations", ref);
  const conv = byId
    ? await ctx.db.get(byId)
    : await ctx.db.query("conversations").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
  const card = conv ? await sessionCardFor(ctx, userId, conv) : null;
  return card ?? { found: false };
}

export type AuthKind = "grant" | "cast_token";

const TOOLS: Record<string, (ctx: Ctx, userId: Id<"users">, args: any, auth: AuthKind) => Promise<unknown>> = {
  whoami: (ctx, userId, _args, auth) => whoami(ctx, userId, auth),
  list_docs: listDocs,
  read_doc: readDoc,
  list_tasks: listTasks,
  read_task: readTask,
  list_plans: listPlans,
  read_plan: readPlan,
  list_pages: listPages,
  list_sessions: listSessions,
  read_session: readSession,
};

/** Every tool but read_page, which needs storage and finishes in the action. */
export const run = internalQuery({
  args: { user_id: v.id("users"), tool: v.string(), args: v.any(), auth: v.union(v.literal("grant"), v.literal("cast_token")) },
  handler: async (ctx, args): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> => {
    const fn = TOOLS[args.tool];
    if (!fn) return { ok: false, error: `Unknown tool ${args.tool}` };
    try {
      return { ok: true, result: await fn(ctx, args.user_id, args.args ?? {}, args.auth) };
    } catch (e) {
      if (e instanceof ToolInputError) return { ok: false, error: e.message };
      throw e;
    }
  },
});
