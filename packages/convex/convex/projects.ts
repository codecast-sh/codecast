import { cleanMetrics, metricArgValidator, requireSeries, type MetricArg } from "./lib/metricSeries";
import { v } from "convex/values";
import { charterPatch, projectCharterArgs } from "./lib/orgCharter";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./functions";
import { mintProjectShortId } from "./lib/projectShortId";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext, scopedFetch, explicitWorkspace } from "./data";
import { isTeamMember } from "./privacy";
import { projectCountsFor } from "./lib/projectTaskCounts";
import {
  canAccessProject,
  canAccessTask,
  requireTeamMembership,
} from "./lib/access";

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    project_path: v.optional(v.string()),
    target_date: v.optional(v.number()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });

    const id = await db.insert("projects", {
      short_id: await mintProjectShortId(ctx, Date.now()),
      title: args.title,
      description: args.description,
      status: "active",
      project_path: args.project_path,
      target_date: args.target_date,
      labels: args.labels,
    });

    return { id };
  },
});

export const list = query({
  args: {
    api_token: v.string(),
    status: v.optional(v.string()),
    // `cast project ls --team <name>|personal` narrows to one workspace.
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    // Own projects plus every project of a team the caller belongs to — the
    // web's workspace-"all" scope, so teammates share one project list. No
    // path scoping: projects are org units that span repos. A named
    // workspace narrows it.
    const named = explicitWorkspace(args, {});
    const { records } = await scopedFetch(ctx, "projects", {
      userId: auth.userId,
      ...(named.workspace ? { workspace: named.workspace, teamId: named.team_id } : { workspace: "all" }),
    });
    let projects = records;
    if (args.status) {
      projects = projects.filter((p: any) => p.status === args.status);
    }

    // Board counts from project_task_counts: reading the tasks themselves
    // timed out on projects with thousands of them.
    const counts = await projectCountsFor(ctx, auth.userId, projects.map((p) => p._id));
    return projects.map((p) => ({ ...p, task_counts: counts.get(String(p._id))! }));
  },
});

const PROJECT_TASK_LIMIT = 200;
const PROJECT_TASK_ORDER = ["in_progress", "in_review", "open", "backlog", "done", "dropped"] as const;

export const get = query({
  args: {
    api_token: v.string(),
    id: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const project = await ctx.db.get(args.id);
    if (!project) return null;
    if (!(await canAccessProject(ctx, auth.userId, project))) {
      return null;
    }

    // A project can hold thousands of tasks (a review files one per problem),
    // so the whole set overruns the 16 MiB read and return limits. Return a
    // bounded page, open work first, as the rows `cast project show` prints.
    const tasks: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (const status of PROJECT_TASK_ORDER) {
      const room = PROJECT_TASK_LIMIT - tasks.length;
      if (room <= 0) { truncated = true; break; }
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_project_status", (q) => q.eq("project_id", project._id).eq("status", status))
        .order("desc")
        .take(room + 1);
      if (rows.length > room) truncated = true;
      for (const task of rows.slice(0, room)) {
        if (!(await canAccessTask(ctx, auth.userId, task))) continue;
        const { _id, short_id, title, status, priority, external } = task;
        tasks.push({ _id, short_id, title, status, priority, external: external?.identifier ? { identifier: external.identifier } : undefined });
      }
    }

    return { ...project, tasks, tasks_truncated: truncated };
  },
});

/**
 * A project's numbers (the goal's InitiativeMetric shape, lib/metricSeries):
 * a list replaces the last, an empty one clears it, and each live series must
 * be a watch in the project's own workspace. A project has no reported
 * scoreboard: its numbers read from their series.
 */
async function projectMetricsPatch(ctx: { db: any }, project: { workspace?: string }, metrics: MetricArg[] | undefined) {
  if (metrics === undefined) return {};
  const cleaned = cleanMetrics(metrics);
  await requireSeries(ctx, project.workspace ?? "", cleaned);
  return { metrics: cleaned.length ? cleaned : undefined };
}

export const update = mutation({
  args: {
    api_token: v.string(),
    id: v.id("projects"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    // null clears the deadline; a Convex patch drops fields set to undefined.
    target_date: v.optional(v.union(v.number(), v.null())),
    labels: v.optional(v.array(v.string())),
    // Ongoing or bounded (org-staffing.md S10); "none" from the CLI clears it.
    horizon: v.optional(v.union(v.literal("ongoing"), v.literal("bounded"), v.null())),
    // The project's folder (org-staffing.md S35): where the work lives. It
    // names the team of a new session there and groups evidence for the
    // review; it holds no session, so changing it moves nothing. null clears.
    project_path: v.optional(v.union(v.string(), v.null())),
    // The charter (org-staffing.md S7); `--owner @handle` resolves inside the
    // project's own workspace. Access is the project's, unchanged.
    ...projectCharterArgs,
    metrics: v.optional(v.array(metricArgValidator)),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const project = await ctx.db.get(args.id);
    if (!project || !(await canAccessProject(ctx, auth.userId, project))) throw new Error("Project not found");

    const updates: any = { updated_at: Date.now(), ...(await charterPatch(ctx, project, args, "projects")), ...(await projectMetricsPatch(ctx, project, args.metrics)) };
    if (args.title) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.status) updates.status = args.status;
    if (args.target_date !== undefined) updates.target_date = args.target_date ?? undefined;
    if (args.labels) updates.labels = args.labels;
    if (args.horizon !== undefined) updates.horizon = args.horizon ?? undefined;
    if (args.project_path !== undefined) updates.project_path = args.project_path?.trim() || undefined;

    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});

// --- Web-facing queries ---

export const webList = query({
  args: {
    status: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    // Accepted but unused: the projects list is the project switcher, so it
    // must span the workspace. Clients that spread workspace args send
    // project_path; rejecting it crashes them.
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let projects;
    if (args.workspace === "team" && args.team_id) {
      // team_id is client-supplied — only a member may list a team's projects.
      if (!(await isTeamMember(ctx, userId, args.team_id))) return [];
      // team_id routes a row to the team; access is its workspace key. A
      // project kept private inside the team carries the team id too.
      const routed = await ctx.db
        .query("projects")
        .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id!))
        .collect();
      const access = await Promise.all(routed.map((p) => canAccessProject(ctx, userId, p)));
      projects = routed.filter((_, i) => access[i]);
      if (args.status) {
        projects = projects.filter(p => p.status === args.status);
      }
    } else if (args.workspace === "personal") {
      projects = await ctx.db
        .query("projects")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      projects = projects.filter(p => !p.team_id);
      if (args.status) {
        projects = projects.filter(p => p.status === args.status);
      }
    } else {
      if (args.status) {
        projects = await ctx.db
          .query("projects")
          .withIndex("by_user_status", (q) =>
            q.eq("user_id", userId).eq("status", args.status as any)
          )
          .collect();
      } else {
        projects = await ctx.db
          .query("projects")
          .withIndex("by_user_id", (q) => q.eq("user_id", userId))
          .collect();
      }
    }

    return projects;
  },
});

