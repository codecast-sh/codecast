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
import { createRunCore, queueRunOnDaemon } from "./workflow_runs";

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
  args: { ...scopeArgs, project: v.string(), on: v.boolean(), graph: v.optional(v.string()), cwd: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    const now = Date.now();
    if (args.on) {
      const was = project.line_trial;
      const line_trial = { since: was?.since ?? now, by: was?.by ?? userId, ...((args.graph ?? was?.graph) ? { graph: args.graph ?? was?.graph } : {}), ...((args.cwd ?? was?.cwd) ? { cwd: args.cwd ?? was?.cwd } : {}) };
      await ctx.db.patch(project._id, { line_trial, updated_at: now });
      return { project: project.title, project_id: project._id, trial: true, ...line_trial };
    }
    if (project.line_trial) await ctx.db.patch(project._id, { line_trial: undefined, updated_at: now });
    return { project: project.title, project_id: project._id, trial: false };
  },
});

/** Trial runs at once, at most: the machine running them is shared. */
export const TRIAL_RUNNING_CAP = 3;

/** How many of a trial project's runs hold a machine now (a paused run waits on a card and holds none). */
async function runningIn(ctx: Ctx, project: Doc<"projects">): Promise<number> {
  let running = 0;
  const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
  for (const t of tasks) {
    if (!t.workflow_run_id) continue;
    const run = await ctx.db.get(t.workflow_run_id);
    if (run?.status === "running" || run?.status === "pending") running++;
  }
  return running;
}

/**
 * `cast line trial run <ct-N>`: the problem's trial project, the graph and
 * checkout it starts from, and how many trial runs are running now (paused
 * runs wait on a card and hold no machine).
 */
export const runTarget = query({
  args: { ...scopeArgs, task: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", args.task.trim())).first();
    const project = await trialProjectOf(ctx, task);
    if (!task || !project || !(await canAccessProject(ctx, userId, project))) throw new Error(`${args.task} is not a problem in a trial project`);
    const current = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
    const live = current && (current.status === "running" || current.status === "paused") ? current._id : null;
    const running = await runningIn(ctx, project);
    return { task: task.short_id, title: task.title, status: task.status, live_run: live, project: project.title, graph: project.line_trial?.graph ?? null, cwd: project.line_trial?.cwd ?? null, running, cap: TRIAL_RUNNING_CAP };
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

// ── Runs ──

/** A trial problem's latest run as the review page reads it, keyed by the problem. */
function runRow(workspace: string, project: Doc<"projects">, task: Doc<"tasks">, run: Doc<"workflow_runs">) {
  return {
    _id: task._id,
    workspace,
    project_id: project._id,
    task_short_id: task.short_id,
    task_title: task.title,
    task_status: task.status,
    run_id: run._id,
    status: run.status,
    node_id: run.current_node_id ?? null,
    fail_reason: run.status === "failed" ? run.fail_reason ?? null : null,
    fresh_branch: !!run.fresh_branch,
    created_at: run.created_at,
    updated_at: run.updated_at ?? run.created_at,
  };
}

export type TrialRunView = ReturnType<typeof runRow>;

/**
 * Each trial problem's latest run (web store key `trialRuns`, keyed by the
 * problem): the review page shows a failed run as a row of its own, with the
 * station it stopped at and why, and offers the rerun.
 */
export const runs = query({
  args: { ...scopeArgs },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const projects: Doc<"projects">[] = (await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspaceKey)).collect())
      .filter((p: Doc<"projects">) => !!p.line_trial);
    const out: TrialRunView[] = [];
    for (const project of projects) {
      if (!(await canAccessProject(ctx, userId, project))) continue;
      const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
      for (const task of tasks) {
        const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
        if (!run) continue;
        out.push(runRow(workspaceKey, project, task, run));
      }
    }
    return out.sort((a, b) => b.updated_at - a.updated_at);
  },
});


