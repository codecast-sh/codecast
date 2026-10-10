// The line workspace's reads and writes (docs/architecture/line-workspace.md):
// what a station received when its run started it, and the labels people put
// on the decisions steps made (LW4). Every read is one equality against a
// workspace key, or a run the viewer may read.
import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext } from "./data";
import { canReadRun } from "./workflow_runs";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { pageConversationMessages } from "./conversations";
import { checkConversationAccess } from "./privacy";
import { canAccessProject, canAccessTask, resolveWorkspaceKey } from "./lib/access";
import { normalizeRepository, parseOwnerRepo } from "@codecast/shared/contracts";

/** How much of a station's brief the workspace shows; the session holds the rest. */
export const STATION_INPUT_MAX_CHARS = 40_000;
/** The labels a workspace feed carries, newest first. */
const LABELS_CAP = 2000;

/** One label's identity: one verdict per person per decision. */
export const lineLabelKey = (runId: string, nodeId: string, userId: string) => `${runId}:${nodeId}:${userId}`;

/** Whether `conversationId` is the session a run started for one of its stations. */
async function isStationOfRun(ctx: any, run: any, conversationId: string): Promise<boolean> {
  for (const n of run.node_statuses ?? []) {
    if (!n.session_id) continue;
    const conv: any = await findConversationByAnyRef(ctx, n.session_id, run.user_id);
    if (conv && String(conv._id) === conversationId) return true;
  }
  return false;
}

/**
 * What a station received: the first message its session was given (the
 * brief the runner wrote from the step's prompt and the run's inputs). A
 * viewer who can read the session reads it; so does one who can read the run
 * that started it, since a teammate's station sessions are the run's record.
 * `_id` is the conversation id, so the answer lands in the store keyed by it.
 */
