// The line workspace's reads and writes (docs/architecture/line-workspace.md):
// what a station received when its run started it, and the labels people put
// on the decisions steps made (LW4). Every read is one equality against a
// workspace key, or a run the viewer may read.
import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext } from "./data";
import { canReadRun, withAgentSessions } from "./workflow_runs";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { pageConversationMessages } from "./conversations";
import { checkConversationAccess } from "./privacy";
import { canAccessProject, canAccessTask, resolveWorkspaceKey } from "./lib/access";
import { normalizeRepository, parseOwnerRepo, parsePrRef } from "@codecast/shared/contracts";
import { CARD_GATE_NODE_ID, isLineRun, passedUnansweredCard } from "@codecast/shared/contracts/changeCard";
import { causeHistory, closedAtStep, earlierFixes, historyBrief, runEnd, saidSlot, type AttemptOutcome, type OccurrenceRow } from "@codecast/shared/contracts/causeHistory";
import { guessPhase, halfOfPhase, phaseOfStation } from "@codecast/shared/contracts/linePhases";
import { verifyApiToken } from "./apiTokens";
import { labelFinding } from "./judgeReview";

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
    const brief = await stationBrief(ctx, conv._id);
    return {
      _id: String(conv._id),
      conversation_id: String(conv._id),
      text: brief.text.slice(0, STATION_INPUT_MAX_CHARS),
      truncated: brief.text.length > STATION_INPUT_MAX_CHARS,
      at: brief.at,
      found: brief.found,
    };
  },
});

/** The first message a station's session was given (the brief), whole; the caller has checked access. Try replays it (lineActions.ts). */
export async function stationBrief(ctx: any, conversationId: Id<"conversations">): Promise<{ text: string; at: number | null; found: boolean }> {
  const { messages } = await pageConversationMessages(ctx.db, conversationId, { order: "asc", limit: 12 });
  const first = messages.find((m: any) => m.role === "user" && !m.is_encrypted && typeof m.content === "string" && m.content.trim());
  return { text: first?.content ?? "", at: first?.timestamp ?? null, found: !!first };
}

/** A label as every reader gets it. */
const shapeLabel = (row: any) => ({
  _id: String(row._id),
  key: row.key,
  workspace: row.workspace,
  ...(row.team_id ? { team_id: String(row.team_id) } : {}),
  ...(row.project_id ? { project_id: String(row.project_id) } : {}),
  // The decision's subject: a run, or a judge's finding (a signal).
  run_id: String(row.run_id ?? row.signal_id),
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
    // A run's id, or a judge's finding's (signals): the finding is that judge step's decision.
    run_id: v.string(),
    node_id: v.string(),
    verdict: v.union(v.literal("right"), v.literal("wrong"), v.null()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const findingId = ctx.db.normalizeId("signals", args.run_id);
    if (findingId) {
      const step = args.node_id.trim();
      return await labelFinding(ctx, userId, findingId, step, lineLabelKey(String(findingId), step, String(userId)), args.verdict, args.note?.trim().slice(0, 4000) || undefined);
    }
    const runId = ctx.db.normalizeId("workflow_runs", args.run_id);
    const run = runId ? await ctx.db.get(runId) : null;
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
    return await projectDeploys(ctx, project, args.repositories ?? []);
  },
});

