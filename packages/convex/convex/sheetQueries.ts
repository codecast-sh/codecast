// Live query tabs: a sheet tab whose cells are a query over codecast data
// (tasks, sessions, pull requests or metric watches), refreshed on demand.
//
// The cells a refresh writes are readable by everyone who can read the sheet,
// so every source is scoped to the SHEET's workspace (its audience), never to
// what the person pressing refresh happens to be able to see.
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { parseWorkspaceKey, requireAccessibleDoc, resolveWorkspaceKey } from "./lib/access";
import { createDataContext } from "./data";
import { isConversationTeamVisible, teamVisibleConvTeam } from "./privacy";
import { assigneeNamesFor } from "./tasks";
import { applyBatchCore, readLiveElements } from "./liveArtifacts";
import { buildModel, queryTabOps, tabByName, type TabQuery } from "@codecast/shared/artifacts/sheets";
import { DEFAULT_TASK_STATUS_NAMES, TASK_STATUS_CATEGORIES, isTaskStatusCategory } from "@codecast/shared/tasks";

const THROTTLE_MS = 20_000;
const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;
/** Pull request rows carry file patches; a filtered scan stops after this many. */
const PR_SCAN_MAX = 500;
/** Rows read per task status range while looking for `limit` the sheet may show. */
const TASK_SCAN_MAX = 6000;
const OPEN_TASK_CATEGORIES = TASK_STATUS_CATEGORIES.filter((c) => c !== "done" && c !== "dropped");

type Scope = { key: string; userId: Id<"users">; teamId?: Id<"teams">; project: Doc<"projects"> | null };

/** A cell input as a person would type it: "=" text is quoted so it stays text. */
const cell = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return s.startsWith("=") ? `'${s}` : s;
};
const stamp = (ms: number | undefined) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");
const newestFirst = (a: any, b: any) => (b.updated_at ?? b._creationTime) - (a.updated_at ?? a._creationTime);
/**
 * A query picks the most recently updated rows, then shows them in creation
 * order: an update rewrites that row's cells in place, a new row appends at
 * the bottom, and formulas pointing into the tab keep their rows.
 */
const stableOrder = <T extends { _creationTime: number }>(rows: T[]): T[] => rows.sort((a, b) => a._creationTime - b._creationTime);

async function tasksGrid(ctx: any, scope: Scope, q: TabQuery, limit: number): Promise<string[][]> {
  const status = q.status?.trim().toLowerCase();
  if (status && status !== "all" && !isTaskStatusCategory(status)) {
    throw new ConvexError(`Unknown task status "${q.status}". Use one of ${TASK_STATUS_CATEGORIES.join(", ")} or all`);
  }
  const cats = status === "all" ? [...TASK_STATUS_CATEGORIES] : status ? [status] : OPEN_TASK_CATEGORIES;
  let rows: any[] = [];
  for (const cat of cats) {
    // The most recently updated tasks of each status, from an index ordered by
    // updated_at: the workspace's, or the project's (whose tasks can sit in
    // other workspaces, e.g. private inside a team). A row stays only when its
    // access key is the sheet's, so the scan runs past rows it drops until it
    // has `limit` of its own.
    const range = ctx.db.query("tasks")
      .withIndex(scope.project ? "by_project_status_updated" : "by_workspace_status", (x: any) =>
        scope.project ? x.eq("project_id", scope.project._id).eq("status", cat) : x.eq("workspace", scope.key).eq("status", cat))
      .order("desc");
    let kept = 0, scanned = 0;
    for await (const t of range) {
      if (++scanned > TASK_SCAN_MAX) break;
      // The tasks the task list shows: not mined suggestions awaiting triage, not ephemeral bookkeeping.
      if ((t.triage_status && t.triage_status !== "active") || t.ephemeral || (await resolveWorkspaceKey(ctx, t)) !== scope.key) continue;
      rows.push(t);
      if (++kept >= limit) break;
    }
  }
  rows = stableOrder(rows.sort(newestFirst).slice(0, limit));
  const names = await assigneeNamesFor(ctx, rows.map((t) => t.assignee));
  return [
    ["ID", "Title", "Status", "Priority", "Assignee", "Labels", "Updated"],
    ...rows.map((t) => [t.short_id, t.title, DEFAULT_TASK_STATUS_NAMES[t.status as keyof typeof DEFAULT_TASK_STATUS_NAMES] ?? t.status, t.priority, t.assignee ? names[t.assignee] || t.assignee : "", (t.labels ?? []).join(", "), stamp(t.updated_at)].map(cell)),
  ];
}