export const webGet = query({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const project = await ctx.db.get(args.id);
    if (!project) return null;
    // Owner, or a member of the project's team. (The old check only rejected
    // *teamless* others' projects, so any team-tagged project was world-readable.)
    if (!(await canAccessProject(ctx, userId, project))) return null;

    return project;
  },
});

export const webGetByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = [];
    for (const raw of args.ids.slice(0, 300)) {
      const id = ctx.db.normalizeId("projects", raw);
      if (!id) continue;
      const project = await ctx.db.get(id);
      if (!project) continue;
      if (!(await canAccessProject(ctx, userId, project))) continue;
      rows.push(project);
    }
    return rows;
  },
});

export const webCreate = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    target_date: v.optional(v.number()),
    labels: v.optional(v.array(v.string())),
    // Explicit workspace stamp from the client (same contract as tasks/docs
    // webCreate). The client-state fallback below is for legacy clients only —
    // it lags the client's local pointer across a team switch.
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
    // The web's stub key for this create, stored so the synced row supersedes the stub.
    client_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const now = Date.now();
    const short_id = await mintProjectShortId(ctx, now);

    let team_id: Id<"teams"> | undefined;
    if (args.workspace === "team") {
      if (!args.team_id) throw new Error("team_id is required for the team workspace");
      team_id = args.team_id;
    } else if (args.workspace !== "personal") {
      // Legacy client: infer from the server copy of the active-team pointer.
      const clientState = await ctx.db
        .query("client_state")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .first();
      team_id = clientState?.ui?.active_team_id;
    }
    if (team_id) await requireTeamMembership(ctx, userId, team_id);

    const doc: any = {
      user_id: userId,
      short_id,
      title: args.title,
      description: args.description,
      status: (args.status as any) || "active",
      color: args.color,
      icon: args.icon,
      target_date: args.target_date,
      labels: args.labels,
      created_at: now,
      updated_at: now,
    };
    if (team_id) doc.team_id = team_id;
    if (args.client_key) doc.client_key = args.client_key;

    const id = await ctx.db.insert("projects", doc);

    // Row rides back with the receipt: the client seeds its store before navigating.
    return { id, short_id, row: await ctx.db.get(id) };
  },
});

export const webUpdate = mutation({
  args: {
    id: v.id("projects"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    // null clears the deadline; a Convex patch drops fields set to undefined.
    target_date: v.optional(v.union(v.number(), v.null())),
    labels: v.optional(v.array(v.string())),
    horizon: v.optional(v.union(v.literal("ongoing"), v.literal("bounded"), v.null())),
    // The folder (S35): editable on the page; null clears it.
    project_path: v.optional(v.union(v.string(), v.null())),
    ...projectCharterArgs,
    metrics: v.optional(v.array(metricArgValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const project = await ctx.db.get(args.id);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error("Project not found");

    // The charter fields ride the same patch; `owner` is a ref, never stored.
    const { id, goal, success_metrics, priority, owner, non_goals, risks, budget, metrics, ...fields } = args;
    const updates: any = { updated_at: Date.now(), ...(await charterPatch(ctx, project, { goal, success_metrics, priority, owner, non_goals, risks, budget }, "projects")), ...(await projectMetricsPatch(ctx, project, metrics)) };
    for (const [k, val] of Object.entries(fields)) {
      if (val !== undefined) updates[k] = val === null ? undefined : val;
    }

    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});

/**
 * Gives every project that has no short id one (D17: `pj-…` is the address
 * every link takes). Projects made before every create path minted one carry
 * none, so their links fell back to the raw row id. Minted from the row's
 * creation time; one page per run, so a big table is walked a call at a time:
 * `packages/convex/run.sh projects:backfillShortIds '{}'` until `done`.
 */
export const backfillShortIds = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) },
  handler: async (ctx, { cursor, limit }) => {
    const page = await ctx.db.query("projects").paginate({ cursor: cursor ?? null, numItems: Math.min(limit ?? 200, 500) });
    let minted = 0;
    for (const p of page.page as any[]) {
      if (p.short_id) continue;
      await ctx.db.patch(p._id, { short_id: await mintProjectShortId(ctx, p.created_at ?? p._creationTime) });
      minted++;
    }
    return { minted, cursor: page.continueCursor, done: page.isDone };
  },
});