/** A project's recorded deploys over the history window, newest first: the deploys query and a cause's history read the same list. */
async function projectDeploys(ctx: any, project: any, repositories: ReadonlyArray<string>): Promise<Array<ReturnType<typeof shapeDeploy>>> {
  const since = Date.now() - HISTORY_WINDOW_MS;
  const projectId = String(project._id);
  const out = new Map<string, ReturnType<typeof shapeDeploy>>();

  if (project.team_id) {
    for (const repository of await projectRepositories(ctx, project, repositories)) {
      const events = await ctx.db
        .query("external_events")
        .withIndex("by_repository_created", (q: any) => q.eq("repository", repository).gte("created_at", since))
        .order("desc")
        .take(DEPLOY_SCAN);
      for (const e of events) {
        if (e.kind === "deploy" && String(e.team_id) === String(project.team_id)) out.set(String(e._id), shapeDeploy(e, projectId, "repository"));
      }
    }
  }

  const workspace = project.workspace ?? (await resolveWorkspaceKey(ctx, project));
  const sources = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace)).take(50);
  for (const source of sources) {
    if (source.project_id && String(source.project_id) !== projectId) continue;
    const events = await ctx.db
      .query("external_events")
      .withIndex("by_source_created", (q: any) => q.eq("source_id", source._id).gte("created_at", since))
      .order("desc")
      .take(DEPLOY_SCAN);
    for (const e of events) if (e.kind === "deploy") out.set(String(e._id), shapeDeploy(e, projectId, "source"));
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

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

// ── LW5: a cause remembers its attempts ──────────────────────────────────────

/** The newest runs on one cause its history reads, any graph. */
const HISTORY_RUNS_CAP = 30;
/** Station sessions resolved across those runs, for what each found, proposed and built. */
const HISTORY_SESSION_READS = 120;
/** The words one station's result keeps in the history. */
const SAID_MAX_CHARS = 600;
/** The brief a station is handed: the newest attempts fit, the oldest give way. */
const BRIEF_MAX_CHARS = 8000;

/** The fields a station's JSON report puts its finding, proposal or build in, in the order a reader wants them. */
const REPORT_FIELDS = ["statement", "strategy", "summary", "evidence", "why"] as const;

/** Words kept to a budget, one line, cut at the last sentence that fits. */
function clipWords(text: string, max = SAID_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1).trimEnd()}…`;
}

/** A station's result in its own words: its `cast state` result, its handoff note, or the line it printed, with a JSON report read by its field. */
export function stationSaid(node: { result_preview?: string; session?: { result?: string; handoff?: { note?: string } } | null }): string | null {
  const raw = (node.session?.result || node.session?.handoff?.note || node.result_preview || "").trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : raw.match(/```json\s*([\s\S]*?)```/)?.[1]?.trim();
  if (json) {
    try {
      const v = JSON.parse(json);
      const field = REPORT_FIELDS.map((k) => v?.[k]).find((x) => typeof x === "string" && x.trim());
      if (field) return clipWords(field);
    } catch {}
  }
  const prose = raw.replace(/```[\s\S]*?```/g, "").trim();
  return prose ? clipWords(prose) : null;
}

/** What a run's stations found, proposed and built, placed by the line's phases (shared/contracts/linePhases). */
export function runSaid(run: { node_statuses?: any[] }): { found: string | null; proposed: string | null; built: string | null } {
  const out = { found: null as string | null, proposed: null as string | null, built: null as string | null };
  const line = isLineRun(run.node_statuses);
  const nodes = [...(run.node_statuses ?? [])].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  for (const n of nodes) {
    if (n.status !== "completed" || !n.session_id) continue;
    const phase = line ? phaseOfStation(n.node_id) ?? guessPhase(n.node_id, n.label ?? "") : guessPhase(n.node_id, n.label ?? "", true);
    const slot = saidSlot(n.node_id, halfOfPhase(phase) === "diagnose" ? "diagnose" : phase === "build" ? "build" : null);
    const words = slot ? stationSaid(n) : null;
    if (slot && words) out[slot] = words;
  }
  return out;
}

/** A run's end in plain words; the web's run report says more, from the graph it draws. */
function runOutcomeWords(run: any): AttemptOutcome {
  const ended = runEnd(run);
  const end = ended?.kind ?? null;
  if (end === "shipped") return { end, text: "Shipped." };
  if (end === "dropped") return { end, text: "Dropped at the decision." };
  if (end === "dissolved") {
    const step = closedAtStep(ended!.node);
    return { end, text: step === "dissolve" ? "Closed without a change: the problem did not reproduce." : `Closed without a change at ${step.replace(/_/g, " ")}.` };
  }
  if (end === "parked") return { end, text: "Parked: the cause was not ready to build." };
  if (run.status === "running" || run.status === "paused" || run.status === "pending") return { end, text: "Still running." };
  const why = typeof run.fail_reason === "string" ? run.fail_reason.trim().replace(/\.$/, "") : "";
  if (run.status === "failed") return { end, text: why ? `Stopped: ${clipWords(why, 200)}.`.replace(/\.\.$/, ".") : "Stopped." };
  // A run that finished without an end of its own: its card went unanswered, or a step failed on the way out.
  if (passedUnansweredCard(run.node_statuses) || run.node_statuses?.some((n: any) => n.node_id === CARD_GATE_NODE_ID && n.outcome === "failure")) return { end, text: "Not shipped: its card was never answered." };
  const failed = [...(run.node_statuses ?? [])].reverse().find((n: any) => n.status === "failed");
  if (failed) return { end, text: `Finished without a change: ${String(failed.node_id).replace(/_/g, " ")} failed.` };
  return { end, text: "Finished without a change." };
}

/** A cause's own occurrences over the history window (the project-wide read in `occurrences`, for one cause). */
async function causeOccurrences(ctx: any, task: any): Promise<OccurrenceRow> {
  const since = Date.now() - HISTORY_WINDOW_MS;
  const rows = await ctx.db
    .query("signals")
    .withIndex("by_task", (q: any) => q.eq("task_id", task._id).gte("created_at", since))
    .order("desc")
    .take(OCCURRENCES_CAP);
  const observed: number[] = [];
  const reopened: number[] = [];
  const sources = new Set<string>();
  for (const s of rows) {
    const at = s.observed_at ?? s.created_at;
    observed.push(at);
    if (s.reopened) reopened.push(at);
    sources.add(s.source);
  }
  return {
    _id: String(task._id), task_id: String(task._id), project_id: String(task.project_id ?? ""),
    observed: observed.sort((a, b) => a - b), reopened: reopened.sort((a, b) => a - b), sources: [...sources].sort(),
    since, capped: rows.length >= OCCURRENCES_CAP,
  };
}

/**
 * Everything a cause has been through, read from codecast's own records (its
 * runs on any graph, their cards, its signals, the project's deploys) and told
 * by the shared derivation the web's timeline uses: the history, the brief a
 * station is handed, and the earlier shipped fixes a new card shows. The
 * caller has checked the viewer may read the task. `exceptRunId` leaves out
 * the run asking, so a run is never its own earlier attempt.
 */
export async function causeHistoryForTask(ctx: any, task: any, exceptRunId?: string) {
  const rows = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).order("desc").take(HISTORY_RUNS_CAP);
  const budget = { reads: HISTORY_SESSION_READS };
  const runs: any[] = [];
  for (const r of rows) runs.push(await withAgentSessions(ctx, r, budget));
  const decisions = (await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).order("desc").take(HISTORY_RUNS_CAP * 3))
    .filter((d: any) => d.workflow_run_id)
    .map((d: any) => shapeCard(d, String(task.project_id ?? "")));
  const project = task.project_id ? await ctx.db.get(task.project_id) : null;
  const named = runs.map((r) => parsePrRef(r.merge?.pr_url)?.repository).filter((x): x is string => !!x);
  const deploys = project ? await projectDeploys(ctx, project, named) : [];
  const saidById = new Map(runs.map((r) => [String(r._id), runSaid(r)]));
  const history = causeHistory({
    task,
    runs: runs.map((r) => ({ ...r, _id: String(r._id), updated_at: r.updated_at ?? r.created_at })),
    decisions,
    signals: [],
    occurrences: await causeOccurrences(ctx, task),
    deploys,
    said: (id) => saidById.get(id) ?? { found: null, proposed: null, built: null },
    outcome: runOutcomeWords,
    // The project's own watch, as the web's timeline reads it (useLineWorkspace), so the two agree on a held fix.
    watchDays: project?.line_profile?.watch_days ?? null,
    now: Date.now(),
  });
  return { history, brief: historyBrief(history, exceptRunId, BRIEF_MAX_CHARS), earlier: earlierFixes(history, exceptRunId) };
}

/**
 * `cast task history <ct>` and the runner's `$cause_history` (LW5): the
 * cause's earlier attempts as the next one is handed them. Null when the task
 * is not found or not the caller's to read.
 */
export const cliCauseHistory = query({
  args: { api_token: v.string(), short_id: v.string(), except_run_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", args.short_id)).first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) return null;
    const { history, brief, earlier } = await causeHistoryForTask(ctx, task, args.except_run_id);
    return { task: task.short_id, title: task.title, brief, earlier, regressed: history.regressed, attempts: history.attempts.length, history };
  },
});