async function sessionsGrid(ctx: any, scope: Scope, limit: number): Promise<string[][]> {
  let convs: any[] = [];
  if (!scope.teamId) {
    // A personal sheet lists its owner's own sessions.
    const base = scope.project
      ? ctx.db.query("conversations").withIndex("by_project_id", (x: any) => x.eq("project_id", scope.project!._id)).order("desc").filter((x: any) => x.eq(x.field("user_id"), scope.userId))
      : ctx.db.query("conversations").withIndex("by_user_updated", (x: any) => x.eq("user_id", scope.userId)).order("desc");
    convs = await base.take(limit);
  } else {
    // A team sheet lists sessions shared with that team, read per member (the
    // only updated-ordered team index), each member's newest few.
    const teamId = scope.teamId;
    let candidates: any[];
    if (scope.project) {
      candidates = await ctx.db.query("conversations").withIndex("by_project_id", (x: any) => x.eq("project_id", scope.project!._id)).order("desc").take(Math.min(limit * 2, MAX_LIMIT));
    } else {
      const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (x: any) => x.eq("team_id", teamId)).take(200);
      const per = Math.min(limit, Math.max(20, Math.ceil((2 * limit) / Math.max(members.length, 1))));
      candidates = [];
      for (const m of members) {
        candidates.push(...await ctx.db.query("conversations")
          .withIndex("by_team_user_updated", (x: any) => x.eq("team_id", teamId).eq("user_id", m.user_id))
          .order("desc").take(per));
      }
    }
    // The rows land in cells everyone who reads the sheet sees, so the gate is
    // the TEAM's view of each session, never the refreshing person's own access
    // (an owner may see a session they keep hidden from the team).
    for (const c of candidates) {
      if (String(teamVisibleConvTeam(c) ?? "") !== String(teamId)) continue;
      if (await isConversationTeamVisible(ctx, c)) convs.push(c);
    }
  }
  convs = stableOrder(convs.filter((c) => !c.is_subagent).sort(newestFirst).slice(0, limit));
  return [
    ["ID", "Title", "Agent", "Status", "Messages", "Updated"],
    ...convs.map((c) => [c.short_id ?? c._id, c.short_title || c.title || "", c.agent_type, c.status, c.message_count ?? 0, stamp(c.updated_at)].map(cell)),
  ];
}

async function prsGrid(ctx: any, scope: Scope, q: TabQuery, limit: number): Promise<string[][]> {
  // Pull requests belong to a team and carry no workspace key; access is team membership.
  if (!scope.teamId) throw new ConvexError("Pull requests belong to a team. Move this sheet to a team to list them");
  // The project filter matches the repository: "owner/repo" exactly, or the repo name.
  const want = q.project?.trim().toLowerCase();
  const state = q.status?.trim().toLowerCase();
  const matches = (pr: any) =>
    (!want || pr.repository.toLowerCase() === want || pr.repository.toLowerCase().split("/").pop() === want) && (!state || pr.state === state);
  const prs: any[] = [];
  let scanned = 0;
  for await (const pr of ctx.db.query("pull_requests").withIndex("by_team_updated", (x: any) => x.eq("team_id", scope.teamId)).order("desc")) {
    if (matches(pr)) prs.push(pr);
    if (prs.length >= limit || (++scanned >= Math.max(limit, PR_SCAN_MAX) && (want || state))) break;
  }
  return [
    ["Number", "Title", "State", "Author", "Repo", "Updated"],
    ...stableOrder(prs).map((p) => [p.number, p.title, p.state, p.author_github_username, p.repository, stamp(p.updated_at)].map(cell)),
  ];
}

async function metricsGrid(ctx: any, scope: Scope, limit: number): Promise<string[][]> {
  // Metric watches carry their workspace key: one equality against the sheet's.
  const watches = (await ctx.db.query("metric_watches").withIndex("by_workspace", (x: any) => x.eq("workspace", scope.key)).take(MAX_LIMIT))
    .sort(newestFirst).slice(0, limit);
  stableOrder(watches);
  return [
    ["Name", "Value", "Unit", "Updated"],
    ...watches.map((w: any) => {
      const last = w.points[w.points.length - 1];
      return [w.name, last?.value ?? "", w.unit ?? "", stamp(last?.at ?? w.updated_at)].map(cell);
    }),
  ];
}

/** The project a query names, by title (case-insensitive) or short id, in the sheet's workspace. */
async function projectNamed(ctx: any, scope: Omit<Scope, "project">, name: string): Promise<Doc<"projects">> {
  const data = await createDataContext(ctx, scope.teamId ? { userId: scope.userId, workspace: "team", team_id: scope.teamId } : { userId: scope.userId, workspace: "personal" });
  const want = name.trim().toLowerCase();
  const projects: any[] = await data.query("projects").collect();
  const hit = projects.find((p) => p.title.toLowerCase() === want) ?? projects.find((p) => p.short_id?.toLowerCase() === want);
  if (!hit) throw new ConvexError(`No project named "${name}" in this sheet's workspace`);
  return hit;
}