/**
 * A failed trial run, run again from the review page (dispatched from the
 * store's trialRerun action): the same graph on the same machine, queued to
 * its daemon, which sets the earlier run's branch aside and starts from
 * origin/main (cli lineTrialBranch.ts), so the proof runs against unfixed code.
 */
export const rerun = mutation({
  args: { task: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const id = ctx.db.normalizeId("tasks", args.task);
    const task: Doc<"tasks"> | null = id ? await ctx.db.get(id) : await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", args.task)).first();
    const project = await trialProjectOf(ctx, task);
    if (!task || !project || !(await canAccessProject(ctx, userId, project))) throw new Error(`${args.task} is not a problem in a trial project`);
    const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
    if (!run || run.status !== "failed") throw new Error(`${task.short_id}'s run ${run ? `is ${run.status}` : "does not exist"}; only a failed run is rerun here`);
    if (!run.runner_device) throw new Error(`${task.short_id}'s run names no machine: start it with cast line trial run ${task.short_id}`);
    const running = await runningIn(ctx, project);
    if (running >= TRIAL_RUNNING_CAP) throw new Error(`${running} trial runs are running; the cap is ${TRIAL_RUNNING_CAP}`);
    const now = Date.now();
    const { run_id } = await createRunCore(ctx as any, userId, {
      workflow_name: run.workflow_name ?? "workflow",
      ...(run.workflow_id ? { workflow_id: run.workflow_id } : {}),
      task,
      ...(run.goal_override ? { goal_override: run.goal_override } : {}),
      ...(run.project_path ? { project_path: run.project_path } : {}),
      ...(run.spawner_conversation_id ? { spawner_conversation_id: run.spawner_conversation_id } : {}),
      now,
    });
    await ctx.db.patch(run_id, { fresh_branch: true });
    await queueRunOnDaemon(ctx as any, userId, run_id, { device: run.runner_device, now });
    return { task: task.short_id, run_id };
  },
});

/**
 * `cast line trial recard <tc-N> --file card.json`: a waiting change card
 * rebuilt in place (`cast card build` on the run's worktree, after its words or
 * its run's own Verify changed). The run still waits on the same gate, so the
 * answer rides the same keys; options are replaced only when given, keyed the
 * same as the ones they replace.
 */
export const recardForCli = mutation({
  args: { ...scopeArgs, card: v.string(), change_card: v.any(), options: v.optional(v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) }))) },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    const row: Doc<"trial_cards"> | null = await ctx.db.query("trial_cards").withIndex("by_short_id", (q: any) => q.eq("short_id", args.card)).first();
    const project = row ? await ctx.db.get(row.project_id) : null;
    if (!row || !project || !(await canAccessProject(ctx, userId, project))) throw new Error("Trial card not found");
    if (row.kind !== "card" || row.status !== "waiting") throw new Error(`${row.short_id} is not a waiting change card`);
    const checked = validateChangeCard(args.change_card);
    if (!checked.ok) throw new Error(`The card is not ready:\n  ${checked.errors.join("\n  ")}`);
    if (checked.card.cause.task !== (await ctx.db.get(row.task_id))?.short_id) throw new Error(`The card is for ${checked.card.cause.task}, not ${row.short_id}'s problem`);
    let options = row.options;
    if (args.options) {
      const keys = (o: Array<{ key: string }>) => o.map((x) => x.key.toUpperCase()).sort().join();
      if (keys(args.options) !== keys(row.options)) throw new Error(`Options must keep the keys ${keys(row.options)}`);
      options = args.options.map((o) => ({ key: o.key, label: stripKey(o.label), ...(o.description ? { description: o.description } : {}) }));
    }
    await ctx.db.patch(row._id, { card: checked.card, options, question: `Ship this change? ${checked.card.headline ?? ""}`.trim(), updated_at: Date.now() });
    return { short_id: row.short_id, headline: checked.card.headline ?? "", checks: checked.card.checks.map((c) => `${c.name} ${c.ok ? "ok" : "red"}`) };
  },
});
