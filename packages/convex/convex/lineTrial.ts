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
import { internalMutation, mutation, query } from "./functions";
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
import { BASE_CHECK, CARD_GATE_NODE_ID, validateChangeCard, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { findingConversation } from "@codecast/shared/contracts/judges";
import { validateProposalCard, type ProposalCard } from "@codecast/shared/contracts/proposalCard";
import { validateJudgeFixCard, type JudgeFixCard } from "@codecast/shared/contracts/judgeFix";
import { isJudgeProblem } from "@codecast/shared/contracts/judgeReview";
import { createRunCore, isLiveRunStatus, queueRunOnDaemon } from "./workflow_runs";
import { parseMoveTally } from "./lib/moveTally";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";

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
  args: { node_id: string; prompt: string; choices: Array<{ key: string; label: string; description?: string }>; doc_md?: string; category?: string; card?: ChangeCard; proposal?: unknown; judge_fix?: unknown },
  now: number,
): Promise<{ ok: true; trial_card: string }> {
  const open: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect();
  for (const row of open) if (row.status === "waiting") await ctx.db.patch(row._id, { status: "closed", updated_at: now });
  const [first, ...rest] = args.prompt.split("\n");
  const card = args.card && validateChangeCard(args.card).ok ? args.card : undefined;
  const proposal = args.proposal && validateProposalCard(args.proposal).ok ? args.proposal : undefined;
  const fix = args.judge_fix ? validateJudgeFixCard(args.judge_fix) : null;
  const judge_fix = fix?.ok ? fix.card : undefined;
  const short_id = await nextShortId(ctx.db, "tc");
  await ctx.db.insert("trial_cards", {
    workspace: project.workspace ?? task.workspace,
    ...(project.team_id ? { team_id: project.team_id } : {}),
    project_id: project._id,
    task_id: task._id,
    run_id: run._id,
    short_id,
    node_id: args.node_id,
    // The judge route's card is its run's last stop, answered by a person like a change card.
    kind: card || judge_fix || args.node_id === CARD_GATE_NODE_ID ? "card" : "gate",
    question: first.trim() || args.node_id,
    ...(rest.join("\n").trim() ? { context_md: rest.join("\n").trim() } : {}),
    ...(args.doc_md ? { doc_md: args.doc_md } : {}),
    ...(args.category ? { category: args.category } : {}),
    options: args.choices.map((c) => ({ key: c.key, label: stripKey(c.label), ...(c.description ? { description: c.description } : {}) })),
    ...(card ? { card } : {}),
    ...(proposal ? { proposal } : {}),
    ...(judge_fix ? { judge_fix } : {}),
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

/** How a finding left its problem: judged again and not found, the same message as a finding kept elsewhere, found wrong by a fix run's proof, or moved. */
export type FindingFate = "rejudged" | "duplicate" | "found_wrong" | "moved" | "other";

/** A finding that left an emptied problem, and where it went: `to` names an open problem that holds it now. */
export type WithdrawnFinding = { short_id: string; title: string; quote?: string; at: number; fate: FindingFate; to?: string };

export type ProblemEvidence = { findings: number; conversations: number; withdrawn: number; moved_to: string[]; gone?: WithdrawnFinding[] };

const GONE_SHOWN = 20;
const quoteOf = (detail?: string) => (detail ?? "").split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2)).join(" ").trim() || undefined;

/** The fate a retire reason records (judgeRetire, findingKeyMerge, judgeReview), and the keeper a duplicate names. */
function fateOf(reason: string): { fate: FindingFate; keeper?: string } {
  const dup = /^the same message as (sg-\d+)/.exec(reason);
  if (dup) return { fate: "duplicate", keeper: dup[1] };
  if (/^judged again\b/.test(reason)) return { fate: "rejudged" };
  if (/^found wrong\b/.test(reason)) return { fate: "found_wrong" };
  return { fate: "other" };
}

/**
 * What stands behind a problem now, read live (a card's own count is frozen
 * when it is built): its findings and the conversations they come from.
 *
 * With none left, each finding that left says how it went, read from its own
 * record, never from what else was filed about the same contact: a re-judged
 * finding moved only when the same key (subject, expectation and message) is
 * live on another problem; a duplicate went to its keeper's problem; and
 * findings a person moved off after `since` (the card's build) went where the
 * problem's move note says. Only open problems count as where it went: one
 * that was dropped or closed holds nothing left to fix.
 */
export async function problemEvidence(ctx: Ctx, task: Doc<"tasks">, since?: number): Promise<ProblemEvidence> {
  const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  if (live.length) return { findings: live.length, conversations: new Set(live.map((s) => findingConversation({ ...s, _id: String(s._id) }))).size, withdrawn: 0, moved_to: [] };
  const tasks = new Map<string, Doc<"tasks"> | null>();
  const taskById = async (id: Id<"tasks">) => {
    if (!tasks.has(String(id))) tasks.set(String(id), await ctx.db.get(id));
    return tasks.get(String(id)) ?? null;
  };
  /** The open problem a finding sits on now, other than this one. */
  const openHome = async (s: Doc<"signals"> | null | undefined): Promise<string | undefined> => {
    if (!s?.task_id || s.task_id === task._id) return undefined;
    const t = await taskById(s.task_id);
    return t && !isTerminalTaskStatus(t.status) ? t.short_id : undefined;
  };
  const retired: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_retired_task", (q: any) => q.eq("retired.task_id", task._id)).take(100);
  const gone: WithdrawnFinding[] = [];
  for (const s of retired.sort((a, b) => (b.retired?.at ?? 0) - (a.retired?.at ?? 0))) {
    const { fate, keeper } = fateOf(s.retired?.reason ?? "");
    let to: string | undefined;
    if (keeper) {
      const k: Doc<"signals"> | null = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", keeper)).first();
      to = await openHome(k);
    } else if (fate === "rejudged") {
      // Found again under the very same key from another moment: the finding lives on there.
      const same: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", task.workspace).eq("fingerprint", s.fingerprint)).take(10);
      for (const o of same) if (!o.retired && (to = await openHome(o))) break;
    }
    gone.push({ short_id: s.short_id, title: s.title, quote: quoteOf(s.detail_md), at: s.retired?.at ?? s.created_at, fate: to ? "moved" : fate, ...(to ? { to } : {}) });
  }
  // Moves a person made off this problem after the card was built: the move note names where they went.
  const moved = new Set(gone.flatMap((g) => (g.to ? [g.to] : [])));
  const notes: Doc<"task_comments">[] = await ctx.db.query("task_comments")
    .withIndex("by_task_created", (q: any) => q.eq("task_id", task._id).gte("created_at", since ?? 0)).order("desc").take(100);
  const out = new Map<string, number>();
  for (const n of notes) {
    const tally = n.author === "line" ? parseMoveTally(n.text) : null;
    for (const [ct, k] of tally?.out ?? []) out.set(ct, (out.get(ct) ?? 0) + k);
  }
  if (task.cause?.merged_into) {
    const into = await taskById(task.cause.merged_into);
    if (into) out.set(into.short_id, out.get(into.short_id) ?? 0);
  }
  for (const ct of out.keys()) {
    const t: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ct)).first();
    if (t && !isTerminalTaskStatus(t.status)) moved.add(ct);
  }
  const movedOff = [...out.values()].reduce((a, b) => a + b, 0);
  return { findings: 0, conversations: 0, withdrawn: retired.length + movedOff, moved_to: [...moved].sort(), gone: gone.slice(0, GONE_SHOWN) };
}