export const refresh = mutation({
  args: { doc_id: v.id("docs"), tab: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = args.api_token ? ((await verifyApiToken(ctx, args.api_token))?.userId as Id<"users"> | undefined) : await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Not authenticated" });
    return refreshCore(ctx, userId, args.doc_id, args.tab);
  },
});

/** The CLI's refresh (an agent's `cast sheet query` or `refresh`): runs as the session's user, a tab named or by id. */
export const refreshAs = internalMutation({
  args: { user_id: v.id("users"), doc_id: v.id("docs"), tab: v.string() },
  handler: async (ctx, args) => {
    const doc = await requireAccessibleDoc(ctx, args.user_id, args.doc_id);
    const model = buildModel(await readLiveElements(ctx, doc._id, "main"));
    const tab = model.byId.has(args.tab) ? args.tab : tabByName(model, args.tab)?.id;
    if (!tab) throw new ConvexError(`No tab named ${args.tab}`);
    const r = await refreshCore(ctx, args.user_id, args.doc_id, tab, true);
    return { ...r, tabName: model.byId.get(tab)?.meta.name ?? tab };
  },
});

export const cliRefresh = internalAction({
  args: { user_id: v.id("users"), actor: v.string(), actor_name: v.string(), doc_id: v.optional(v.id("docs")), args: v.array(v.string()), stdin: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ text: string; json: unknown }> => {
    if (!args.doc_id || !args.args[0]) throw new ConvexError("usage: refresh <doc> <tab>");
    const r: any = await ctx.runMutation(internal.sheetQueries.refreshAs, { user_id: args.user_id, doc_id: args.doc_id, tab: args.args.join(" ") });
    const text = r.error ? `${r.tabName}: ${r.error}` : `${r.tabName}: ${r.rows} rows from the live query`;
    return { text, json: r };
  },
});

async function refreshCore(ctx: any, userId: Id<"users">, docId: Id<"docs">, tabId: string, force = false) {
  {
    const args = { doc_id: docId, tab: tabId };
    const doc = await requireAccessibleDoc(ctx, userId, args.doc_id);
    if (doc.doc_type !== "sheet") throw new ConvexError(`${doc.title} is a ${doc.doc_type}, not a sheet`);
    if (doc.archived_at) throw new ConvexError("This sheet is archived");

    const model = buildModel(await readLiveElements(ctx, doc._id, "main"));
    const meta = model.byId.get(args.tab)?.meta;
    if (!meta?.query) throw new ConvexError("This tab is not a live query");
    const now = Date.now();
    if (!force && meta.refreshedAt && now - meta.refreshedAt < THROTTLE_MS) return { skipped: true };

    const write = async (grid: string[][], error?: string) => {
      const ops = queryTabOps(model, args.tab, grid, now, error);
      const caller = { userId, actor: `u:${userId}`, name: "Live query", kind: "person" as const };
      return (await applyBatchCore(ctx, { doc, layer: "main", ops, caller, unbounded: true })).keys.length;
    };

    const q = meta.query;
    try {
      const key = doc.workspace || (await resolveWorkspaceKey(ctx, doc));
      const ws = parseWorkspaceKey(key);
      if (!ws) throw new ConvexError("This sheet has no workspace");
      // A personal sheet's cells would show its owner's data, so only the owner fills them.
      if (ws.type === "personal" && String(ws.userId) !== String(userId)) throw new ConvexError("Only the owner can refresh this private sheet");
      const base = { key, userId, teamId: ws.type === "team" ? ws.teamId : undefined };
      // The PR source reads the project as a repository name instead.
      const project = q.project && q.source !== "prs" && q.source !== "metrics" ? await projectNamed(ctx, base, q.project) : null;
      const scope: Scope = { ...base, project };
      const limit = Math.min(Math.max(1, Math.floor(q.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
      const grid =
        q.source === "tasks" ? await tasksGrid(ctx, scope, q, limit)
        : q.source === "sessions" ? await sessionsGrid(ctx, scope, limit)
        : q.source === "prs" ? await prsGrid(ctx, scope, q, limit)
        : q.source === "metrics" ? await metricsGrid(ctx, scope, limit)
        : null;
      if (!grid) throw new ConvexError(`Unknown source "${String(q.source)}"`);
      return { rows: grid.length - 1, changed: await write(grid) };
    } catch (e: any) {
      const message = typeof e?.data === "string" ? e.data : e?.data?.message ?? e?.message ?? "Query failed";
      return { rows: 0, changed: await write([], message), error: message };
    }
  }
}
