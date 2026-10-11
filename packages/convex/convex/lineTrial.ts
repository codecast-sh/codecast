// Trial projects (a project with `line_trial` set): the whole flow runs for
// real on the project's problems, and stops at the decision card.
//
// 1. A gate asks nobody. When a line run on a trial project's problem reaches
//    a gate, pauseAtGateCore hands it here instead of to the decision rail:
//    the run pauses as it would, and the gate becomes one trial_cards row with
//    everything the decision would have carried, the change card included. No
//    decision row exists, so no queue, inbox, digest, notice, stack or card
//    cap ever sees it.
// 2. It is answered on the trial review page. The answer rides the same path
//    a gate's answer takes when it has no decision (answerGateCore): the run
//    reads it and follows the chosen edge. An answer at an earlier gate (the
//    proposal) moves the run on to build; at the card, the trial graph's
//    edges only record what the person chose, so the run ends there.
// 3. Nothing merges. `cast line merge` asks orgLineMerge.check first, which
//    refuses a trial run whatever graph it runs.
// 4. What it costs: the team's model budget (judging, grouping, call nodes)
//    and the sessions of the project's line runs, priced from each station
//    session's token totals the way the Spend chart prices them.

import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { nextShortId } from "./counters";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf } from "./lib/ingestScope";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { canAccessProject } from "./lib/access";
import { getAuthenticatedUserId } from "./pendingMessages";
import { readBudget } from "./lib/teamBudget";
import { turnCost } from "./lib/usageDaily";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { CARD_GATE_NODE_ID, validateChangeCard, type ChangeCard } from "@codecast/shared/contracts/changeCard";

type Ctx = { db: any };

/** The trial project a task belongs to, or null when its project runs a real line. */
export async function trialProjectOf(ctx: Ctx, task: { project_id?: Id<"projects"> } | null | undefined): Promise<Doc<"projects"> | null> {
  const project = task?.project_id ? await ctx.db.get(task.project_id) : null;
  return project?.line_trial ? project : null;
}

const stripKey = (label: string) => label.replace(/^\[[^\]]*\]\s*/, "").trim() || label;

/**
 * A trial run's gate (pauseAtGateCore, after the run is paused and its task
 * moved to review): one trial card, asked of nobody. An earlier card of the
 * same run still waiting is closed, since the run has moved past it.
 */
export async function askTrialGate(
  ctx: Ctx,
  run: Doc<"workflow_runs">,
  task: Doc<"tasks">,
  project: Doc<"projects">,
  args: { node_id: string; prompt: string; choices: Array<{ key: string; label: string; description?: string }>; doc_md?: string; category?: string; card?: ChangeCard },
  now: number,
): Promise<{ ok: true; trial_card: string }> {
  const open: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect();
  for (const row of open) if (row.status === "waiting") await ctx.db.patch(row._id, { status: "closed", updated_at: now });
  const [first, ...rest] = args.prompt.split("\n");
  const card = args.card && validateChangeCard(args.card).ok ? args.card : undefined;
  const short_id = await nextShortId(ctx.db, "tc");
  await ctx.db.insert("trial_cards", {
    workspace: project.workspace ?? task.workspace,
    ...(project.team_id ? { team_id: project.team_id } : {}),
    project_id: project._id,
    task_id: task._id,
    run_id: run._id,
    short_id,
    node_id: args.node_id,
    kind: card || args.node_id === CARD_GATE_NODE_ID ? "card" : "gate",
    question: first.trim() || args.node_id,
    ...(rest.join("\n").trim() ? { context_md: rest.join("\n").trim() } : {}),
    ...(args.doc_md ? { doc_md: args.doc_md } : {}),
    ...(args.category ? { category: args.category } : {}),
    options: args.choices.map((c) => ({ key: c.key, label: stripKey(c.label), ...(c.description ? { description: c.description } : {}) })),
    ...(card ? { card } : {}),
    status: "waiting",
    created_at: now,
    updated_at: now,
  });
  return { ok: true, trial_card: short_id };
}

/** Whether a run belongs to a trial project: orgLineMerge.check refuses its merge. */
export async function isTrialRun(ctx: Ctx, run: { task_id?: Id<"tasks"> }): Promise<boolean> {
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  return !!(await trialProjectOf(ctx, task));
}

// ── Reads ──