/** Where a finding a card cites stands now: on the card's problem, on another, or withdrawn (and how). */
export type CitedCase = { signal: string; state: "live" | "elsewhere" | "withdrawn" | "missing"; to?: string; fate?: FindingFate; claim?: string; subject?: string };

/** The rule a cited finding breaks, as the project's expectations word it now. */
export type CardRule = { id: string; text: string; part?: string };

/** A change card's live conversations against what its author read: reached, read and left out, arrived since, and gone since. */
export type CardCoverage = { covered: number; other: number; fresh: number; gone: number };

/** Another open trial card whose fix touches the same code (a file and lines within LINES_NEAR), so neither is decided blind of the other. */
export type CardOverlap = { card: string; task: string; title: string; where: string };

/**
 * Which lane a problem belongs to when its fix is codecast's own review
 * machinery rather than the product (LL11 judge review): a finding a judge got
 * wrong files its case against the judge (`judge:<project>:<judge>`) or the
 * extractor (`extractor:<source>:<kind>`). Those are not the product owner's
 * calls, so their cards stay out of the executive's queue.
 */
export function toolingOf(task: Pick<Doc<"tasks">, "cause"> | null | undefined): "judge" | "extractor" | null {
  if (!isJudgeProblem(task?.cause)) return null;
  const key = task?.cause?.issue_key ?? task?.cause?.fingerprints?.[0] ?? "";
  return key.startsWith("extractor:") ? "extractor" : "judge";
}