export const stationInput = query({
  args: { conversation_id: v.id("conversations"), run_id: v.optional(v.id("workflow_runs")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    let allowed = (await checkConversationAccess(ctx, userId, conv as any)) !== "denied";
    if (!allowed && args.run_id) {
      const run = await ctx.db.get(args.run_id);
      allowed = !!run && (await canReadRun(ctx, userId, run)) && (await isStationOfRun(ctx, run, String(conv._id)));
    }
    if (!allowed) return null;
    const { messages } = await pageConversationMessages(ctx.db, conv._id, { order: "asc", limit: 12 });
    const first = messages.find((m: any) => m.role === "user" && !m.is_encrypted && typeof m.content === "string" && m.content.trim());
    const text: string = first?.content ?? "";
    return {
      _id: String(conv._id),
      conversation_id: String(conv._id),
      text: text.slice(0, STATION_INPUT_MAX_CHARS),
      truncated: text.length > STATION_INPUT_MAX_CHARS,
      at: first?.timestamp ?? null,
      found: !!first,
    };
  },
});

/** A label as every reader gets it. */
const shapeLabel = (row: any) => ({
  _id: String(row._id),
  key: row.key,
  workspace: row.workspace,
  ...(row.team_id ? { team_id: String(row.team_id) } : {}),
  ...(row.project_id ? { project_id: String(row.project_id) } : {}),
  run_id: String(row.run_id),
  node_id: row.node_id,
  verdict: row.verdict,
  ...(row.note ? { note: row.note } : {}),
  by: String(row.by),
  at: row.at,
});

/** A workspace's labels, newest first: the active one, or the team named. */
export const labels = query({
  args: { team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const { workspaceKey } = await createDataContext(ctx, args.team_id
      ? { userId, workspace: "team", team_id: args.team_id }
      : { userId, workspace: "personal" });
    const rows = await ctx.db
      .query("line_labels")
      .withIndex("by_workspace_at", (q) => q.eq("workspace", workspaceKey))
      .order("desc")
      .take(LABELS_CAP);
    return rows.map(shapeLabel);
  },
});

/**
 * Mark the decision a step made in a run right or wrong, with a note; a null
 * verdict takes the viewer's label back. The label lives where the run lives
 * (the run's workspace key and team), so it is explicit without the caller
 * naming a workspace: the run already does.
 */
export const label = mutation({
  args: {
    run_id: v.id("workflow_runs"),
    node_id: v.string(),
    verdict: v.union(v.literal("right"), v.literal("wrong"), v.null()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const run = await ctx.db.get(args.run_id);
    if (!run || !(await canReadRun(ctx, userId, run))) throw new Error("Not found");
    const node = args.node_id.trim();
    if (!node || !(run.node_statuses ?? []).some((n: any) => n.node_id === node)) throw new Error("No such step in this run");
    const key = lineLabelKey(String(run._id), node, String(userId));
    const had = await ctx.db.query("line_labels").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (args.verdict === null) {
      if (had) await ctx.db.delete(had._id);
      return null;
    }
    const note = args.note?.trim().slice(0, 4000) || undefined;
    const now = Date.now();
    if (had) {
      await ctx.db.patch(had._id, { verdict: args.verdict, note, at: now });
      return String(had._id);
    }
    const task: any = run.task_id ? await ctx.db.get(run.task_id) : null;
    const id = await ctx.db.insert("line_labels", {
      key,
      workspace: await resolveWorkspaceKey(ctx, run),
      ...(run.team_id ? { team_id: run.team_id as Id<"teams"> } : {}),
      ...(task?.project_id ? { project_id: task.project_id } : {}),
      run_id: run._id,
      node_id: node,
      verdict: args.verdict,
      ...(note ? { note } : {}),
      by: userId,
      at: now,
    });
    return String(id);
  },
});

// ── a cause's history (line-workspace.md LW1 Timeline, LW5) ─────────────────

/** How far back the timeline reads occurrences and deploys. */
export const HISTORY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
/** The newest occurrences one project's history reads; signals carry bodies, so the read stays well under a function's limit. */
const OCCURRENCES_CAP = 1500;
/** Deploy markers scanned per repository or source: a repository's events are mostly commits and pull requests. */
const DEPLOY_SCAN = 400;

/** The project, when the viewer may read it. */
async function readableProject(ctx: any, projectId: Id<"projects">): Promise<any | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const project = await ctx.db.get(projectId);
  if (!project || !(await canAccessProject(ctx, userId, project))) return null;
  return project;
}

/**
 * Every cause's occurrences in a project over the history window: one row per
 * cause, the times its signals were observed, and which of them reopened it.
 * The `signals` feed holds two weeks with their words; this is the longer
 * series a timeline buckets, and nothing else.
 */
export const occurrences = query({
  args: { project_id: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await readableProject(ctx, args.project_id);
    if (!project) return [];
    const since = Date.now() - HISTORY_WINDOW_MS;
    const rows = await ctx.db
      .query("signals")
      .withIndex("by_project_created", (q) => q.eq("project_id", args.project_id).gte("created_at", since))
      .order("desc")
      .take(OCCURRENCES_CAP);
    const byTask = new Map<string, { observed: number[]; reopened: number[]; sources: Set<string> }>();
    for (const s of rows) {
      if (!s.task_id) continue;
      const key = String(s.task_id);
      const row = byTask.get(key) ?? { observed: [], reopened: [], sources: new Set<string>() };
      const at = s.observed_at ?? s.created_at;
      row.observed.push(at);
      if (s.reopened) row.reopened.push(at);
      row.sources.add(s.source);
      byTask.set(key, row);
    }
    const capped = rows.length >= OCCURRENCES_CAP;
    return [...byTask].map(([taskId, row]) => ({
      _id: taskId,
      task_id: taskId,
      project_id: String(args.project_id),
      observed: row.observed.sort((a, b) => a - b),
      reopened: row.reopened.sort((a, b) => a - b),
      sources: [...row.sources].sort(),
      since,
      // The read stopped at its cap: older occurrences exist past the first one shown.
      capped,
    }));
  },
});

/** The repositories a project's code lives in: its team's published checkouts at the project's path, and any the caller read off the project's merges. */
async function projectRepositories(ctx: any, project: any, named: ReadonlyArray<string>): Promise<string[]> {
  const out = new Set<string>();
  for (const r of named) {
    const repo = parseOwnerRepo(r);
    if (repo) out.add(repo);
  }
  const path: string | undefined = project.project_path;
  if (path && project.team_id) {
    const sources = await ctx.db.query("repo_sources").withIndex("by_team_id", (q: any) => q.eq("team_id", project.team_id)).take(200);
    for (const s of sources) {
      if (s.root === path || path.startsWith(`${s.root}/`)) out.add(normalizeRepository(s.repository));
    }
  }
  return [...out].slice(0, 8);
}

/** A deploy marker as the timeline reads it. */
const shapeDeploy = (e: any, projectId: string, via: "repository" | "source") => ({
  _id: String(e._id),
  project_id: projectId,
  at: e.created_at,
  sha: e.sha ?? null,
  repository: e.repository ?? null,
  // A codecast marker names a surface (cast ship mark); a source's deploy names an environment.
  surface: e.meta?.surface ?? null,
  environment: e.data?.environment ?? null,
  version: e.meta?.version ?? e.data?.release ?? null,
  source: e.data?.source_name ?? e.source,
  via,
  title: e.title,
  url: e.url ?? null,
});

/**
 * The deploys codecast knows of for a project: `cast ship mark` markers on
 * the project's repositories (packages/convex/deploy.sh posts one per backend
 * deploy), and the deploys its workspace's sources report (an SDK's release,
 * Union's backend). A deploy nobody records is not here, and the timeline
 * says so rather than guess.
 */
export const deploys = query({
  args: { project_id: v.id("projects"), repositories: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const project = await readableProject(ctx, args.project_id);
    if (!project) return [];
    const since = Date.now() - HISTORY_WINDOW_MS;
    const projectId = String(project._id);
    const out = new Map<string, ReturnType<typeof shapeDeploy>>();

    if (project.team_id) {
      for (const repository of await projectRepositories(ctx, project, args.repositories ?? [])) {
        const events = await ctx.db
          .query("external_events")
          .withIndex("by_repository_created", (q) => q.eq("repository", repository).gte("created_at", since))
          .order("desc")
          .take(DEPLOY_SCAN);
        for (const e of events) {
          if (e.kind === "deploy" && String(e.team_id) === String(project.team_id)) out.set(String(e._id), shapeDeploy(e, projectId, "repository"));
        }
      }
    }

    const workspace = project.workspace ?? (await resolveWorkspaceKey(ctx, project));
    const sources = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", workspace)).take(50);
    for (const source of sources) {
      if (source.project_id && String(source.project_id) !== projectId) continue;
      const events = await ctx.db
        .query("external_events")
        .withIndex("by_source_created", (q) => q.eq("source_id", source._id).gte("created_at", since))
        .order("desc")
        .take(DEPLOY_SCAN);
      for (const e of events) if (e.kind === "deploy") out.set(String(e._id), shapeDeploy(e, projectId, "source"));
    }
    return [...out.values()].sort((a, b) => b.at - a.at);
  },
});

/** Causes and cards per cause one project's card read covers. */
const CARDS_CAUSES_CAP = 400;
const CARDS_PER_CAUSE = 20;

/** A line card as the history reads it: the answer and the card's own words, never its examples or proof. */
const shapeCard = (d: any, projectId: string) => {
  const c = d.card && typeof d.card === "object" ? d.card : null;
  const diff = c?.diff && typeof c.diff.files === "number" ? { files: c.diff.files, added: c.diff.added ?? 0, removed: c.diff.removed ?? 0, ...(c.diff.pr ? { pr: c.diff.pr } : {}) } : undefined;
  return {
    _id: String(d._id),
    project_id: projectId,
    task_id: String(d.task_id),
    workflow_run_id: String(d.workflow_run_id),
    ...(d.short_id ? { short_id: d.short_id } : {}),
    status: d.status,
    ...(d.gate_node_id ? { gate_node_id: d.gate_node_id } : {}),
    options: (d.options ?? []).map((o: any) => ({ label: o.label })),
    ...(typeof d.answer_index === "number" ? { answer_index: d.answer_index } : {}),
    ...(d.answer_text ? { answer_text: String(d.answer_text).slice(0, 2000) } : {}),
    ...(d.resolved_at ? { resolved_at: d.resolved_at } : {}),
    created_at: d.created_at,
    ...(c ? {
      card: {
        ...(c.headline ? { headline: c.headline } : {}),
        ...(c.change ? { change: c.change } : {}),
        ...(c.wrong ? { wrong: c.wrong } : {}),
        ...(c.recommend ? { recommend: { verdict: c.recommend.verdict, ...(c.recommend.why ? { why: c.recommend.why } : {}) } } : {}),
        ...(diff ? { diff } : {}),
      },
    } : {}),
  };
};

/**
 * Every line card on a project's causes, answered or not, whoever answered
 * it: what each attempt proposed and how the person answered (LW5). The
 * viewer's own queue (sessionDecisions) stays a card's live home; this fills
 * in the cards it does not hold.
 */
export const cards = query({
  args: { project_id: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const project = await readableProject(ctx, args.project_id);
    if (!userId || !project) return [];
    const projectId = String(project._id);
    const tasks = await ctx.db.query("tasks").withIndex("by_project_id", (q) => q.eq("project_id", args.project_id)).order("desc").take(CARDS_CAUSES_CAP);
    const out: ReturnType<typeof shapeCard>[] = [];
    for (const task of tasks) {
      if (!task.cause || !(await canAccessTask(ctx, userId, task))) continue;
      const rows = await ctx.db.query("session_decisions").withIndex("by_task", (q) => q.eq("task_id", task._id)).order("desc").take(CARDS_PER_CAUSE);
      for (const d of rows) if (d.workflow_run_id) out.push(shapeCard(d, projectId));
    }
    return out;
  },
});