/** A card as the review page and `cast line trial` read it: its state follows the run it pauses. */
async function cardView(ctx: Ctx, row: Doc<"trial_cards">) {
  const [task, run, project] = await Promise.all([ctx.db.get(row.task_id), ctx.db.get(row.run_id), ctx.db.get(row.project_id)]);
  // A waiting card whose run moved on or ended without an answer reads closed.
  const live = run && run.status === "paused" && run.gate_node_id === row.node_id;
  const status = row.status === "waiting" && !live ? "closed" : row.status;
  return {
    _id: row._id,
    workspace: row.workspace,
    short_id: row.short_id,
    project_id: row.project_id,
    project_title: project?.title ?? "",
    task_id: row.task_id,
    task_short_id: task?.short_id ?? "",
    task_title: task?.title ?? "",
    task_status: task?.status ?? "",
    run_id: row.run_id,
    run_status: run?.status ?? "gone",
    node_id: row.node_id,
    kind: row.kind,
    question: row.question,
    context_md: row.context_md,
    doc_md: row.doc_md,
    options: row.options,
    card: row.card,
    status,
    answer: row.answer ? { key: row.answer.key, label: row.answer.label, note: row.answer.note, at: row.answer.at, by: String(row.answer.by), stand_in: !!row.answer.stand_in } : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export type TrialCardView = Awaited<ReturnType<typeof cardView>>;

/** Every trial card in the workspace, newest first: the review page's list (web store key `trialCards`) and `cast line trial`. */
export const cards = query({
  args: { ...scopeArgs, project: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<TrialCardView[]> => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const limit = Math.min(Math.max(1, args.limit ?? 300), 500);
    const project = args.project ? await resolveWorkspaceProject(ctx, workspaceKey, args.project) : null;
    if (args.project && !project) throw new Error(`No project "${args.project}" in this workspace`);
    const rows: Doc<"trial_cards">[] = project
      ? await ctx.db.query("trial_cards").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).order("desc").take(limit)
      : await ctx.db.query("trial_cards").withIndex("by_workspace_created", (q: any) => q.eq("workspace", workspaceKey)).order("desc").take(limit);
    const out: TrialCardView[] = [];
    const allowed = new Map<string, boolean>();
    for (const row of rows) {
      if (row.workspace !== workspaceKey) continue;
      const key = String(row.project_id);
      if (!allowed.has(key)) {
        const p = await ctx.db.get(row.project_id);
        allowed.set(key, !!p && (await canAccessProject(ctx, userId, p)));
      }
      if (allowed.get(key)) out.push(await cardView(ctx, row));
    }
    return out;
  },
});

/**
 * What the trial has cost (the review page's header and `cast line trial`,
 * which the trial ledger reads): the team's model budget by purpose, this
 * month and the months since the trial began, and the line runs' sessions
 * priced from their token totals. A session on a model the price table does
 * not name (another backend's reviewer) counts its tokens, not a guess.
 */
export async function trialSpend(ctx: Ctx, project: Doc<"projects">, now = Date.now()) {
  const budget = await readBudget(ctx, project.workspace ?? "", now);
  const since = project.line_trial?.since ?? project.created_at;
  const sinceMonth = new Date(since).toISOString().slice(0, 7);
  const earlier = budget.history.filter((h: { month: string; spent_usd: number }) => h.month >= sinceMonth).reduce((s: number, h: { spent_usd: number }) => s + h.spent_usd, 0);
  const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
  let runs = 0;
  let sessions = 0;
  let sessionUsd = 0;
  let unpricedTokens = 0;
  const seen = new Set<string>();
  for (const task of tasks) {
    const taskRuns: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    for (const run of taskRuns) {
      if (run.created_at < since) continue;
      runs++;
      for (const node of run.node_statuses ?? []) {
        if (!node.session_id || seen.has(node.session_id)) continue;
        seen.add(node.session_id);
        const conv: any = await findConversationByAnyRef(ctx as any, node.session_id, run.user_id);
        const u = conv?.usage_totals;
        if (!u) continue;
        sessions++;
        const usage = { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cache_read, cache_creation_input_tokens: u.cache_write };
        const usd = turnCost(conv.model, usage);
        if (usd > 0) sessionUsd += usd;
        else unpricedTokens += u.input + u.output + u.cache_read + u.cache_write;
      }
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const modelUsd = budget.spent_usd + earlier;
  return {
    project_id: project._id,
    workspace: project.workspace,
    since,
    budget: { cap_usd: budget.cap_usd, month: budget.month, spent_usd: round(budget.spent_usd), held_usd: round(budget.held_usd), by_purpose: budget.by_purpose, refused: budget.refused, earlier_months_usd: round(earlier) },
    runs,
    sessions,
    session_usd: round(sessionUsd),
    unpriced_tokens: unpricedTokens,
    total_usd: round(modelUsd + sessionUsd),
    at: now,
  };
}

/** The trial's spend for one project (web store key `trialSpend`, keyed by project; `cast line trial`). */
export const spend = query({
  args: { ...scopeArgs, project: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    if (!project.line_trial) throw new Error(`${project.title} is not a trial project`);
    const s = await trialSpend(ctx, project);
    return { _id: project._id, ...s };
  },
});

/** The workspace's trial projects (the review page's filter; `cast line trial`). */
export const projects = query({
  args: { ...scopeArgs },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const rows: Doc<"projects">[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspaceKey)).collect();
    const out = [];
    for (const p of rows) if (p.line_trial && (await canAccessProject(ctx, userId, p))) out.push({ _id: p._id, workspace: p.workspace, title: p.title, short_id: (p as any).short_id, since: p.line_trial.since });
    return out;
  },
});

// ── Writes ──

/** `cast line trial on|off --project <ref>`: a team member makes a project a trial, or ends it. */
export const setTrial = mutation({
  args: { ...scopeArgs, project: v.string(), on: v.boolean() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    const now = Date.now();
    if (args.on && !project.line_trial) await ctx.db.patch(project._id, { line_trial: { since: now, by: userId }, updated_at: now });
    if (!args.on && project.line_trial) await ctx.db.patch(project._id, { line_trial: undefined, updated_at: now });
    return { project: project.title, project_id: project._id, trial: args.on, since: args.on ? (project.line_trial?.since ?? now) : null };
  },
});

/**
 * A person answers a trial card on the review page. The run reads the answer
 * as a gate's answer ("S" or "S: note") and follows that edge; the card keeps
 * what was chosen, by whom and when, whatever the run does next.
 */
export async function answerTrialCardCore(ctx: Ctx, userId: Id<"users">, ref: string, key: string, note: string | undefined, now = Date.now(), standIn = false) {
  const row: Doc<"trial_cards"> | null =
    (await ctx.db.query("trial_cards").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first()) ??
    (ctx.db.normalizeId("trial_cards", ref) ? await ctx.db.get(ctx.db.normalizeId("trial_cards", ref)) : null);
  const project = row ? await ctx.db.get(row.project_id) : null;
  if (!row || !project || !(await canAccessProject(ctx, userId, project))) throw new Error("Trial card not found");
  if (row.status !== "waiting") throw new Error(`${row.short_id} is already ${row.status}`);
  if (standIn && row.kind === "card") throw new Error(`${row.short_id} is the change card: only a person answers it, on the trial review page`);
  const option = row.options.find((o) => o.key.toUpperCase() === key.trim().toUpperCase());
  if (!option) throw new Error(`${row.short_id} has no option ${key}`);
  const run = await ctx.db.get(row.run_id);
  if (!run || run.status !== "paused" || run.gate_node_id !== row.node_id || run.gate_decision_id) {
    await ctx.db.patch(row._id, { status: "closed", updated_at: now });
    throw new Error(`${row.short_id}'s run is no longer waiting on it`);
  }
  const text = note?.trim().slice(0, 4000);
  await ctx.db.patch(run._id, { gate_response: text ? `${option.key}: ${text}` : option.key, status: "running", updated_at: now });
  await ctx.db.patch(row._id, { status: "answered", answer: { key: option.key, label: option.label, ...(text ? { note: text } : {}), by: userId, at: now, ...(standIn ? { stand_in: true } : {}) }, updated_at: now });
  return { short_id: row.short_id, answer: option.label };
}

/** The review page's answer (dispatched from the store's trialAnswer action). */
export const answer = mutation({
  args: { card: v.string(), key: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return answerTrialCardCore(ctx, userId, args.card, args.key, args.note);
  },
});

/**
 * `cast line trial answer <tc-N> <key> [note]`: from a person's terminal, any
 * card; from an agent session, only an earlier gate, recorded as a stand-in,
 * so a trial run can reach its change card without a person in the loop.
 */
export const answerForCli = mutation({
  args: { ...scopeArgs, card: v.string(), key: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    return answerTrialCardCore(ctx, userId, args.card, args.key, args.note, Date.now(), !!args.conversation_id);
  },
});