/** The eval suites a run's eval_scope station said the diff owes ("core,matching"), from its result. */
export function evalsOwedBy(run: Pick<Doc<"workflow_runs">, "node_statuses"> | null | undefined): string[] {
  const n = (run?.node_statuses ?? []).find((x: any) => x.node_id === "eval_scope" && x.status === "completed");
  try {
    const sel = JSON.parse(n?.result_preview ?? "")?.select;
    return typeof sel === "string" ? sel.split(",").map((x: string) => x.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Conversations in each coverage bucket: `read` and `covers` are the card's, `live` the problem's findings now. */
export function coverageOf(reach: { covers?: string[]; read?: string[] } | undefined, live: Array<{ short_id: string; conv: string }>): CardCoverage | null {
  if (!reach?.read || !reach.covers) return null;
  const read = new Set(reach.read);
  const covers = new Set(reach.covers);
  const conv = (pick: (id: string) => boolean) => new Set(live.filter((s) => pick(s.short_id)).map((s) => s.conv));
  const covered = conv((id) => covers.has(id));
  const other = conv((id) => read.has(id) && !covers.has(id));
  const fresh = conv((id) => !read.has(id));
  for (const c of covered) { other.delete(c); fresh.delete(c); }
  for (const c of other) fresh.delete(c);
  const liveIds = new Set(live.map((s) => s.short_id));
  return { covered: covered.size, other: other.size, fresh: fresh.size, gone: reach.read.filter((id) => !liveIds.has(id)).length };
}

const LINES_NEAR = 30;
/** "backend/src/lib/x/matching.njk:319-334" as a path and its first line. */
const whereParts = (w: string) => {
  const m = /^(.*?):(\d+)(?:-\d+)?$/.exec(w.trim());
  return m ? { file: m[1], line: Number(m[2]) } : { file: w.trim(), line: null as number | null };
};
/** Whether two places name the same code: one path ends with the other (checkouts root them differently) and the lines are near. */
export function sameCode(a: string, b: string): boolean {
  const x = whereParts(a), y = whereParts(b);
  const fx = x.file.replace(/^\.?\//, ""), fy = y.file.replace(/^\.?\//, "");
  if (!(fx === fy || fx.endsWith(`/${fy}`) || fy.endsWith(`/${fx}`))) return false;
  return x.line === null || y.line === null || Math.abs(x.line - y.line) <= LINES_NEAR;
}

/** A card as the review page and `cast line trial` read it: its state follows the run it pauses. */
async function cardView(ctx: Ctx, row: Doc<"trial_cards">, rulesOf: (project: Doc<"projects"> | null) => Promise<Map<string, CardRule>>) {
  const [task, run, project] = await Promise.all([ctx.db.get(row.task_id), ctx.db.get(row.run_id), ctx.db.get(row.project_id)]);
  const evidence = task ? await problemEvidence(ctx, task, row.created_at) : null;
  // The findings the card cites, as they stand now, and the rule the first one breaks.
  const proposal = row.proposal as ProposalCard | undefined;
  const citedIds = [...new Set([proposal?.case?.signal, ...((row.card as ChangeCard | undefined)?.seen ?? []).map((x) => x.signal)].filter((x): x is string => !!x))];
  const cited: CitedCase[] = [];
  for (const id of citedIds) {
    const s: Doc<"signals"> | null = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", id)).first();
    if (!s) { cited.push({ signal: id, state: "missing" }); continue; }
    const base = { signal: id, claim: s.title, ...(s.subject ? { subject: s.subject } : {}) };
    if (s.retired) cited.push({ ...base, state: "withdrawn", fate: fateOf(s.retired.reason ?? "").fate });
    else if (s.task_id && s.task_id !== row.task_id) {
      const t: Doc<"tasks"> | null = await ctx.db.get(s.task_id);
      cited.push({ ...base, state: "elsewhere", ...(t ? { to: t.short_id } : {}) });
    } else cited.push({ ...base, state: s.task_id ? "live" : "elsewhere" });
  }
  const rules = await rulesOf(project);
  const subject = cited.find((c) => c.subject && rules.has(c.subject))?.subject;
  const rule = subject ? rules.get(subject)! : null;
  const card = row.card as ChangeCard | undefined;
  let coverage: CardCoverage | null = null;
  if (card?.reach?.read && task) {
    const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    coverage = coverageOf(card.reach, live.map((s) => ({ short_id: s.short_id, conv: findingConversation({ ...s, _id: String(s._id) }) })));
  }
  // A waiting card whose run moved on or ended without an answer reads closed.
  const live = run && run.status === "paused" && run.gate_node_id === row.node_id;
  const status = row.status === "waiting" && !live ? "closed" : row.status;
  // Sent back to rebuild on main, and its run is still on the way to the next card.
  const rebuilding = !!row.rebuild_at && row.status === "waiting" && !!run && (run.status === "running" || run.status === "pending") ? { since: row.rebuild_at, node: run.current_node_id ?? null } : null;
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
    proposal: row.proposal as ProposalCard | undefined,
    /** The judge route's card (shared/contracts/judgeFix): a measured fix to a judge, its extractor or an expectation, for the project's reviewer. */
    judge_fix: row.judge_fix as JudgeFixCard | undefined,
    /** The problem's evidence now; a card on a problem left with none reads stale. */
    evidence,
    /** Set when the fix is codecast's review machinery (a judge or an extractor), not the product: the card is not the executive's. */
    tooling: toolingOf(task),
    /** The findings the card cites, as they stand now. */
    cited,
    /** The rule the cited finding breaks, as the project words it now. */
    rule,
    /** Eval suites the diff owes (eval_scope), which the trial never runs. */
    evals_owed: card ? evalsOwedBy(run) : [],
    coverage,
    /** Other open cards touching the same code (filled by `cards`). */
    overlaps: [] as CardOverlap[],
    rebuilding,
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
    const rulesByProject = new Map<string, Map<string, CardRule>>();
    const rulesOf = async (p: Doc<"projects"> | null) => {
      if (!p) return new Map<string, CardRule>();
      if (!rulesByProject.has(String(p._id))) {
        const latest = await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", p._id)).order("desc").first();
        rulesByProject.set(String(p._id), new Map((latest?.items ?? []).filter((e: any) => e.status === "active").map((e: any) => [e.id, { id: e.id, text: e.text, ...(e.part ? { part: e.part } : {}) }])));
      }
      return rulesByProject.get(String(p._id))!;
    };
    for (const row of rows) {
      if (row.workspace !== workspaceKey) continue;
      const key = String(row.project_id);
      if (!allowed.has(key)) {
        const p = await ctx.db.get(row.project_id);
        allowed.set(key, !!p && (await canAccessProject(ctx, userId, p)));
      }
      if (allowed.get(key)) out.push(await cardView(ctx, row, rulesOf));
    }
    // Where each problem's fix lives, from its newest proposal (a change card's own proposal was answered before it).
    const whereByTask = new Map<string, string[]>();
    for (const v of out) if (v.proposal?.cause?.where?.length && !whereByTask.has(String(v.task_id))) whereByTask.set(String(v.task_id), v.proposal.cause.where);
    const open = out.filter((v) => v.status === "waiting");
    for (const v of open) {
      const mine = whereByTask.get(String(v.task_id)) ?? [];
      for (const o of open) {
        if (o.task_id === v.task_id || o.project_id !== v.project_id) continue;
        const hit = mine.find((a) => (whereByTask.get(String(o.task_id)) ?? []).some((b) => sameCode(a, b)));
        if (hit) v.overlaps.push({ card: o.short_id, task: o.task_short_id, title: o.card?.headline || o.proposal?.question || o.task_title, where: hit.split("/").pop() ?? hit });
      }
    }
    return out;
  },
});

type RunPrice = { sessions: number; usd: number; tokens: number; unpriced_tokens: number };
const newRunPrice = (): RunPrice => ({ sessions: 0, usd: 0, tokens: 0, unpriced_tokens: 0 });

/**
 * A line run's station sessions priced from their token totals (the Spend
 * chart's prices), added into `into`. A session already counted (`seen`) is
 * skipped; one on a model the price table does not name adds its tokens to
 * `unpriced_tokens`, never a guess.
 */
async function priceRun(ctx: Ctx, run: Doc<"workflow_runs">, seen: Set<string>, into: RunPrice): Promise<RunPrice> {
  for (const node of run.node_statuses ?? []) {
    if (!node.session_id || seen.has(node.session_id)) continue;
    seen.add(node.session_id);
    const conv: any = await findConversationByAnyRef(ctx as any, node.session_id, run.user_id);
    const u = conv?.usage_totals;
    if (!u) continue;
    into.sessions++;
    const tokens = u.input + u.output + u.cache_read + u.cache_write;
    into.tokens += tokens;
    const usd = turnCost(conv.model, { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cache_read, cache_creation_input_tokens: u.cache_write });
    if (usd > 0) into.usd += usd;
    else into.unpriced_tokens += tokens;
  }
  return into;
}

/**
 * What one problem has cost: judging the moments behind its findings (each
 * judge run on them, withdrawn findings' moments included) and its line runs'
 * sessions. A change card carries the runs' part (`cast card build`); the
 * problem page shows both.
 */
export async function problemCost(ctx: Ctx, task: Doc<"tasks">) {
  const runs: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  const priced = newRunPrice();
  const seen = new Set<string>();
  for (const run of runs) await priceRun(ctx, run, seen, priced);
  const findings: Doc<"signals">[] = [
    ...(await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect()),
    ...(await ctx.db.query("signals").withIndex("by_retired_task", (q: any) => q.eq("retired.task_id", task._id)).take(200)),
  ];
  let judgeUsd = 0;
  for (const m of [...new Set(findings.map((s) => s.moment).filter((x): x is string => !!x))].slice(0, 300)) {
    const moment: Doc<"moments"> | null = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", m)).first();
    if (!moment) continue;
    for (const r of (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", moment._id)).collect()) as Doc<"judge_runs">[]) judgeUsd += r.cost_usd ?? 0;
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { task: task.short_id, runs: runs.length, sessions: priced.sessions, run_usd: round(priced.usd), tokens: priced.tokens, unpriced_tokens: priced.unpriced_tokens, judge_usd: round(judgeUsd), total_usd: round(priced.usd + judgeUsd) };
}

/** One problem's cost (the problem page; `cast card build` prices a card's runs from it). */
export const cost = query({
  args: { ...scopeArgs, task: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const task: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", args.task)).first();
    if (!task || task.workspace !== workspaceKey) return null;
    const project = task.project_id ? await ctx.db.get(task.project_id) : null;
    if (project && !(await canAccessProject(ctx, userId, project))) return null;
    return await problemCost(ctx, task);
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
  const priced = newRunPrice();
  const seen = new Set<string>();
  for (const task of tasks) {
    const taskRuns: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    for (const run of taskRuns) {
      if (run.created_at < since) continue;
      runs++;
      await priceRun(ctx, run, seen, priced);
    }
  }
  const { sessions, usd: sessionUsd, unpriced_tokens: unpricedTokens } = priced;
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
  args: { ...scopeArgs, project: v.string(), on: v.boolean(), graph: v.optional(v.string()), cwd: v.optional(v.string()), judge: v.optional(v.object({ graph: v.string(), cwd: v.string(), name: v.string() })) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    const now = Date.now();
    if (args.on) {
      const was = project.line_trial;
      const judge = args.judge ?? was?.judge;
      const line_trial = { since: was?.since ?? now, by: was?.by ?? userId, ...((args.graph ?? was?.graph) ? { graph: args.graph ?? was?.graph } : {}), ...((args.cwd ?? was?.cwd) ? { cwd: args.cwd ?? was?.cwd } : {}), ...(judge ? { judge } : {}), ...(was?.dispatch ? { dispatch: was.dispatch } : {}) };
      await ctx.db.patch(project._id, { line_trial, updated_at: now });
      return { project: project.title, project_id: project._id, trial: true, ...line_trial };
    }
    if (project.line_trial) await ctx.db.patch(project._id, { line_trial: undefined, updated_at: now });
    return { project: project.title, project_id: project._id, trial: false };
  },
});

/** Trial runs at once, at most: the machine running them is shared. */
export const TRIAL_RUNNING_CAP = 3;

/**
 * Which graph a trial problem runs: one whose findings are cases against a
 * judge takes the judge route (its fix is a judge's prompt, an extractor or
 * an expectation, measured on the ruled moments), every other the product's.
 */
export function routeOf(task: Pick<Doc<"tasks">, "cause">): "judge" | "product" {
  return toolingOf(task) ? "judge" : "product";
}

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
    const route = routeOf(task);
    const judge = project.line_trial?.judge;
    if (route === "judge" && !judge) throw new Error(`${task.short_id} holds cases against a judge, and ${project.title} names no judge route: cast line trial on --project "${project.title}" --judge-graph <file>`);
    const graph = route === "judge" ? judge!.graph : project.line_trial?.graph ?? null;
    const cwd = route === "judge" ? judge!.cwd : project.line_trial?.cwd ?? null;
    return { task: task.short_id, title: task.title, status: task.status, live_run: live, project: project.title, route, graph, cwd, running, cap: TRIAL_RUNNING_CAP };
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
    const run_id = await queueTrialRun(ctx, userId, task, run, run.runner_device, Date.now());
    return { task: task.short_id, run_id };
  },
});

/**
 * Queue a trial run of `like`'s graph on one problem, to the daemon of
 * `device`: the daemon sets the problem's earlier branch aside and starts from
 * origin/main (cli lineTrialBranch.ts), and reads the graph file it was pushed
 * from (cli daemonGraph.ts), so the run proves against unfixed code with the
 * stations as they are now.
 */
async function queueTrialRun(ctx: Ctx, userId: Id<"users">, task: Doc<"tasks">, like: Doc<"workflow_runs">, device: string, now: number): Promise<Id<"workflow_runs">> {
  const { run_id } = await createRunCore(ctx as any, userId, {
    workflow_name: like.workflow_name ?? "workflow",
    ...(like.workflow_id ? { workflow_id: like.workflow_id } : {}),
    task,
    goal_override: task.title,
    ...(like.project_path ? { project_path: like.project_path } : {}),
    ...(like.spawner_conversation_id ? { spawner_conversation_id: like.spawner_conversation_id } : {}),
    now,
  });
  await ctx.db.patch(run_id, { fresh_branch: true });
  // The new run is the retry: a failed run's block and reason ("max_visits=2 exceeded on prove") no longer describe the problem.
  if (task.execution_status === "blocked" && task.execution_concerns) await ctx.db.patch(task._id, { execution_status: undefined, execution_concerns: undefined });
  await queueRunOnDaemon(ctx as any, userId, run_id, { device, now });
  return run_id;
}

// ── Dispatch ──

/** What one run costs before any has run: the trial's first estimate. */
const FIRST_RUN_USD = 10;

export type DueProblem = { task: string; title: string; route: "judge" | "product"; findings: number; severity: number; regrouped: boolean; last_run: string | null };

/**
 * A trial project's problems due a run, the most in need first (most live
 * findings, then the worst severity): open, holding live findings, with no
 * live run, and either never run or regrouped since their last run started
 * (cause.joined_at). A problem whose last run ended on a person's answer at a
 * card keeps that answer. Also: how many runs hold a machine now, and the
 * newest run with a machine, whose graph and checkout a dispatch reuses.
 */
export async function dueProblems(ctx: Ctx, project: Doc<"projects">) {
  const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
  const due: Array<DueProblem & { row: Doc<"tasks"> }> = [];
  let running = 0;
  // The newest run of each route's graph with a machine: a dispatch copies it. The judge
  // route's runs carry its graph's name; every other run is the product graph's.
  const like: Record<"judge" | "product", Doc<"workflow_runs"> | null> = { judge: null, product: null };
  const judgeName = project.line_trial?.judge?.name;
  for (const task of tasks) {
    const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
    const ran = run && judgeName && run.workflow_name === judgeName ? "judge" : "product";
    if (run?.runner_device && (!like[ran] || run.created_at > like[ran]!.created_at)) like[ran] = run;
    if (run?.status === "running" || run?.status === "pending") running++;
    if (isTerminalTaskStatus(task.status) || (run && isLiveRunStatus(run.status))) continue;
    // A problem whose last run took the other route's graph is due on its own route.
    const misrouted = !!run && (routeOf(task) === "judge") !== (!!judgeName && run.workflow_name === judgeName);
    if (run && !misrouted) {
      if (!task.cause?.joined_at || task.cause.joined_at <= run.created_at) continue;
      const cards: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect();
      if (cards.some((c) => c.kind === "card" && c.status === "answered" && !c.answer?.stand_in)) continue;
    }
    const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    if (!live.length) continue;
    due.push({ row: task, task: task.short_id, title: task.title, route: routeOf(task), findings: live.length, severity: Math.max(0, ...live.map((s) => s.severity ?? 0)), regrouped: !!run, last_run: run?.status ?? null });
  }
  due.sort((a, b) => b.findings - a.findings || b.severity - a.severity || a.row.created_at - b.row.created_at);
  return { due, running, like };
}

/**
 * One dispatch pass over a trial project: start its most-needed due problems
 * while fewer than TRIAL_RUNNING_CAP runs hold the machine, and only while the
 * trial's spend, the runs in flight at the average run's cost, and the next
 * run's stay under the project's cap. Writes what it did (or why it held) on
 * the project only when that changed.
 */
export async function dispatchPass(ctx: Ctx, project: Doc<"projects">, now: number, dry = false) {
  const dispatch = project.line_trial?.dispatch;
  if (!dispatch) throw new Error(`${project.title} does not dispatch: cast line trial dispatch on --project "${project.title}" --cap <usd>`);
  const { due, running, like } = await dueProblems(ctx, project);
  const spend = await trialSpend(ctx, project, now);
  const perRun = spend.runs && spend.session_usd > 0 ? spend.session_usd / spend.runs : FIRST_RUN_USD;
  const room = dispatch.cap_usd - spend.total_usd - running * perRun;
  const slots = Math.max(0, TRIAL_RUNNING_CAP - running);
  const affordable = Math.max(0, Math.floor(room / perRun));
  // Each problem starts its own route's graph, copied from that route's newest run with a machine.
  const startable = due.filter((d) => like[d.route]);
  const n = Math.min(slots, startable.length, affordable);
  let held: string | undefined;
  const unstarted = [...new Set(due.filter((d) => !like[d.route]).map((d) => d.route))];
  if (unstarted.length) held = `no earlier ${unstarted.map((r) => (r === "judge" ? "judge-route" : "product")).join(" or ")} run names a machine: start one with cast line trial run`;
  else if (startable.length > n && n < slots) held = `spend $${spend.total_usd.toFixed(0)} of $${dispatch.cap_usd.toFixed(0)}: another run (~$${perRun.toFixed(0)}) would cross the cap`;
  const started: string[] = [];
  if (!dry) {
    for (const d of startable.slice(0, n)) {
      const from = like[d.route]!;
      await queueTrialRun(ctx, project.line_trial!.by, d.row, from, from.runner_device!, now);
      started.push(d.task);
    }
  }
  const last = dispatch.last;
  if (!dry && (started.length || held !== last?.held)) {
    await ctx.db.patch(project._id, { line_trial: { ...project.line_trial!, dispatch: { ...dispatch, last: { at: now, started, ...(held ? { held } : {}) } } } });
  }
  return {
    project: project.title,
    cap_usd: dispatch.cap_usd,
    spent_usd: spend.total_usd,
    per_run_usd: Math.round(perRun * 100) / 100,
    running,
    cap: TRIAL_RUNNING_CAP,
    started,
    held: held ?? null,
    due: due.map(({ row: _row, ...d }) => d),
  };
}

/** The dispatcher (crons.ts): every trial project that dispatches gets one pass. */
export const dispatchTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects: Doc<"projects">[] = await ctx.db.query("projects").withIndex("by_trial_dispatch_cap", (q: any) => q.gte("line_trial.dispatch.cap_usd", 0)).collect();
    const out = [];
    for (const p of projects) if (p.line_trial?.dispatch) out.push(await dispatchPass(ctx, p, Date.now()));
    return out;
  },
});

/** `cast line trial dispatch on|off --project <ref> [--cap <usd>]`: the trial starts its own runs under a spend cap, or stops. */
export const setDispatch = mutation({
  args: { ...scopeArgs, project: v.string(), cap_usd: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    if (!project.line_trial) throw new Error(`${project.title} is not a trial project`);
    if (args.cap_usd !== undefined && !(args.cap_usd > 0)) throw new Error("--cap is a positive number of dollars");
    const { dispatch: _was, ...rest } = project.line_trial;
    const line_trial = args.cap_usd !== undefined ? { ...rest, dispatch: { cap_usd: args.cap_usd } } : rest;
    await ctx.db.patch(project._id, { line_trial, updated_at: Date.now() });
    return { project: project.title, cap_usd: args.cap_usd ?? null };
  },
});

/** `cast line trial dispatch [--project <ref>] [--dry]`: one pass now, or (dry) what a pass would start. */
export const dispatchNow = mutation({
  args: { ...scopeArgs, project: v.string(), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    return await dispatchPass(ctx, project, Date.now(), !!args.dry);
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
  args: { ...scopeArgs, card: v.string(), change_card: v.optional(v.any()), proposal: v.optional(v.any()), options: v.optional(v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) }))) },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    const row: Doc<"trial_cards"> | null = await ctx.db.query("trial_cards").withIndex("by_short_id", (q: any) => q.eq("short_id", args.card)).first();
    const project = row ? await ctx.db.get(row.project_id) : null;
    if (!row || !project || !(await canAccessProject(ctx, userId, project))) throw new Error("Trial card not found");
    // Options are replaced only when given, keyed the same as the ones they replace, so the answer rides the same edges.
    let options = row.options;
    if (args.options) {
      const keys = (o: Array<{ key: string }>) => o.map((x) => x.key.toUpperCase()).sort().join();
      if (keys(args.options) !== keys(row.options)) throw new Error(`Options must keep the keys ${keys(row.options)}`);
      options = args.options.map((o) => ({ key: o.key, label: stripKey(o.label), ...(o.description ? { description: o.description } : {}) }));
    }
    // A proposal gate's card: what the gate asked stays as it was; the card is how it reads.
    if (args.proposal !== undefined) {
      if (row.kind !== "gate") throw new Error(`${row.short_id} is a change card, not a proposal gate`);
      const p = validateProposalCard(args.proposal);
      if (!p.ok) throw new Error(`The proposal card is not ready:\n  ${p.errors.join("\n  ")}`);
      await ctx.db.patch(row._id, { proposal: p.card, options, updated_at: Date.now() });
      return { short_id: row.short_id, headline: p.card.question, checks: [] as string[] };
    }
    if (row.kind !== "card" || row.status !== "waiting") throw new Error(`${row.short_id} is not a waiting change card`);
    const checked = validateChangeCard(args.change_card);
    if (!checked.ok) throw new Error(`The card is not ready:\n  ${checked.errors.join("\n  ")}`);
    if (checked.card.cause.task !== (await ctx.db.get(row.task_id))?.short_id) throw new Error(`The card is for ${checked.card.cause.task}, not ${row.short_id}'s problem`);
    await ctx.db.patch(row._id, { card: checked.card, options, question: `Ship this change? ${checked.card.headline ?? ""}`.trim(), updated_at: Date.now() });
    return { short_id: row.short_id, headline: checked.card.headline ?? "", checks: checked.card.checks.map((c) => `${c.name} ${c.ok ? "ok" : "red"}`) };
  },
});

/**
 * `cast line trial rebuild <tc-N>`: a waiting change card whose branch is
 * stale against main goes back to the line's `fresh` station, which rebases
 * it (and proves it again) or sends it to the build with the clashing files
 * named, so a stale base never reaches a person as a chore. The run resumes
 * on its own machine from the checkpoint's values (cli runResume.ts); the card
 * reads Rebuilding until the run reaches its next card. The CLI stops the
 * runner still waiting on the gate first, on that machine.
 */
export const rebuildForCli = mutation({
  args: { ...scopeArgs, card: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    const row: Doc<"trial_cards"> | null = await ctx.db.query("trial_cards").withIndex("by_short_id", (q: any) => q.eq("short_id", args.card)).first();
    const project = row ? await ctx.db.get(row.project_id) : null;
    if (!row || !project || !(await canAccessProject(ctx, userId, project))) throw new Error("Trial card not found");
    if (row.kind !== "card" || row.status !== "waiting") throw new Error(`${row.short_id} is not a waiting change card`);
    const stale = ((row.card as ChangeCard | undefined)?.checks ?? []).find((c) => c.name === BASE_CHECK && !c.ok);
    if (!stale) throw new Error(`${row.short_id}'s branch is up to date with main: nothing to rebuild`);
    const run: Doc<"workflow_runs"> | null = await ctx.db.get(row.run_id);
    // Sent again while the run still stands at fresh (its resume could not start) is the same rebuild.
    const again = !!row.rebuild_at && run?.current_node_id === "fresh" && run.status === "running";
    if (!run || (!again && (run.status !== "paused" || run.gate_node_id !== row.node_id))) throw new Error(`${row.short_id}'s run is not waiting on it`);
    if (!run.runner_device) throw new Error(`${row.short_id}'s run names no machine`);
    const now = Date.now();
    // An older run may stand on a graph from before the fresh station: it resumes on the project's current product graph,
    // read again from its file (fresh_branch makes the daemon re-read it; on a resume it never resets the branch).
    const current = (await dueProblems(ctx, project)).like.product;
    const graph = current && current.workflow_id !== run.workflow_id ? { workflow_id: current.workflow_id, workflow_name: current.workflow_name } : {};
    await ctx.db.patch(run._id, { ...graph, fresh_branch: true, status: "running", current_node_id: "fresh", gate_node_id: undefined, gate_prompt: undefined, gate_choices: undefined, gate_response: undefined, updated_at: now });
    await ctx.db.patch(row._id, { rebuild_at: now, updated_at: now });
    await queueRunOnDaemon(ctx as any, userId, run._id, { device: run.runner_device, now });
    return { short_id: row.short_id, run_id: run._id, stale: stale.detail };
  },
});

