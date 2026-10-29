// Trial projects (a project with `line_trial` set): the whole flow runs for
// real on the project's problems, and stops at the decision card.
//
// 1. A gate is its station's decision. The session that wrote the card posts
//    its own page and question; the decision rail files it as the trial's
//    (lib/trialDecision: flagged trial, in the trial's one stack, in nobody's
//    queue), and askTrialGate adopts it as the gate's decision, or asks from
//    that session when it posted none. A trial_cards row indexes it and holds
//    the facts the line checked, shown beside the page.
// 2. Its answer rides the decision rail to the run. An answer at an earlier
//    gate (the proposal) moves the run on to build; at the card, the trial
//    graph's edges only record what the person chose, so the run ends there.
// 3. Nothing merges. `cast line merge` asks orgLineMerge.check first, which
//    refuses a trial run whatever graph it runs.
// 4. What it costs: billed money (the team's model budget for judging,
//    grouping and call nodes, and hand entries named by the key that billed
//    them) apart from subscription use (line-run sessions on Claude Code and
//    Codex logins: tokens and quota, with their API list price as an
//    equivalent only). The dispatcher's cap reads billed money; quota holds runs.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { nextShortId } from "./counters";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf } from "./lib/ingestScope";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { canAccessProject } from "./lib/access";
import { liveRolesByHandle } from "./lib/orgAccess";
import { getAuthenticatedUserId } from "./pendingMessages";
import { readBudget } from "./lib/teamBudget";
import { projectModelSpend } from "./lib/modelSpend";
import { turnCost } from "./lib/usageDaily";
import { fleetAccount } from "./ccAccountsShared";
import { formatCountdown, labeledUsageWindows, livePercent, nextPressuredReset, USAGE_WARN_PERCENT, worstUsagePercent } from "@codecast/shared/contracts";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { BASE_CHECK, CARD_GATE_NODE_ID, validateChangeCard, verdictOfOption, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { findingConversation } from "@codecast/shared/contracts/judges";
import { proposalOptions, sameCode, sameFile, validateProposalCard, whereParts, type ProposalCard } from "@codecast/shared/contracts/proposalCard";
export { sameCode };
import { validateJudgeFixCard, type JudgeFixCard } from "@codecast/shared/contracts/judgeFix";
import { isJudgeProblem, JUDGE_CASE_SOURCE } from "@codecast/shared/contracts/judgeReview";
import { cancelCore, createRunCore, isLiveRunStatus, openDecisionOf, queueRunOnDaemon, resumeRunAt, stationSession, type GateChoice } from "./workflow_runs";
import { askCore, finalizeAnswer, joinStack, normalizeVerdict, refreshHolder, routeFor, routeToRole, syncDecisionInbox, tellHearingRole, userMayRead, withdrawClosedProblemAsks, withdrawCore } from "./sessionDecisions";
import { alignGateChoices } from "./lib/gateChoices";
import { fileTrialCard, trialDeciderOf, trialProjectOf, trialStackOf } from "./lib/trialDecision";
import { retireOnClose } from "./findingGroups";
import { fateOf, problemEvidence, type FindingFate } from "./lib/problemEvidence";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { failedAtStation } from "@codecast/shared/contracts/causeHistory";
import { insertTaskComment, moveTaskStatus } from "./tasks";
import { newLineMemo, problemSuperseded, runSuperseded } from "./lib/superseded";
import { supersededCard, type Superseded } from "@codecast/shared/contracts/superseded";

type Ctx = { db: any };

export { trialProjectOf };

const stripKey = (label: string) => label.replace(/^\[[^\]]*\]\s*/, "").trim() || label;

/**
 * A trial run's gate (pauseAtGateCore, after the run is paused and its task
 * moved to review) is a decision of the session that asks it, on the trial's
 * terms (lib/trialDecision): flagged trial, in the trial's one stack, asked of
 * nobody's queue. The station the gate names (`asker=`) owns it: when its
 * session already posted its decision (its own question, options and page),
 * the gate adopts that one and maps its options onto the gate's edges by
 * verdict; otherwise the gate asks from that session, else from the run's own
 * conversation. The trial_cards row indexes it by run, node and task and
 * holds the structured facts the page's strip shows (the change, proposal or
 * judge-fix card); the question, options, page and answer are the
 * decision's. Earlier cards of the run still waiting close, and an earlier
 * post on this problem the run moved past is withdrawn.
 */
export async function askTrialGate(
  ctx: Ctx,
  run: Doc<"workflow_runs">,
  task: Doc<"tasks">,
  project: Doc<"projects">,
  args: { node_id: string; prompt: string; choices: GateChoice[]; doc_md?: string; category?: string; card?: ChangeCard; proposal?: unknown; judge_fix?: unknown; asker_session_id?: string },
  now: number,
): Promise<{ ok: true; trial_card: string; decision_id: Id<"session_decisions">; decision_short_id?: string } | { error: string }> {
  const open: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect();
  for (const row of open) if (row.status === "waiting" && !(await proposalHolds(ctx, row.decision_id))) await ctx.db.patch(row._id, { status: "closed", updated_at: now });

  const station = await stationSession(ctx, args.asker_session_id, run._id);
  const own = station ? await openDecisionOf(ctx, station._id) : null;
  let decision: { _id: Id<"session_decisions">; short_id?: string };
  if (own) {
    const stack = await trialStackOf(ctx, project, now);
    const joined = stack ? await joinStack(ctx, stack, own, now) : {};
    // Routed again as the trial's (sessionDecisions.routeFor): the owner's practice answer, or, on the judge route,
    // the decider role's, which is told once.
    const routed = await routeFor(ctx, station, now, task);
    const told = (own.hops ?? []).some((h: { role_id: Id<"org_roles"> }) => String(h.role_id) === String(routed.hears?._id));
    await ctx.db.patch(own._id, {
      workflow_run_id: run._id,
      gate_node_id: args.node_id,
      blocking: true,
      trial: true,
      hops: told ? own.hops : routed.ladder.hops,
      asked_user_ids: routed.people,
      task_id: task._id,
      station: task.status_id ?? task.status,
      ...joined,
      updated_at: now,
    });
    const woken = routed.trial === "role" && !told ? await tellHearingRole(ctx, routed.hears, own, now) : [];
    // A post the rail did not see as the trial's (asked before the run nested its station) leaves every queue now;
    // a role's decision no role can hear is its line's person's at once.
    await syncDecisionInbox(ctx, own._id, routed.people, now, routed.trial === "role" && !told && woken.length === 0);
    const adopted = await ctx.db.get(own._id);
    if (adopted) await refreshHolder(ctx, adopted as any, now);
    const aligned = alignGateChoices(own.options, args.choices);
    await ctx.db.patch(run._id, {
      gate_decision_id: own._id,
      gate_choices: aligned.map((c, i) => (c ? { key: c.key, label: c.label, target: c.target } : { key: "", label: own.options[i].label, target: "" })),
    });
    decision = own;
  } else {
    // Only a station of the run asks: its own station, else the run's primary conversation. Never the session that
    // started the run (a plan's orchestrator), which would hold the card and answer for a station it never was.
    const askerId = station?._id ?? run.primary_conversation_id;
    const asker: Doc<"conversations"> | null = askerId ? await ctx.db.get(askerId) : null;
    if (!asker) return { error: "the gate could not ask anyone: the run has no session to ask from" };
    const [first, ...rest] = args.prompt.split("\n");
    const asked = await askCore(ctx, { userId: asker.user_id }, {
      session_id: asker.session_id,
      question: first.trim() || args.node_id,
      context_md: rest.join("\n").trim() || undefined,
      options: args.choices.map((c) => ({ label: stripKey(c.label), ...(c.description ? { description: c.description } : {}) })),
      doc_md: args.doc_md,
      category: args.category,
      blocking: true,
      task: task.short_id,
      station: task.status_id ?? task.status,
      workflow_run_id: run._id,
      gate_node_id: args.node_id,
      trial: true,
    });
    if (!asked || asked.error) return { error: `the gate could not ask anyone: ${asked?.error ?? "no answer from the decision rail"}` };
    await ctx.db.patch(run._id, { gate_decision_id: asked.id });
    decision = { _id: asked.id, short_id: asked.short_id };
  }

  // Earlier posts on this problem the run has moved past (a station that ran again posted again).
  const stale: Doc<"session_decisions">[] = await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", task._id).eq("status", "pending")).collect();
  for (const d of stale) if (d.trial && d._id !== decision._id && !(await proposalHolds(ctx, d._id))) await withdrawCore(ctx, d as any, now);

  const card = args.card && validateChangeCard(args.card).ok ? args.card : undefined;
  const proposal = args.proposal && validateProposalCard(args.proposal).ok ? args.proposal : undefined;
  const fix = args.judge_fix ? validateJudgeFixCard(args.judge_fix) : null;
  const judge_fix = fix?.ok ? fix.card : undefined;
  const short_id = await fileTrialCard(ctx, {
    project, task, run, node_id: args.node_id, decision_id: decision._id,
    // The judge route's card is its run's last stop, answered by a person like a change card.
    kind: card || judge_fix || args.node_id === CARD_GATE_NODE_ID ? "card" : "gate",
    card, proposal, judge_fix,
  }, now);
  return { ok: true, trial_card: short_id, decision_id: decision._id, decision_short_id: decision.short_id };
}

/**
 * Whether an expectation proposal's card is this decision: a station asked it
 * off any gate (expectations.postCard), so no gate the run reaches later
 * closes it, and it is answered as itself (answerTrialDecision).
 */
async function proposalHolds(ctx: Ctx, decisionId: Id<"session_decisions"> | undefined): Promise<boolean> {
  return !!decisionId && !!(await ctx.db.query("expectation_proposals").withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId)).first());
}

/** Whether a run belongs to a trial project: orgLineMerge.check refuses its merge. */
export async function isTrialRun(ctx: Ctx, run: { task_id?: Id<"tasks"> }): Promise<boolean> {
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  return !!(await trialProjectOf(ctx, task));
}

// ── Reads ──

/** Where a finding a card cites stands now: on the card's problem, on another, or withdrawn (and how). */
export type CitedCase = { signal: string; state: "live" | "elsewhere" | "withdrawn" | "missing"; to?: string; fate?: FindingFate; claim?: string; subject?: string };

/** The rule a cited finding breaks, as the project's expectations word it now. */
export type CardRule = { id: string; text: string; part?: string };

/** A change card's live conversations against what its author read: reached, read and left out, arrived since, and gone since. */
export type CardCoverage = { covered: number; other: number; fresh: number; gone: number };

/** Another open trial card whose fix touches the same code (a file and lines within LINES_NEAR), so neither is decided blind of the other. */
/** `on` "rule": another open product card whose case breaks the same rule and whose fix changes the same file (overlapOf), so two policies for one rule in one place are never approved blind of each other. */
export type CardOverlap = { card: string; task: string; title: string; where: string; on?: "code" | "rule" };

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

/**
 * How two open cards' fixes meet, if they do: the same code (a file and lines
 * within LINES_NEAR), or the same rule changed in the same file. A shared rule
 * alone is no overlap: ex-3 holds most findings, and fixes to different
 * templates for it do not compete (tc-22 proactive-task.njk, tc-29
 * matching.njk, tc-40 sendEmail.ts).
 */
export function overlapOf(mine: string[], theirs: string[], sameRule: boolean): { on: "code" | "rule"; where: string } | null {
  const code = mine.find((a) => theirs.some((b) => sameCode(a, b)));
  if (code) return { on: "code", where: code };
  const file = sameRule ? mine.find((a) => theirs.some((b) => sameFile(a, b))) : undefined;
  return file ? { on: "rule", where: file } : null;
}
/**
 * Whether a run waits at a gate its line no longer has: the graph as last
 * pushed (the workflows row every new run of the line reads) holds no node of
 * that id. The run cannot follow any answer from there, so the card it left
 * is held, never asked of a person (ct-59540's proposal_gate after the line
 * dropped its proposal stations). False when the graph is unknown.
 */
export function gateGone(nodeId: string, workflow: Pick<Doc<"workflows">, "nodes"> | null | undefined): boolean {
  const nodes = workflow?.nodes ?? [];
  return nodes.length > 0 && !nodes.some((n: { id: string }) => n.id === nodeId);
}

async function staleGateOf(ctx: Ctx, row: Pick<Doc<"trial_cards">, "node_id">, run: Pick<Doc<"workflow_runs">, "workflow_id"> | null): Promise<boolean> {
  const workflow: Doc<"workflows"> | null = run?.workflow_id ? await ctx.db.get(run.workflow_id) : null;
  return gateGone(row.node_id, workflow);
}

/** A card as the review page and `cast line trial` read it: its state follows the run it pauses. */
/** Stations whose session writes the fix onto the run's branch, newest last. */
const BRANCH_STATIONS = new Set(["build", "fix", "implement"]);
const WORKTREE_PATH = /\/\.codecast\/(?:worktrees|workspaces)\/([^/]+)\/?$/;

/**
 * Where a change card's fix lives: the run's branch (`codecast/<slug>`, named by
 * the worktree its building station ran in, cli lineTrialBranch.ts) and the
 * repository a checkout of the run's directory publishes (repo_sources), so the
 * card's diff can be read against the default branch from that checkout. Null
 * when no station ran in a line worktree or no checkout publishes the repository.
 */
export async function cardBranch(ctx: Ctx, run: Doc<"workflow_runs"> | null, sources: Map<string, Doc<"repo_sources"> | null>): Promise<{ repository: string; name: string; base: string } | null> {
  if (!run?.project_path) return null;
  const nodes = [...run.node_statuses].reverse().filter((n) => n.session_id);
  let slug: string | null = null;
  for (const n of [...nodes.filter((x) => BRANCH_STATIONS.has(x.node_id)), ...nodes.filter((x) => !BRANCH_STATIONS.has(x.node_id))].slice(0, 3)) {
    const conv = await stationSession(ctx, n.session_id, run._id);
    const hit = conv?.project_path ? WORKTREE_PATH.exec(conv.project_path) : null;
    if (hit) { slug = hit[1]; break; }
  }
  if (!slug) return null;
  const key = `${run.user_id}|${run.project_path}`;
  if (!sources.has(key)) {
    let found: Doc<"repo_sources"> | null = null;
    // The checkout root is the run's directory or one above it (a run in outreach/ of union-mobile).
    for (let dir = run.project_path.replace(/\/+$/, ""); dir && !found; dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")))) {
      found = await ctx.db.query("repo_sources").withIndex("by_user_root", (q: any) => q.eq("user_id", run.user_id).eq("root", dir)).first();
    }
    sources.set(key, found);
  }
  const source = sources.get(key);
  return source ? { repository: source.repository, name: `codecast/${slug}`, base: `origin/${source.default_branch || "main"}` } : null;
}

async function cardView(ctx: Ctx, row: Doc<"trial_cards">, rulesOf: (project: Doc<"projects"> | null) => Promise<Map<string, CardRule>>, sources: Map<string, Doc<"repo_sources"> | null> = new Map()) {
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
  // A problem merged away keeps no key; the findings it cites still say whether they were cases against a judge.
  const firstCited: Doc<"signals"> | null = citedIds[0] ? await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", citedIds[0])).first() : null;
  const citedSource = firstCited?.source;
  const rules = await rulesOf(project);
  // The proposal's author names the line the miss breaks, or none; older cards show the cited finding's subject.
  const named = proposal && proposal.rule !== undefined ? proposal.rule : undefined;
  const subject = named !== undefined ? named : cited.find((c) => c.subject && rules.has(c.subject))?.subject;
  // A short id ("ex-3") names the project's own line of that number.
  const short = subject ? /^ex-(\d+)$/.exec(subject) : null;
  const rule = subject ? rules.get(subject) ?? (short ? [...rules.values()].find((r) => r.id.endsWith(`-${short[1]}`)) ?? null : null) : null;
  const card = row.card as ChangeCard | undefined;
  let coverage: CardCoverage | null = null;
  if (card?.reach?.read && task) {
    const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    coverage = coverageOf(card.reach, live.map((s) => ({ short_id: s.short_id, conv: findingConversation({ ...s, _id: String(s._id) }) })));
  }
  // A waiting card whose run moved on or ended without an answer reads closed; so does one whose problem
  // was merged into another, which the survivor's card supersedes (`superseded_by`, filled by `cards`).
  // A proposal's card was asked off any gate (proposalHolds): it waits on its decision, wherever its run is.
  const offGate = await proposalHolds(ctx, row.decision_id);
  const live = offGate || (run && run.status === "paused" && run.gate_node_id === row.node_id);
  const mergedInto: Id<"tasks"> | null = task?.cause?.merged_into ?? null;
  const asked = await askedOf(ctx, row, run);
  // Who answered: the person, and the agent session that carried it when one did.
  const answered = asked?.answer
    ? { ...asked.answer, stand_in: !!row.answer?.stand_in, via: row.answer?.via ?? asked.answer.via }
    : row.answer ? { key: row.answer.key, label: row.answer.label, note: row.answer.note, at: row.answer.at, by: String(row.answer.by), stand_in: !!row.answer.stand_in, via: row.answer.via } : null;
  const answerer: Doc<"users"> | null = answered ? await ctx.db.get(answered.by as Id<"users">) : null;
  const recorded = asked ? asked.status : row.status;
  const status = recorded === "waiting" && (!live || mergedInto) ? "closed" : recorded;
  // line-versions.md LV1: a card still unanswered whose run, problem or evidence moved on is superseded, hidden by default.
  const problem = await problemSuperseded(ctx, task);
  const superseded = supersededCard({
    waiting: recorded === "waiting",
    run: run && !offGate ? await runSuperseded(ctx, run, task) : null,
    run_at_gate: !!live,
    problem,
    covered: card?.reach?.covers ? coverage?.covered ?? null : null,
    live_findings: task?.cause?.signal_count ?? 0,
  });
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
    /** The problem's written name (cause.named, when it names the current title): every list names it by problemListName. */
    task_name: listName(task),
    task_status: task?.status ?? "",
    run_id: row.run_id,
    run_status: run?.status ?? "gone",
    node_id: row.node_id,
    kind: row.kind,
    question: asked?.question ?? row.question ?? row.node_id,
    context_md: asked ? asked.context_md : row.context_md,
    doc_md: asked ? asked.doc_md : row.doc_md,
    /** A proposal gate answers in the shared words whatever graph its run started on (tc-43 read Approve / Drop). */
    options: asked?.options ?? (row.kind === "gate" && row.proposal ? proposalOptions(row.options ?? []) : row.options ?? []),
    /** The decision the asking station's session posted: its page leads the card, and its thread is where to talk it over. */
    decision: asked?.decision ?? null,
    /** The role the card belongs to and the people it waits on, when it is not the trial owner's (audienceOf): it is in their For you and nobody else's. */
    audience: await audienceOf(ctx, row, project, run),
    card: row.card,
    proposal: row.proposal as ProposalCard | undefined,
    /** The judge route's card (shared/contracts/judgeFix): a measured fix to a judge, its extractor or an expectation, for the project's reviewer. */
    judge_fix: row.judge_fix as JudgeFixCard | undefined,
    /** The card settles an expectations proposal (proposalHolds): Apply writes the project's expectations, so it is never practice. */
    expectations: offGate,
    /** The problem's evidence now; a card on a problem left with none reads stale. */
    evidence,
    /** Set when the fix is codecast's review machinery (a judge or an extractor), not the product: the card is not the executive's. */
    tooling: toolingOf(task) ?? (citedSource === JUDGE_CASE_SOURCE ? "judge" : null),
    /** The findings the card cites, as they stand now. */
    cited,
    /** The rule the cited finding breaks, as the project words it now. */
    rule,
    /** Eval suites the diff owes (eval_scope), which the trial never runs. */
    evals_owed: card ? evalsOwedBy(run) : [],
    coverage,
    /** Where a change card's fix lives, so its diff can be read in place (cardBranch); null for other cards. */
    branch: card ? await cardBranch(ctx, run, sources) : null,
    /** Other open cards touching the same code (filled by `cards`). */
    overlaps: [] as CardOverlap[],
    /** The problem this card's problem was merged into, when it was. */
    merged_into: mergedInto,
    /** The survivor's newest card, which answers for this one now (filled by `cards`). */
    superseded_by: null as { card?: string; task: string } | null,
    rebuilding,
    /** The run waits at a gate its line dropped: no answer has an edge to follow, so the card is held until the run is picked up at a station the line still has. */
    stale_gate: status === "waiting" && (await staleGateOf(ctx, row, run)),
    /** Findings joined its problem after the card was written (a regroup or a re-extraction): a count the card carries predates them. */
    regrouped: !!task?.cause?.joined_at && task.cause.joined_at > (row.carded_at ?? row.created_at),
    /** line-versions.md LV1: why the card no longer stands, and what replaced it; null while it is current. */
    superseded,
    status,
    answer: answered ? { ...answered, by_name: answerer?.name ?? null } : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export type TrialCardView = Awaited<ReturnType<typeof cardView>>;

/**
 * A card asked as a decision, read from it: the session's question, options,
 * page and answer, and where the card stands (waiting while the decision is
 * open, answered, else closed). An option's key is its gate key while the run
 * waits on it (what an answer routes by), else its number.
 */
async function askedOf(ctx: Ctx, row: Doc<"trial_cards">, run: Doc<"workflow_runs"> | null) {
  const d: Doc<"session_decisions"> | null = row.decision_id ? await ctx.db.get(row.decision_id) : null;
  if (!d) return null;
  const [doc, conversation] = await Promise.all([d.doc_id ? ctx.db.get(d.doc_id) : null, ctx.db.get(d.conversation_id)]);
  const onIt = !!run && String(run.gate_decision_id ?? "") === String(d._id);
  // A person's answer an agent carried names that session.
  const viaConv: Doc<"conversations"> | null = d.answered_by?.via ? await ctx.db.get(d.answered_by.via) : null;
  const viaShort = viaConv ? viaConv.short_id ?? null : null;
  const keys = optionKeys(d, onIt ? run!.gate_choices : null);
  const options = d.options.map((o, i) => ({ key: keys[i], label: o.label, ...(o.description ? { description: o.description } : {}) }));
  const chosen = d.status === "answered" && d.answer_index !== undefined ? options[d.answer_index] : undefined;
  return {
    question: d.question,
    context_md: d.context_md,
    doc_md: (doc?.content as string | undefined) ?? undefined,
    options,
    status: d.status === "pending" ? "waiting" as const : d.status === "answered" ? "answered" as const : "closed" as const,
    answer: d.status === "answered" ? { key: chosen?.key ?? "", label: chosen?.label ?? d.answer_text ?? "", note: chosen ? d.answer_text : undefined, at: d.resolved_at ?? d.created_at, by: String(d.resolved_by ?? d.user_id), via: viaShort ?? undefined } : undefined,
    decision: {
      _id: d._id,
      short_id: d.short_id ?? null,
      status: d.status,
      report_slug: d.report_slug ?? null,
      session: conversation ? { _id: conversation._id, short_id: conversation.short_id ?? null, title: conversation.title ?? null } : null,
    },
  };
}

/**
 * Who a card waits on when it is a role's and not the trial owner's practice
 * answer: null for the owner's. A decision that climbed a ladder names its
 * role and the people it is asked of (sessionDecisions.routeFor). A judge-route
 * card with no such decision (written before the trial named the route's
 * decider, or by a gate no session asked) belongs to that decider all the
 * same, and waits on the person its line ends at.
 */
export async function audienceOf(ctx: Ctx, row: Doc<"trial_cards">, project: Doc<"projects"> | null, run: Doc<"workflow_runs"> | null) {
  const d: Doc<"session_decisions"> | null = row.decision_id ? await ctx.db.get(row.decision_id) : null;
  const climbed: Doc<"org_roles"> | null = d?.trial && d.hops?.length ? await ctx.db.get(d.hops[0].role_id) : null;
  const role = climbed ?? (project ? await trialDeciderOf(ctx, project, run) : null);
  if (!role) return null;
  const asked = climbed ? d!.asked_user_ids ?? [d!.user_id] : (await routeToRole(ctx, role, row.created_at)).people;
  return { asked: asked.map(String), role: { _id: role._id, short_id: role.short_id ?? null, name: role.name, handle: role.handle ?? null } };
}

const VERDICT_KEY: Record<string, string> = { ship: "S", revise: "R", drop: "D" };

/**
 * A card's option keys: the gate's keys while its run waits on it (what an
 * answer routes by). Otherwise each keeps the letter its verdict had while it
 * waited (S, R, D), so the same answer reads under the same key on every
 * asking of a card, whatever order its author listed them in, else its number.
 */
function optionKeys(d: Pick<Doc<"session_decisions">, "options">, gateChoices: Array<{ key: string }> | null | undefined): string[] {
  const letters = d.options.map((o) => VERDICT_KEY[verdictOfOption(o.label) ?? ""] ?? "");
  return d.options.map((_, i) => gateChoices?.[i]?.key || (letters[i] && letters.indexOf(letters[i]) === i ? letters[i] : String(i + 1)));
}

type Supersedable = { task_id: Id<"tasks">; task_short_id: string; short_id: string; created_at: number; merged_into: Id<"tasks"> | null; superseded_by: { card?: string; task: string } | null };

/**
 * A card whose problem was merged into another is answered by the survivor's
 * newest card (or the survivor itself, while it has none): the merge chain is
 * followed to the problem that still stands, and the card names it.
 */
export async function supersedeMerged(cards: Supersedable[], getTask: (id: Id<"tasks">) => Promise<Doc<"tasks"> | null>): Promise<void> {
  const newestOn = new Map<string, Supersedable>();
  for (const v of cards) if ((newestOn.get(String(v.task_id))?.created_at ?? -1) < v.created_at) newestOn.set(String(v.task_id), v);
  for (const v of cards) {
    let to = v.merged_into;
    for (let hop = 0; to && hop < 8; hop++) {
      const card = newestOn.get(String(to));
      if (card && !card.merged_into) { v.superseded_by = { card: card.short_id, task: card.task_short_id }; break; }
      const t = await getTask(to);
      if (!t) break;
      if (!t.cause?.merged_into) { v.superseded_by = card ? { card: card.short_id, task: t.short_id } : { task: t.short_id }; break; }
      to = t.cause.merged_into;
    }
  }
}

/** Every trial card in the workspace, newest first: the review page's list (web store key `trialCards`) and `cast line trial`. */
/** The waiting cards one read lists beyond the recent window. */
const WAITING_CARDS_CAP = 1000;

export const cards = query({
  args: { ...scopeArgs, project: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<TrialCardView[]> => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const limit = Math.min(Math.max(1, args.limit ?? 300), 500);
    const project = args.project ? await resolveWorkspaceProject(ctx, workspaceKey, args.project) : null;
    if (args.project && !project) throw new Error(`No project "${args.project}" in this workspace`);
    const recent: Doc<"trial_cards">[] = project
      ? await ctx.db.query("trial_cards").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).order("desc").take(limit)
      : await ctx.db.query("trial_cards").withIndex("by_workspace_created", (q: any) => q.eq("workspace", workspaceKey)).order("desc").take(limit);
    // Every waiting card, past the window of recent ones too: each is a decision the team still owes.
    const waiting: Doc<"trial_cards">[] = await ctx.db.query("trial_cards")
      .withIndex("by_workspace_status_created", (q: any) => q.eq("workspace", workspaceKey).eq("status", "waiting")).order("desc").take(WAITING_CARDS_CAP);
    const seenCard = new Set(recent.map((r) => String(r._id)));
    const rows = [...recent, ...waiting.filter((r) => !seenCard.has(String(r._id)) && (!project || String(r.project_id) === String(project._id)))];
    const out: TrialCardView[] = [];
    const allowed = new Map<string, boolean>();
    const rulesByProject = new Map<string, Map<string, CardRule>>();
    const sources = new Map<string, Doc<"repo_sources"> | null>();
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
      if (allowed.get(key)) out.push(await cardView(ctx, row, rulesOf, sources));
    }
    // Where each problem's fix lives, from its newest proposal (a change card's own proposal was answered before it).
    const whereByTask = new Map<string, string[]>();
    // A judge-fix card's fix lives in the files it edits: two waiting edits of one judge or extractor are measured apart and cannot both publish.
    for (const v of out) {
      if (whereByTask.has(String(v.task_id))) continue;
      const where = v.judge_fix?.diff?.length ? v.judge_fix.diff.map((d) => d.file) : v.proposal?.cause?.where;
      if (where?.length) whereByTask.set(String(v.task_id), where);
    }
    await supersedeMerged(out, (id) => ctx.db.get(id));
    const open = out.filter((v) => v.status === "waiting");
    for (const v of open) {
      const mine = whereByTask.get(String(v.task_id)) ?? [];
      for (const o of open) {
        if (o.task_id === v.task_id || o.project_id !== v.project_id) continue;
        const sameRule = !!v.rule && o.rule?.id === v.rule.id && !v.tooling && !o.tooling;
        const hit = overlapOf(mine, whereByTask.get(String(o.task_id)) ?? [], sameRule);
        const title = o.card?.headline || o.proposal?.question || o.task_title;
        if (hit) v.overlaps.push({ card: o.short_id, task: o.task_short_id, title, where: (hit.on === "code" ? hit.where : whereParts(hit.where).file).split("/").pop() ?? hit.where, on: hit.on });
      }
    }
    return out;
  },
});

type KeyPrice = { sessions: number; tokens: number; usd: number };
type RunPrice = { sessions: number; usd: number; tokens: number; unpriced_tokens: number; key: KeyPrice; providers: string[]; device?: string };
const newRunPrice = (): RunPrice => ({ sessions: 0, usd: 0, tokens: 0, unpriced_tokens: 0, key: { sessions: 0, tokens: 0, usd: 0 }, providers: [] });

/**
 * What a session's tokens were billed to. Claude Code and Codex sessions run
 * on the machine's subscription login (the launcher never hands them an API
 * key: cli providerKeyLaunch.ts), so they spend an account's quota and bill
 * nothing. Every other agent reads a provider key, which bills money.
 */
export function sessionBilling(agentType: string | undefined): { provider: "claude" | "codex" } | null {
  if (agentType === "claude_code") return { provider: "claude" };
  if (agentType === "codex") return { provider: "codex" };
  return null;
}

/**
 * A line run's station sessions priced from their token totals (the Spend
 * chart's prices), added into `into`. A session already counted (`seen`) is
 * skipped; one on a model the price table does not name adds its tokens to
 * `unpriced_tokens`, never a guess. A session on a metered key also adds to
 * `key`; the rest name the subscription provider they ran on.
 */
async function priceRun(ctx: Ctx, run: Doc<"workflow_runs">, seen: Set<string>, into: RunPrice): Promise<RunPrice> {
  if (run.runner_device) into.device ??= run.runner_device;
  const convs: any[] = [];
  for (const node of run.node_statuses ?? []) {
    if (!node.session_id || seen.has(node.session_id)) continue;
    seen.add(node.session_id);
    convs.push(await findConversationByAnyRef(ctx as any, node.session_id, run.user_id));
  }
  // A station asked again (a re-ask at Present, a second build) leaves only its newest session on the node; every
  // visit's session is nested under the run's primary conversation, so the cost of a run never falls when it re-asks.
  if (run.primary_conversation_id) {
    convs.push(...(await ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", run.primary_conversation_id)).collect()));
  }
  for (const conv of convs) {
    // Counted once, by the conversation itself: a node may name its session by any of its ids.
    if (!conv || seen.has(`conv:${conv._id}`)) continue;
    seen.add(`conv:${conv._id}`);
    // Its account carries the run's quota whether or not the session reported tokens (Codex sessions report none).
    const billing = sessionBilling(conv.agent_type);
    if (billing && !into.providers.includes(billing.provider)) into.providers.push(billing.provider);
    const u = conv.usage_totals;
    if (!u) continue;
    into.sessions++;
    const tokens = u.input + u.output + u.cache_read + u.cache_write;
    into.tokens += tokens;
    const usd = turnCost(conv.model, { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cache_read, cache_creation_input_tokens: u.cache_write });
    if (usd > 0) into.usd += usd;
    else into.unpriced_tokens += tokens;
    if (!billing) {
      into.key.sessions++;
      into.key.tokens += tokens;
      into.key.usd += Math.max(0, usd);
    }
  }
  return into;
}

/** A run's working minutes: the time its stations ran, start to finish, gates left out (their time is waiting on a person). */
export function workMinutes(run: Pick<Doc<"workflow_runs">, "node_statuses">, isGate: (node: string) => boolean): number {
  let ms = 0;
  for (const n of run.node_statuses ?? []) {
    if (isGate(n.node_id) || n.started_at === undefined || n.completed_at === undefined) continue;
    ms += Math.max(0, n.completed_at - n.started_at);
  }
  return ms / 60_000;
}

/**
 * What one problem has cost, billed money apart from subscription use (as
 * trialSpend splits them): judging the moments behind its findings (each judge
 * run on them, withdrawn findings' moments included), its runs' call nodes and
 * any run session on a metered key are billed; its runs' sessions on Claude
 * Code and Codex logins bill nothing, and `list_usd` is their API list price,
 * an equivalent only. A change card carries the runs' part (`cast card
 * build`); the problem page shows both.
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
  // Working minutes: each station's own time, start to finish. A gate's time is a person's wait, not work.
  let minutes = 0;
  for (const run of runs) {
    const cards: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect();
    const gates = new Set(cards.map((c) => c.node_id));
    minutes += workMinutes(run, (node) => gates.has(node) || node === run.gate_node_id);
  }
  let callUsd = 0;
  for (const run of runs) for (const n of run.node_statuses ?? []) callUsd += (n as { cost_usd?: number }).cost_usd ?? 0;
  const runBilled = priced.key.usd + callUsd;
  return {
    task: task.short_id,
    runs: runs.length,
    minutes: Math.round(minutes),
    sessions: priced.sessions,
    tokens: priced.tokens,
    unpriced_tokens: priced.unpriced_tokens,
    judge_usd: round(judgeUsd),
    /** The runs' billed money: their call nodes and any session on a metered key. */
    run_billed_usd: round(runBilled),
    /** The runs' subscription sessions at API list price: an equivalent, never billed. */
    run_list_usd: round(priced.usd - priced.key.usd),
    billed_usd: round(judgeUsd + runBilled),
  };
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
 * What the trial has cost, in two kinds that never add (the review page's
 * header and `cast line trial`, which the trial ledger reads):
 * - billed: money. The trial's own model calls (judging, grouping, call nodes
 *   on codecast's API key, charged to the project each served), the hand
 *   entries named by the key that billed them, and any line-run session on a
 *   metered provider key.
 * - subscription: line-run sessions on Claude Code and Codex logins. They
 *   spend account quota, not money; `list_usd` is their API list price, an
 *   equivalent only. A session on a model the price table does not name counts
 *   its tokens, not a guess.
 */
export async function trialSpend(ctx: Ctx, project: Doc<"projects">, now = Date.now()) {
  const budget = await readBudget(ctx, project.workspace ?? "", now);
  const since = project.line_trial?.since ?? project.created_at;
  // The trial's own model calls (model_spend_hours, charged to the project each call served), from the hour it began.
  const model = await projectModelSpend(ctx, project._id, since);
  // Each run's own price row (priceRunsTick): no task, run or session is read here, so a rerun or a dispatch never waits on them.
  const prices = await runPricesOf(ctx, project);
  const all = { sessions: 0, tokens: 0, usd: 0 };
  const key = { sessions: 0, tokens: 0, usd: 0 };
  let unpricedTokens = 0;
  const providers = new Set<string>();
  const devices = new Set<string>();
  for (const p of prices) {
    all.sessions += p.sessions;
    all.tokens += p.tokens;
    all.usd += p.usd;
    unpricedTokens += p.unpriced_tokens;
    key.sessions += p.key?.sessions ?? 0;
    key.tokens += p.key?.tokens ?? 0;
    key.usd += p.key?.usd ?? 0;
    for (const x of p.providers ?? []) providers.add(x);
    if (p.device) devices.add(p.device);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const outside = (project.line_trial?.outside ?? []).map((o) => ({ usd: o.usd, what: o.what, billed_by: o.billed_by ?? UNNAMED_BILLER, at: o.at }));
  const byKey = new Map<string, { billed_by: string; usd: number; entries: number }>();
  for (const o of outside) {
    const k = byKey.get(o.billed_by) ?? { billed_by: o.billed_by, usd: 0, entries: 0 };
    k.usd += o.usd;
    k.entries++;
    byKey.set(o.billed_by, k);
  }
  const keys = [...byKey.values()].map((k) => ({ ...k, usd: round(k.usd) })).sort((a, b) => b.usd - a.usd);
  const outsideUsd = outside.reduce((s, o) => s + o.usd, 0);
  return {
    project_id: project._id,
    workspace: project.workspace,
    since,
    /** The trial's line runs since it began (max_runs counts these). */
    runs: prices.length,
    billed: {
      usd: round(model.usd + outsideUsd + key.usd),
      /** The trial's own model calls by purpose; `team_budget` is the workspace's month they draw from, for its cap and refusals. */
      model: {
        usd: round(model.usd),
        calls: model.calls,
        by_purpose: { judge: round(model.by_purpose.judge), grouping: round(model.by_purpose.grouping), call: round(model.by_purpose.call) },
        team_budget: { cap_usd: budget.cap_usd, month: budget.month, spent_usd: round(budget.spent_usd), refused: budget.refused },
      },
      /** Hand entries (`cast line trial spend add`) by the key that billed them. */
      keys,
      /** Line-run sessions on a metered provider key. */
      run_sessions: { sessions: key.sessions, tokens: key.tokens, usd: round(key.usd) },
    },
    subscription: {
      sessions: all.sessions - key.sessions,
      tokens: all.tokens - key.tokens,
      /** What these tokens would cost at API list price: an equivalent, never billed. */
      list_usd: round(all.usd - key.usd),
      unpriced_tokens: unpricedTokens,
      providers: [...providers].sort(),
      /** The machines the runs ran on, whose accounts carry the quota. */
      devices: [...devices].sort(),
    },
    /** The hand entries, newest first (`spend rm` names one by `at`). */
    outside: outside.sort((a, b) => b.at - a.at),
    at: now,
  };
}

/** The name a hand entry recorded before entries named their biller carries. */
export const UNNAMED_BILLER = "not named";

/** One subscription account the trial's runs use, as its machine last reported it (the source `cast usage` reads). */
export type TrialQuota = {
  device: string;
  provider: "claude" | "codex";
  account: string;
  /** The worst live window, the one that stops sessions first; null when the machine reported none. */
  percent: number | null;
  windows: Array<{ label: string; percent: number; resets_at?: number }>;
  fetched_at: number | null;
  /** When the soonest window at or past the warning line resets. */
  resets_at: number | null;
};

/** Each subscription account the trial's runs use: the account each runner machine's sessions launch on, per provider the runs used. */
export async function trialQuota(ctx: Ctx, project: Doc<"projects">, devices: readonly string[], providers: readonly string[], now: number): Promise<TrialQuota[]> {
  const by = project.line_trial?.by;
  if (!by) return [];
  const out: TrialQuota[] = [];
  for (const device of devices) {
    const row: Doc<"devices"> | null = await ctx.db.query("devices").withIndex("by_user_device", (q: any) => q.eq("user_id", by).eq("device_id", device)).first();
    if (!row) continue;
    for (const provider of providers.length ? providers : ["claude"]) {
      const accounts = provider === "codex" ? row.codex_accounts : row.cc_accounts;
      if (!accounts) continue;
      const fleet = provider === "codex" ? { email: accounts.active_email, profile: undefined as string | undefined } : fleetAccount(accounts, now);
      const profile = accounts.profiles.find((p) => (fleet.profile ? p.name === fleet.profile : !!fleet.email && p.email === fleet.email));
      const usage = profile?.usage ?? null;
      out.push({
        device: row.label || device,
        provider: provider as "claude" | "codex",
        account: profile?.name ?? fleet.email ?? "unknown",
        percent: worstUsagePercent(usage, now),
        windows: usage ? labeledUsageWindows(usage).map((w) => ({ label: w.label, percent: livePercent(w, now), ...(w.resets_at ? { resets_at: w.resets_at } : {}) })) : [],
        fetched_at: usage?.fetched_at ?? null,
        resets_at: nextPressuredReset(usage, now) ?? null,
      });
    }
  }
  return out;
}

/** Why runs wait for quota, or null: an account the runs use is at or past the line `cast usage` warns at. */
export function quotaHold(quota: readonly TrialQuota[], now: number): string | null {
  const tight = quota.filter((q) => q.percent != null && q.percent >= USAGE_WARN_PERCENT).sort((a, b) => b.percent! - a.percent!)[0];
  if (!tight) return null;
  return `quota ${Math.round(tight.percent!)}% on ${tight.account} (${tight.provider}): runs wait${tight.resets_at ? ` for its reset in ${formatCountdown(tight.resets_at - now)}` : ""}`;
}

/** A trial project's runs since the trial began, walked through its problems (the sweep's and the reconciler's view). */
async function trialRunsOf(ctx: Ctx, project: Doc<"projects">): Promise<Doc<"workflow_runs">[]> {
  const since = project.line_trial?.since ?? project.created_at;
  const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
  const out: Doc<"workflow_runs">[] = [];
  for (const task of tasks) {
    const taskRuns: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    out.push(...taskRuns.filter((r) => r.created_at >= since));
  }
  return out;
}

/** A trial project's run price rows since the trial began: one per run. */
async function runPricesOf(ctx: Ctx, project: Doc<"projects">): Promise<Doc<"trial_run_prices">[]> {
  const since = project.line_trial?.since ?? project.created_at;
  return await ctx.db.query("trial_run_prices").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id).gte("run_created_at", since)).collect();
}

/** How long after a run last moved its sessions are taken to be done: its price then stands until the run moves again. */
export const RUN_SETTLE_MS = 30 * 60_000;

/** Whether a run's price may be out of date: never priced, priced before it split billed from subscription use, still live, ended too recently to stand, or moved since it was priced. */
export function priceStale(run: Pick<Doc<"workflow_runs">, "status" | "updated_at">, price: Pick<Doc<"trial_run_prices">, "at" | "settled" | "key"> | null): boolean {
  return !price || !price.key || !price.settled || isLiveRunStatus(run.status) || run.updated_at > price.at;
}

/** A trial's runs whose price may be out of date, and the project each prices under (priceRunsTick). Reads runs, never their sessions. */
export const staleRunPrices = internalQuery({
  args: {},
  handler: async (ctx) => {
    const projects: Doc<"projects">[] = await ctx.db.query("projects").withIndex("by_trial_since", (q: any) => q.gt("line_trial.since", 0)).collect();
    const out: Array<{ run: Id<"workflow_runs">; project: Id<"projects"> }> = [];
    for (const p of projects) {
      const prices = new Map((await runPricesOf(ctx, p)).map((r) => [String(r.run_id), r]));
      for (const run of await trialRunsOf(ctx, p)) if (priceStale(run, prices.get(String(run._id)) ?? null)) out.push({ run: run._id, project: p._id });
    }
    return out;
  },
});

/**
 * These runs priced from their sessions now. A query, so the sessions it
 * reads (live ones are written several times a second) never conflict with a
 * write; writeRunPrices stores the answers.
 */
export const priceRuns = internalQuery({
  args: { runs: v.array(v.object({ run: v.id("workflow_runs"), project: v.id("projects") })) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const out = [];
    for (const { run: id, project } of args.runs) {
      const run: Doc<"workflow_runs"> | null = await ctx.db.get(id);
      if (!run) continue;
      const price = await priceRun(ctx, run, new Set(), newRunPrice());
      out.push({ run: id, project, run_created_at: run.created_at, updated_at: run.updated_at, priced: { ...price, at: now, settled: !isLiveRunStatus(run.status) && now - run.updated_at > RUN_SETTLE_MS } });
    }
    return out;
  },
});

const pricedV = v.object({
  sessions: v.number(), usd: v.number(), tokens: v.number(), unpriced_tokens: v.number(),
  key: v.object({ sessions: v.number(), tokens: v.number(), usd: v.number() }), providers: v.array(v.string()), device: v.optional(v.string()),
  at: v.number(), settled: v.boolean(),
});

/**
 * Stores runs' prices (priceRuns), only what changed. A settled price must
 * describe the run as it is, so one priced before the run moved again is
 * dropped and priced next tick.
 */
export const writeRunPrices = internalMutation({
  args: { prices: v.array(v.object({ run: v.id("workflow_runs"), project: v.id("projects"), run_created_at: v.number(), updated_at: v.number(), priced: pricedV })) },
  handler: async (ctx, args) => {
    let wrote = 0;
    for (const { run: id, project, run_created_at, updated_at, priced } of args.prices) {
      if (priced.settled && (await ctx.db.get(id))?.updated_at !== updated_at) continue;
      const was: Doc<"trial_run_prices"> | null = await ctx.db.query("trial_run_prices").withIndex("by_run", (q: any) => q.eq("run_id", id)).first();
      if (!was) {
        await ctx.db.insert("trial_run_prices", { project_id: project, run_id: id, run_created_at, ...priced });
        wrote++;
        continue;
      }
      const same = was.sessions === priced.sessions && was.usd === priced.usd && was.tokens === priced.tokens && was.unpriced_tokens === priced.unpriced_tokens && was.settled === priced.settled
        && JSON.stringify(was.key ?? null) === JSON.stringify(priced.key) && (was.providers ?? []).join() === priced.providers.join() && was.device === priced.device;
      if (same && (!priced.settled || was.at >= updated_at)) continue;
      await ctx.db.patch(was._id, priced);
      wrote++;
    }
    return wrote;
  },
});

/** Reconciler: a trial's stored run prices and live count against reading every run and session now, so drift is measured, not assumed. */
export const spendDrift = internalQuery({
  args: { project: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.project);
    if (!project) return null;
    const runs = await trialRunsOf(ctx, project);
    const prices = await runPricesOf(ctx, project);
    const byRun = new Map(prices.map((r) => [String(r.run_id), r]));
    const live = newRunPrice();
    const seen = new Set<string>();
    let alone = 0;
    for (const run of runs) {
      await priceRun(ctx, run, seen, live);
      alone += (await priceRun(ctx, run, new Set(), newRunPrice())).sessions;
    }
    let walked = 0;
    for (const t of (await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect()) as Doc<"tasks">[]) {
      const run = t.workflow_run_id ? await ctx.db.get(t.workflow_run_id) : null;
      if (run?.status === "running" || run?.status === "pending") walked++;
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      runs: runs.length,
      price_rows: prices.length,
      unpriced_runs: runs.filter((r) => !byRun.has(String(r._id))).length,
      stale_runs: runs.filter((r) => priceStale(r, byRun.get(String(r._id)) ?? null)).length,
      stored: { sessions: prices.reduce((n, r) => n + r.sessions, 0), usd: round(prices.reduce((n, r) => n + r.usd, 0)) },
      live: { sessions: live.sessions, usd: round(live.usd), key: { ...live.key, usd: round(live.key.usd) }, providers: live.providers },
      /** Each session the runs nest, by the agent it ran and the account it launched on: the evidence behind billed vs subscription. */
      accounts: await sessionAccounts(ctx, runs),
      /** Sessions counted by more than one run when each run is priced alone. */
      shared_sessions: alone - live.sessions,
      running: { by_status: await runningIn(ctx, project), by_tasks: walked },
    };
  },
});

async function sessionAccounts(ctx: Ctx, runs: Doc<"workflow_runs">[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const run of runs) {
    if (!run.primary_conversation_id) continue;
    for (const c of (await ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", run.primary_conversation_id)).collect()) as Doc<"conversations">[]) {
      const k = `${c.agent_type}:${c.agent_type === "codex" ? c.codex_account ?? "-" : c.cc_account ?? "-"}`;
      out[k] = (out[k] ?? 0) + 1;
    }
  }
  return out;
}

/** Keeps every trial run's price current (cron): prices the stale ones in small batches and stores them. */
export const priceRunsTick = internalAction({
  args: {},
  handler: async (ctx): Promise<{ stale: number; wrote: number }> => {
    const stale: Array<{ run: Id<"workflow_runs">; project: Id<"projects"> }> = await ctx.runQuery((internal as any).lineTrial.staleRunPrices, {});
    let wrote = 0;
    for (let i = 0; i < stale.length; i += 20) {
      const prices = await ctx.runQuery((internal as any).lineTrial.priceRuns, { runs: stale.slice(i, i + 20) });
      wrote += await ctx.runMutation((internal as any).lineTrial.writeRunPrices, { prices });
    }
    return { stale: stale.length, wrote };
  },
});

/** The trial's spend for one project, and the quota of the accounts its runs use (web store key `trialSpend`, keyed by project; `cast line trial`). */
export const spend = query({
  args: { ...scopeArgs, project: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    if (!project.line_trial) throw new Error(`${project.title} is not a trial project`);
    const s = await trialSpend(ctx, project);
    return { _id: project._id, ...s, cap_usd: project.line_trial.dispatch?.cap_usd ?? null, quota: await trialQuota(ctx, project, s.subscription.devices, s.subscription.providers, s.at) };
  },
});

/** Whether a trial starts its own runs and, when it does, why its last pass held (dispatchPass writes it every
 *  10 minutes when it changes): what a list of its waiting problems says about them. Null when it starts nothing. */
export function dispatchFacts(d: NonNullable<Doc<"projects">["line_trial"]>["dispatch"]) {
  return d ? { cap_usd: d.cap_usd, max_runs: d.max_runs ?? null, held: d.last?.held ?? null, at: d.last?.at ?? null } : null;
}

/** The workspace's trial projects (the review page's filter; `cast line trial`). */
export const projects = query({
  args: { ...scopeArgs },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const rows: Doc<"projects">[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspaceKey)).collect();
    const out = [];
    for (const p of rows) if (p.line_trial && (await canAccessProject(ctx, userId, p))) out.push({ _id: p._id, workspace: p.workspace, title: p.title, short_id: (p as any).short_id, since: p.line_trial.since, dispatch: dispatchFacts(p.line_trial.dispatch) });
    return out;
  },
});

// ── Writes ──

/** `cast line trial on|off --project <ref>`: a team member makes a project a trial, or ends it. */
export const setTrial = mutation({
  args: {
    ...scopeArgs, project: v.string(), on: v.boolean(), graph: v.optional(v.string()), cwd: v.optional(v.string()), judge: v.optional(v.object({ graph: v.string(), cwd: v.string(), name: v.string() })),
    /** The role a judge-route run's decision belongs to (its handle), or "none" to give it back to the trial's owner. */
    judge_decides: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    const now = Date.now();
    if (args.on) {
      const was = project.line_trial;
      const route = args.judge ?? was?.judge;
      let decides = was?.judge?.decides;
      if (args.judge_decides !== undefined) {
        if (!route) throw new Error(`${project.title} names no judge route: give --judge-graph with --judge-decides`);
        if (args.judge_decides === "none") decides = undefined;
        else {
          const [role] = project.team_id ? await liveRolesByHandle(ctx, { team_id: project.team_id }, args.judge_decides) : [];
          if (!role || role.status !== "active") throw new Error(`No active role @${args.judge_decides.replace(/^@/, "")} in ${project.title}'s workspace`);
          decides = role._id;
        }
      }
      const judge = route ? { graph: route.graph, cwd: route.cwd, name: route.name, ...(decides ? { decides } : {}) } : undefined;
      // Everything the trial made for itself (its stack, its page password) stays with it across a re-run of `on`.
      const line_trial = { ...(was ?? {}), since: was?.since ?? now, by: was?.by ?? userId, ...((args.graph ?? was?.graph) ? { graph: args.graph ?? was?.graph } : {}), ...((args.cwd ?? was?.cwd) ? { cwd: args.cwd ?? was?.cwd } : {}), judge };
      if (!judge) delete line_trial.judge;
      await ctx.db.patch(project._id, { line_trial, updated_at: now });
      const decider: Doc<"org_roles"> | null = decides ? await ctx.db.get(decides) : null;
      return { project: project.title, project_id: project._id, trial: true, ...line_trial, ...(decider ? { decider: `${decider.name} @${decider.handle}` } : {}) };
    }
    if (project.line_trial) await ctx.db.patch(project._id, { line_trial: undefined, updated_at: now });
    return { project: project.title, project_id: project._id, trial: false };
  },
});

/** Trial runs at once, at most: the machine running them is shared. */
export const TRIAL_RUNNING_CAP = 10;

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
  // From the live runs, not the project's problems: a rerun reads a handful of runs, never every task.
  let running = 0;
  for (const status of ["running", "pending"] as const) {
    for (const run of (await ctx.db.query("workflow_runs").withIndex("by_status", (q: any) => q.eq("status", status)).collect()) as Doc<"workflow_runs">[]) {
      const task: Doc<"tasks"> | null = run.task_id ? await ctx.db.get(run.task_id) : null;
      if (task?.project_id === project._id && task.workflow_run_id === run._id) running++;
    }
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
    if (route === "judge" && !judge) throw new Error(`${task.short_id} holds cases against a judge, and ${project.title} names no judge route: cast flow trial on --project "${project.title}" --judge-graph <file>`);
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
export async function answerTrialCardCore(ctx: Ctx, userId: Id<"users">, ref: string, key: string, note: string | undefined, now = Date.now(), standIn = false, via?: string) {
  const row: Doc<"trial_cards"> | null =
    (await ctx.db.query("trial_cards").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first()) ??
    (ctx.db.normalizeId("trial_cards", ref) ? await ctx.db.get(ctx.db.normalizeId("trial_cards", ref)) : null);
  const project = row ? await ctx.db.get(row.project_id) : null;
  if (!row || !project || !(await canAccessProject(ctx, userId, project))) throw new Error("Trial card not found");
  if (row.status !== "waiting") throw new Error(`${row.short_id} is already ${row.status}`);
  if (standIn && row.kind === "card") throw new Error(`${row.short_id} is the change card: only a person answers it, not an agent session or a browser tab one drives`);
  if (await staleGateOf(ctx, row, await ctx.db.get(row.run_id))) throw new Error(`${row.short_id} waits at ${row.node_id}, a step its flow no longer has: pick the run up with cast flow trial rerun <task> --reask --at <station>`);
  if (row.decision_id) return answerTrialDecision(ctx, userId, row, key, note, now, standIn, via);
  // A proposal's answer is recorded in the words the card showed, whatever labels its run's graph gave the gate.
  const options = row.kind === "gate" && row.proposal ? proposalOptions(row.options ?? []) : row.options ?? [];
  const option = options.find((o) => o.key.toUpperCase() === key.trim().toUpperCase());
  if (!option) throw new Error(`${row.short_id} has no option ${key}`);
  const run = await ctx.db.get(row.run_id);
  if (!run || run.status !== "paused" || run.gate_node_id !== row.node_id || run.gate_decision_id) {
    await ctx.db.patch(row._id, { status: "closed", updated_at: now });
    throw new Error(`${row.short_id}'s run is no longer waiting on it`);
  }
  const text = note?.trim().slice(0, 4000);
  await ctx.db.patch(run._id, { gate_response: text ? `${option.key}: ${text}` : option.key, status: "running", updated_at: now });
  await ctx.db.patch(row._id, { status: "answered", answer: { key: option.key, label: option.label, ...(text ? { note: text } : {}), by: userId, at: now, ...(standIn ? { stand_in: true } : {}), ...(via ? { via } : {}) }, updated_at: now });
  return { short_id: row.short_id, answer: option.label };
}

/**
 * A trial card asked as a decision is answered as one: the chosen option (by
 * its gate key, or its number on the decision) through the rail every answer
 * takes, which hands the run its edge. Only a stand-in is noted on the row,
 * since the decision does not say an agent gave it.
 */
async function answerTrialDecision(ctx: Ctx, userId: Id<"users">, row: Doc<"trial_cards">, key: string, note: string | undefined, now: number, standIn: boolean, via?: string) {
  const decision: Doc<"session_decisions"> | null = await ctx.db.get(row.decision_id!);
  if (!decision || decision.status !== "pending") throw new Error(`${row.short_id} is already ${decision?.status ?? "gone"}`);
  if (!(await userMayRead(ctx, userId, decision as any))) throw new Error("Trial card not found");
  const run: Doc<"workflow_runs"> | null = await ctx.db.get(row.run_id);
  // A proposal's card was asked off any gate: the run never waited on it, and its answer settles the proposal alone.
  const gated = !(await proposalHolds(ctx, decision._id));
  if (gated && (!run || run.status !== "paused" || String(run.gate_decision_id ?? "") !== String(decision._id))) {
    await ctx.db.patch(row._id, { status: "closed", updated_at: now });
    throw new Error(`${row.short_id}'s run is no longer waiting on it`);
  }
  const k = key.trim().toUpperCase();
  const keys = optionKeys(decision, gated ? run!.gate_choices : null);
  const byKey = keys.findIndex((c) => c && c.toUpperCase() === k);
  const index = byKey >= 0 ? byKey : /^\d+$/.test(k) ? Number(k) - 1 : -1;
  const option = decision.options[index];
  // A gate key none of the session's options carries (the dispatcher's Revise to gather) routes as typed text.
  const graphKey = gated && !option && /^[A-Z]$/.test(k);
  if (!option && !graphKey) throw new Error(`${row.short_id} has no option ${key}`);
  const text = note?.trim().slice(0, 4000);
  const verdict = normalizeVerdict(decision as any, option
    ? { status: "answered", answer_index: index, ...(text ? { answer_text: text } : {}) }
    : { status: "answered", answer_text: text ? `${k}: ${text}` : k });
  if ("error" in verdict) throw new Error(verdict.error);
  await finalizeAnswer(ctx, decision as any, verdict, { kind: "user", id: String(userId), user_id: userId }, { deliver: false, now });
  const label = option?.label ?? k;
  if (standIn) await ctx.db.patch(row._id, { answer: { key: option ? keys[index] : k, label, ...(text ? { note: text } : {}), by: userId, at: now, stand_in: true, ...(via ? { via } : {}) } });
  return { short_id: row.short_id, answer: label };
}

/**
 * One-off repair (packages/convex/run.sh lineTrial:markStandIns): answers an
 * agent gave as tests, or the dispatcher's own Gather revises, written before
 * either was recorded as a stand-in. Each named card (and, with `gather`,
 * every Gather revise) is marked stand_in, so the dispatcher no longer reads
 * it as a person's final verdict and /trial no longer counts it as one; its
 * problem says so. A card answered through its decision gets the decision's
 * answer copied onto the row with the mark.
 */
export const markStandIns = internalMutation({
  args: { project: v.string(), cards: v.array(v.string()), gather: v.optional(v.boolean()), dry: v.optional(v.boolean()), why: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const project: Doc<"projects"> | null = ctx.db.normalizeId("projects", args.project) ? await ctx.db.get(ctx.db.normalizeId("projects", args.project)!) : null;
    if (!project?.line_trial) throw new Error(`${args.project} is not a trial project`);
    const rows: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).collect();
    const named = new Set(args.cards);
    const marked: Array<{ card: string; task: string | null; answer: string }> = [];
    const now = Date.now();
    for (const row of rows) {
      const gather = !!args.gather && !!row.answer?.note?.startsWith(GATHER_LEAD);
      if (!named.has(row.short_id) && !gather) continue;
      if (row.answer?.stand_in) continue;
      let answer = row.answer;
      if (!answer && row.decision_id) {
        const run: Doc<"workflow_runs"> | null = await ctx.db.get(row.run_id);
        const asked = await askedOf(ctx, row, run);
        if (asked?.answer) answer = { key: asked.answer.key, label: asked.answer.label, ...(asked.answer.note ? { note: asked.answer.note } : {}), at: asked.answer.at, by: asked.answer.by as Id<"users"> };
      }
      if (!answer) continue;
      const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
      marked.push({ card: row.short_id, task: task?.short_id ?? null, answer: answer.label });
      if (args.dry) continue;
      await ctx.db.patch(row._id, { answer: { ...answer, stand_in: true }, updated_at: now });
      if (task && !gather) await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: `Trial: ${row.short_id}'s "${answer.label}" was an agent's test answer, not a person's${args.why ? ` (${args.why})` : ""}. It no longer counts as the verdict, and new findings here can get a fresh run.` });
    }
    return { marked, dry: !!args.dry };
  },
});

/**
 * The review page's answer (dispatched from the store's trialAnswer action).
 * `agent`: the tab is one a cast browser session drives, so the answer is an
 * agent's stand-in, never the signed-in person's verdict.
 */
export const answer = mutation({
  args: { card: v.string(), key: v.string(), note: v.optional(v.string()), agent: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return answerTrialCardCore(ctx, userId, args.card, args.key, args.note, Date.now(), !!args.agent);
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
    // An agent session's answer names the session, so the review page says who answered.
    const session = args.conversation_id
      ? (await ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", args.conversation_id)).first())
        ?? (ctx.db.normalizeId("conversations", args.conversation_id) ? await ctx.db.get(ctx.db.normalizeId("conversations", args.conversation_id)!) : null)
      : null;
    return answerTrialCardCore(ctx, userId, args.card, args.key, args.note, Date.now(), !!args.conversation_id, session?.short_id ?? args.conversation_id ?? undefined);
  },
});

// ── Runs ──

/** What a stopped run left: the station that gave up, its last words, and the findings still on the problem. */
export type RunStop = { station: string; words: string; findings: number };

/**
 * A run that reached Exit through one of its failure stations (failed_at_*,
 * which only comments) on a problem still open: nothing closed the problem and
 * no card waits, so without this it would sit in review unseen. The words are
 * the giving-up station's own last message.
 */
export function stopOf(run: Pick<Doc<"workflow_runs">, "status" | "node_statuses">, taskStatus: string): Omit<RunStop, "findings"> | null {
  if (run.status !== "completed" || isTerminalTaskStatus(taskStatus)) return null;
  const nodes = run.node_statuses ?? [];
  const station = failedAtStation(nodes);
  if (!station) return null;
  const last = [...nodes].reverse().find((n: any) => n.node_id === station);
  const words = (last?.result_preview ?? "").trim().split("\n").find((l: string) => l.trim()) ?? "";
  return { station, words: words.slice(0, 300) };
}

/**
 * A run that died while it waited at one of its own cards: its gate ended with
 * no answer (a gate poll that failed, read as a withdrawn gate), so the runner
 * found no edge out of it. Its evidence and its proposal are all written; the
 * run picks up at that gate again (resumeRunAt). The card it left names it.
 */
export type GateLoss = { node: string; card: string; kind: "gate" | "card" };

export async function gateLossOf(ctx: Ctx, run: Pick<Doc<"workflow_runs">, "_id" | "status" | "fail_reason">): Promise<GateLoss | null> {
  if (run.status !== "failed") return null;
  const node = /^no outgoing edge from (\S+) \(outcome failure\b/.exec(run.fail_reason ?? "")?.[1];
  if (!node) return null;
  const cards: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect();
  const last = cards.filter((c) => c.node_id === node).sort((a, b) => b.created_at - a.created_at)[0];
  return last ? { node, card: last.short_id, kind: last.kind } : null;
}

/**
 * What the trial may still start: its spend, the average run's billed money,
 * the runs holding a machine, the billed dollars left under the dispatch cap
 * after those, the runs left under max_runs, and the quota of the subscription
 * accounts its runs use (`devices`: machines a pass would start on, besides
 * those its runs ran on). Every path that starts or resumes a trial run (the
 * dispatcher, a rerun from the page or the CLI) reads this one answer.
 */
export async function trialRoom(ctx: Ctx, project: Doc<"projects">, now: number, running?: number, devices: readonly string[] = []) {
  const dispatch = project.line_trial?.dispatch;
  const spend = await trialSpend(ctx, project, now);
  const held = running ?? (await runningIn(ctx, project));
  const perRun = spend.runs ? spend.billed.run_sessions.usd / spend.runs : 0;
  const room = dispatch ? dispatch.cap_usd - spend.billed.usd - held * perRun : Infinity;
  const runsLeft = dispatch?.max_runs === undefined ? Infinity : Math.max(0, dispatch.max_runs - spend.runs);
  const quota = await trialQuota(ctx, project, [...new Set([...spend.subscription.devices, ...devices])], spend.subscription.providers, now);
  return { spend, perRun, running: held, room, runsLeft, cap_usd: dispatch?.cap_usd ?? null, max_runs: dispatch?.max_runs ?? null, quota, quotaHold: quotaHold(quota, now) };
}

/** How many runs fit in `room` billed dollars at `perRun` each: none once the cap is reached, any number while runs bill nothing. */
export function runsAffordable(room: number, perRun: number): number {
  if (room <= 0) return 0;
  return perRun > 0 ? Math.floor(room / perRun) : Infinity;
}

/** The cap's hold in words: billed money against the cap. */
function capHold(billed: number, cap: number, perRun: number): string {
  return `billed $${billed.toFixed(0)} of $${cap.toFixed(0)}: ${perRun > 0 ? `another run (~$${perRun.toFixed(2)} billed) would cross the cap` : "the cap is reached"}`;
}

/** Why a rerun may not start now, or null: the machine's slots, the accounts' quota, the billed-money cap, and (for a new run, not a gate resume) the run limit. */
export function rerunRefusal(r: Awaited<ReturnType<typeof trialRoom>>, newRun: boolean): string | null {
  if (r.running >= TRIAL_RUNNING_CAP) return `${r.running} trial runs are running; the cap is ${TRIAL_RUNNING_CAP}`;
  if (r.quotaHold) return r.quotaHold;
  if (runsAffordable(r.room, r.perRun) < 1) return capHold(r.spend.billed.usd, r.cap_usd!, r.perRun);
  if (newRun && r.runsLeft <= 0) return `${r.spend.runs} of ${r.max_runs} runs used: the trial starts no more (cast flow trial dispatch on --cap <usd> --max-runs <n>)`;
  return null;
}

/** The problem's written list name, when it names the title the task holds now (web lineFlow causeName). */
const listName = (task: Doc<"tasks"> | null | undefined): string | null =>
  (task?.cause?.named?.for === task?.title && task?.cause?.named?.name?.trim()) || null;

/** A trial problem's latest run as the review page reads it, keyed by the problem. */
function runRow(workspace: string, project: Doc<"projects">, task: Doc<"tasks">, run: Doc<"workflow_runs">, stopped: RunStop | null = null, lost_at_gate: GateLoss | null = null) {
  return {
    _id: task._id,
    workspace,
    project_id: project._id,
    task_short_id: task.short_id,
    task_title: task.title,
    task_name: listName(task),
    task_status: task.status,
    run_id: run._id,
    status: run.status,
    node_id: run.current_node_id ?? null,
    fail_reason: run.status === "failed" ? run.fail_reason ?? null : null,
    fresh_branch: !!run.fresh_branch,
    /** Reached Exit through a failure station with the problem still open (stopOf). */
    stopped,
    /** Died waiting at its own card (gateLossOf): a rerun picks up at that gate with the proposal it already wrote. */
    lost_at_gate,
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
    const out: Array<TrialRunView & { superseded: Superseded }> = [];
    const memo = newLineMemo();
    for (const project of projects) {
      if (!(await canAccessProject(ctx, userId, project))) continue;
      const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
      for (const task of tasks) {
        const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
        if (!run) continue;
        // A run its problem's close ended is not a failure to act on: nothing is left to rerun.
        if (run.status === "failed" && isTerminalTaskStatus(task.status)) continue;
        const stop = stopOf(run, task.status);
        const findings = stop ? (await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect()).length : 0;
        // A station that gave up without a message: the failure station's blocker comment carries why ("The run stopped at the proposal. ...").
        if (stop && !stop.words) {
          const last: Doc<"task_comments"> | null = await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", task._id).gte("created_at", run.created_at)).order("desc").filter((q: any) => q.eq(q.field("comment_type"), "blocker")).first();
          if (last) stop.words = last.text.replace(/^The run stopped [^.]*\.\s*/, "").split("\n").find((l: string) => l.trim())?.slice(0, 300) ?? "";
        }
        // A closed problem's run lost nothing: there is no card to pick up.
        const row = runRow(workspaceKey, project, task, run, stop ? { ...stop, findings } : null, isTerminalTaskStatus(task.status) ? null : await gateLossOf(ctx, run));
        out.push({ ...row, superseded: await runSuperseded(ctx, run, task, memo) });
      }
    }
    return out.sort((a, b) => b.updated_at - a.updated_at);
  },
});


/**
 * A failed trial run, or one stopped at a failure station, run again from the review page (dispatched from the
 * store's trialRerun action): the same graph on the same machine, queued to
 * its daemon, which sets the earlier run's branch aside and starts from
 * origin/main (cli lineTrialBranch.ts), so the proof runs against unfixed code.
 * A run that died waiting at its own card picks up at that gate instead
 * (resumeRunAt): its evidence and proposal are already made. Both go through
 * the same machine, spend and run-count check as the dispatcher (trialRoom);
 * a gate resume is the same run, so it spends no run of max_runs.
 */
/**
 * Where a re-ask of a waiting change card goes. The card says which of the
 * problem's findings its author read and which the fix reaches (reach); the
 * problem's findings may have changed under it since (a regroup moved some
 * off, new ones joined). Worded again, the same build earns the same verdict
 * at a card session's cost (ct-59433: tc-32, tc-56, tc-66 on one build). So:
 *   card         the findings are the ones the card was built on, or the fix
 *                still reaches at least half of the conversations here now;
 *   investigate  the findings changed and the fix reaches under half: the run
 *                reads the problem again and works on from there, on its branch;
 *   main         the fix reaches none of them: the run ends, the branch is set
 *                aside and the problem is due a run from main.
 */
export async function reaskRoute(ctx: Ctx, task: Doc<"tasks">, row: Doc<"trial_cards">): Promise<{ to: "card" } | { to: "investigate" | "main"; why: string }> {
  const card = row.card as ChangeCard | undefined;
  if (row.kind !== "card" || !card?.reach?.read) return { to: "card" };
  const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  const coverage = coverageOf(card.reach, live.map((s) => ({ short_id: s.short_id, conv: findingConversation({ ...s, _id: String(s._id) }) })));
  if (!coverage || !live.length) return { to: "card" };
  const all = coverage.covered + coverage.other + coverage.fresh;
  const convs = (n: number) => `${n} conversation${n === 1 ? "" : "s"}`;
  if (coverage.covered === 0) return { to: "main", why: `its fix reaches none of the ${convs(all)} the problem holds now` };
  const changed = coverage.fresh > 0 || coverage.gone > 0 || (!!task.cause?.joined_at && task.cause.joined_at > (row.carded_at ?? row.created_at));
  if (changed && coverage.covered * 2 < all) return { to: "investigate", why: `the problem's findings changed since its build, and the fix reaches ${coverage.covered} of ${convs(all)} now` };
  return { to: "card" };
}

/**
 * A problem whose run's fix is not its answer goes back to the queue with
 * its findings: the card is marked (reopened_at, which makes the problem due
 * a run from main whatever the card's answer was), a run still waiting ends,
 * and the problem reads open with a note saying why.
 */
async function reopenProblem(ctx: Ctx, userId: Id<"users">, task: Doc<"tasks">, run: Doc<"workflow_runs"> | null, row: Doc<"trial_cards"> | null, note: string, now: number): Promise<void> {
  if (row) await ctx.db.patch(row._id, { reopened_at: now, ...(row.status === "waiting" ? { status: "closed" as const } : {}), updated_at: now });
  if (run && isLiveRunStatus(run.status) && run.status !== "running") await cancelCore(ctx as any, run, now, "Stopped: its fix was set aside and the problem is due a new run");
  await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: note });
  const fresh: Doc<"tasks"> = (await ctx.db.get(task._id))!;
  if (fresh.status !== "open") await moveTaskStatus(ctx, fresh, "open", { actorUserId: userId, now });
}

/**
 * Drop at the change card (`cast line trial drop`, the trial graph's drop
 * station): the fix is rejected. What happens to the problem follows what it
 * holds. With live findings the fix did not answer, they stay open: the
 * problem goes back to the queue for a run from main (reopenProblem). With
 * none, nothing is left to fix and the problem closes as dropped.
 */
export async function dropAtCardCore(ctx: Ctx, userId: Id<"users">, ref: string, note: string | undefined, now = Date.now()) {
  const task: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
  const project = await trialProjectOf(ctx, task);
  if (!task || !project || !(await canAccessProject(ctx, userId, project))) throw new Error(`${ref} is not a problem in a trial project`);
  if (isTerminalTaskStatus(task.status)) return { task: task.short_id, closed: true, status: task.status, findings: 0, conversations: 0, card: null as string | null };
  const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
  const cards: Doc<"trial_cards">[] = run ? await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect() : [];
  const row = cards.filter((c) => c.kind === "card").sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  const conversations = new Set(live.map((s) => findingConversation({ ...s, _id: String(s._id) }))).size;
  const said = note?.trim() ? ` ${note.trim().slice(0, 2000)}` : "";
  const at = row ? ` (${row.short_id})` : "";
  if (live.length) {
    await reopenProblem(ctx, userId, task, run, row, `Trial: the fix was dropped at the card${at}; the problem stays open. Its ${live.length} finding${live.length === 1 ? "" : "s"} in ${conversations} conversation${conversations === 1 ? "" : "s"} still need a fix, and it is due a new run from main. The dropped branch stays local.${said}`, now);
    return { task: task.short_id, closed: false, status: "open", findings: live.length, conversations, card: row?.short_id ?? null };
  }
  const closing = `Trial: dropped at the card${at}. The fix was rejected and the problem holds no findings, so it is closed. The branch stays local.${said}`;
  await moveTaskStatus(ctx, task, "dropped", { actorUserId: userId, now, closedAt: now, ...(task.cause ? { extra: { cause: { ...task.cause, dissolved: { at: now, note: closing } } } } : {}) });
  await retireOnClose(ctx, (await ctx.db.get(task._id))!, now);
  await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: closing });
  return { task: task.short_id, closed: true, status: "dropped", findings: 0, conversations: 0, card: row?.short_id ?? null };
}

/** `cast line trial drop <ct-N> [-m note]`: the trial graph's drop station. */
export const dropAtCardForCli = mutation({
  args: { ...scopeArgs, task: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    return dropAtCardCore(ctx, userId, args.task, args.note);
  },
});

/** How much of the stopped station's report the new-approach note carries. */
const NEW_APPROACH_REPORT_MAX = 3000;

/**
 * `newApproach`: a person read that the stopped station's approach did not work and asked for a different one. The
 * rerun is the same run from main; the ask and the station's report land on the problem as a note, so the record says
 * why the next run exists, and the run's own $cause_history carries the report (lineWorkspace.causeHistoryForTask).
 */
/** A trial problem by its id or short id, with its project, for a person who can reach that project. */
async function trialProblemOf(ctx: Ctx, userId: Id<"users">, ref: string): Promise<{ task: Doc<"tasks">; project: Doc<"projects"> }> {
  const id = ctx.db.normalizeId("tasks", ref);
  const task: Doc<"tasks"> | null = id ? await ctx.db.get(id) : await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
  const project = await trialProjectOf(ctx, task);
  if (!task || !project || !(await canAccessProject(ctx, userId, project))) throw new Error(`${ref} is not a problem in a trial project`);
  return { task, project };
}

export async function rerunCore(ctx: Ctx, userId: Id<"users">, ref: string, now = Date.now(), reask = false, at?: string, asker?: string, entry?: string, newApproach = false) {
  const { task, project } = await trialProblemOf(ctx, userId, ref);
  if (isTerminalTaskStatus(task.status)) throw new Error(`${task.short_id} is ${task.status}: a closed problem is not run again`);
  const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
  // A run waiting at a card asked again on the stations as they are now (the CLI stops its runner first): its card closes, a new one is asked.
  if (reask) {
    const asked: Doc<"session_decisions"> | null = run?.gate_decision_id ? await ctx.db.get(run.gate_decision_id) : null;
    if (!run || run.status !== "paused" || !run.gate_node_id || (run.gate_decision_id && !asked?.trial)) throw new Error(`${task.short_id}'s run is not waiting at a trial card`);
    if (!run.runner_device) throw new Error(`${task.short_id}'s run names no machine`);
    const cards: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect();
    const waiting = cards.filter((c) => c.status === "waiting" && c.node_id === run.gate_node_id).sort((a, b) => b.created_at - a.created_at)[0] ?? null;
    // A change card whose build no longer answers what its problem holds is not worded again (ct-59433: one build, six cards): the
    // run goes back to work on the findings as they are now, unless the caller names the station itself (`at`).
    const route = !at?.trim() && waiting ? await reaskRoute(ctx, task, waiting) : { to: "card" as const };
    if (route.to === "main") {
      // Its fix reaches nothing here: the run ends, and the problem is due a run from main (dueProblems), under the dispatcher's own limits.
      await reopenProblem(ctx, userId, task, run, waiting!, `Asked again (${waiting!.short_id}): ${route.why}. The fix is set aside on its branch and the problem is due a new run from main.`, now);
      return { task: task.short_id, run_id: run._id, resumed_at: null as string | null, rebuild: "main" as const, why: route.why };
    }
    if (route.to === "investigate" && !entry?.trim()) throw new Error(`${task.short_id}: ${route.why}, so its run goes back to work on them, and the caller names the graph's first station for that (cast flow trial rerun ${task.short_id} --reask does)`);
    const refused = rerunRefusal(await trialRoom(ctx, project, now, undefined, run.runner_device ? [run.runner_device] : []), false);
    if (refused) throw new Error(refused);
    // A gate whose station asks it (`asker=`, read from the graph by the CLI) is asked again by that station, which writes its decision anew.
    const node = route.to === "investigate" ? entry!.trim() : at?.trim() || asker?.trim() || run.gate_node_id;
    for (const c of cards) if (c.status === "waiting") await ctx.db.patch(c._id, { status: "closed", updated_at: now });
    await resumeRunAt(ctx as any, userId, run, node, now);
    // Taken back once the run no longer waits on it, so the withdrawal cannot fail the run.
    if (asked?.status === "pending") await withdrawCore(ctx, asked as any, now);
    if (route.to === "investigate") await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: `Asked again (${waiting!.short_id}): ${route.why}. The run reads the problem again and works on the findings as they are now, on its branch.` });
    return { task: task.short_id, run_id: run._id, resumed_at: node, ...(route.to === "investigate" ? { rebuild: "investigate" as const, why: route.why } : {}) };
  }
  // A failed run tried again at a station its lead names, on its own branch, as a new attempt under the trial's
  // limits (failedRunResume.resumeFailedRunCore).
  if (at?.trim()) {
    if (!run || run.status !== "failed") throw new Error(`${task.short_id}'s run ${run ? `is ${run.status}` : "does not exist"}; --at resumes a failed run (a run waiting at a card is asked again with --reask --at)`);
    if (!run.runner_device) throw new Error(`${task.short_id}'s run names no machine`);
    const refused = rerunRefusal(await trialRoom(ctx, project, now, undefined, [run.runner_device]), false);
    if (refused) throw new Error(refused);
    await resumeRunAt(ctx as any, userId, run, at.trim(), now, { newAttempt: true });
    return { task: task.short_id, run_id: run._id, resumed_at: at.trim() };
  }
  if (!run || !(run.status === "failed" || stopOf(run, task.status))) throw new Error(`${task.short_id}'s run ${run ? `is ${run.status}` : "does not exist"}; only a failed or stopped run is rerun here`);
  // A run no machine ever claimed (the daemon took it and its runner died first) is started the way the dispatcher
  // starts one: from its route's newest run that names a machine.
  const from = run.runner_device ? run : (await dueProblems(ctx, project)).like[routeOf(task)];
  if (!from?.runner_device) throw new Error(`${task.short_id}'s run names no machine, nor does any earlier run on its route: start it with cast flow trial run ${task.short_id}`);
  const lost = await gateLossOf(ctx, run);
  const refused = rerunRefusal(await trialRoom(ctx, project, now, undefined, [from.runner_device]), !lost);
  if (refused) throw new Error(refused);
  if (lost) {
    await resumeRunAt(ctx as any, userId, run, lost.node, now);
    return { task: task.short_id, run_id: run._id, resumed_at: lost.node };
  }
  const run_id = await queueTrialRun(ctx, userId, task, from, from.runner_device, now);
  const stop = newApproach ? stopOf(run, task.status) : null;
  if (stop) {
    const report = task.verification_evidence?.trim() ?? "";
    const station = stop.station.replace(/_/g, " ");
    await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: `New approach asked: ${station}'s approach did not work, so the next run proposes a different one rather than building it again.${report ? `\n\n${station}'s report:\n\n${report.slice(0, NEW_APPROACH_REPORT_MAX)}` : ""}` });
  }
  return { task: task.short_id, run_id, resumed_at: null as string | null };
}

/**
 * A problem started again from main on its line as it is now (`cast line trial rerun <ct-N> --fresh`), wherever its
 * run stands: working, waiting at a card, failed. The run ends, its fix is set aside on its branch and its waiting
 * cards close (reopenProblem), and a run of the route's graph is queued on the same machine, from origin/main
 * (queueTrialRun). For a run made on stations that have since changed: picked up where it stood, it builds on the
 * fix the old stations made (ct-59945: Prove refused a branch 330 commits behind main that held the old fix). The
 * CLI stops the run's runner first.
 */
export async function rerunFromMainCore(ctx: Ctx, userId: Id<"users">, ref: string, now = Date.now()) {
  const { task, project } = await trialProblemOf(ctx, userId, ref);
  if (isTerminalTaskStatus(task.status)) throw new Error(`${task.short_id} is ${task.status}: a closed problem is not run again`);
  const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
  const from = run?.runner_device ? run : (await dueProblems(ctx, project)).like[routeOf(task)];
  if (!from?.runner_device) throw new Error(`${task.short_id}'s run names no machine, nor does any earlier run on its route: start it with cast flow trial run ${task.short_id}`);
  // Ended before the room is counted, so the run it replaces holds no place; a refusal below rolls this back.
  if (run && isLiveRunStatus(run.status)) await cancelCore(ctx as any, run, now, "Stopped: the problem was started again from main");
  const refused = rerunRefusal(await trialRoom(ctx, project, now, undefined, [from.runner_device]), true);
  if (refused) throw new Error(refused);
  const cards: Doc<"trial_cards">[] = run ? await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect() : [];
  for (const c of cards) if (c.status === "waiting") await ctx.db.patch(c._id, { status: "closed", updated_at: now });
  const card = cards.filter((c) => c.kind === "card").sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  await reopenProblem(ctx, userId, task, run, card, `Started again from main on the flow as it is now${card ? ` (${card.short_id} closed)` : ""}. The earlier run's fix is set aside on its branch.`, now);
  const run_id = await queueTrialRun(ctx, userId, (await ctx.db.get(task._id))!, from, from.runner_device, now);
  return { task: task.short_id, run_id, resumed_at: null as string | null, set_aside: run?._id ?? null };
}

/**
 * Close a problem whose run stopped (a failure station, the problem still open) because a person judged it not worth
 * another run: it closes as dropped and its findings retire with it, as a drop with nothing left does.
 */
export async function closeStoppedCore(ctx: Ctx, userId: Id<"users">, ref: string, now = Date.now()) {
  const { task } = await trialProblemOf(ctx, userId, ref);
  if (isTerminalTaskStatus(task.status)) return { task: task.short_id, status: task.status, retired: 0 };
  const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
  const stop = run ? stopOf(run, task.status) : null;
  if (!stop) throw new Error(`${task.short_id}'s run did not stop at a failure step; only a stopped run's problem is closed here`);
  const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  const closing = `Trial: closed by a person after ${stop.station.replace(/_/g, " ")} gave up. ${live.length ? `Its ${live.length} finding${live.length === 1 ? "" : "s"} close with it.` : "It held no findings."}`;
  await moveTaskStatus(ctx, task, "dropped", { actorUserId: userId, now, closedAt: now, ...(task.cause ? { extra: { cause: { ...task.cause, dissolved: { at: now, note: closing } } } } : {}) });
  const retired = await retireOnClose(ctx, (await ctx.db.get(task._id))!, now);
  await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: closing });
  return { task: task.short_id, status: "dropped", retired };
}

/** /trial's Close on a stopped run (dispatch trialClose). */
export const closeStopped = mutation({
  args: { task: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return closeStoppedCore(ctx, userId, args.task);
  },
});

export const rerun = mutation({
  // `new_approach`: the stopped station's approach did not work and a person asked for a different one (rerunCore).
  args: { task: v.string(), new_approach: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return rerunCore(ctx, userId, args.task, Date.now(), false, undefined, undefined, undefined, !!args.new_approach);
  },
});

/** `cast line trial rerun <ct-N>`: the review page's rerun, from a terminal. */
export const rerunForCli = mutation({
  // With reask. `at`: the station the caller chose to pick the run up at (always taken). `asker`: the station the gate names as
  // its asker, which asks it again. `entry`: the graph's first station, where a run sent back to work on changed findings starts (reaskRoute).
  // `fresh`: start the problem again from main, wherever its run stands (rerunFromMainCore).
  args: { ...scopeArgs, task: v.string(), reask: v.optional(v.boolean()), at: v.optional(v.string()), asker: v.optional(v.string()), entry: v.optional(v.string()), fresh: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    if (args.fresh) return rerunFromMainCore(ctx, userId, args.task);
    return rerunCore(ctx, userId, args.task, Date.now(), !!args.reask, args.at, args.asker, args.entry);
  },
});

/** `cast line trial runs`: each trial problem's latest run, as the review page's Failed and Stopped lists read them. */
export const runsForCli = query({
  args: { ...scopeArgs, project: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project)) || !project.line_trial) throw new Error(`No trial project "${args.project}" in this workspace`);
    const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
    const out = [];
    for (const task of tasks) {
      const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
      if (!run) continue;
      out.push({ task: task.short_id, title: task.title, run_id: run._id, status: run.status, node: run.current_node_id ?? null, fail_reason: run.status === "failed" ? run.fail_reason ?? null : null, lost_at_gate: isTerminalTaskStatus(task.status) ? null : await gateLossOf(ctx, run), runner_device: run.runner_device ?? null, updated_at: run.updated_at ?? run.created_at });
    }
    return out.sort((a, b) => b.updated_at - a.updated_at);
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

/** `reopened`: the card whose fix was set aside with findings left (a Drop at the card, a re-ask the fix no longer answered). */
export type DueProblem = { task: string; title: string; route: "judge" | "product"; findings: number; severity: number; regrouped: boolean; last_run: string | null; reopened?: string };

/**
 * A trial project's problems due a run, the most in need first (most live
 * findings, then the worst severity): open, holding live findings, with no
 * live run, and either never run or regrouped since their last run started
 * (cause.joined_at). A problem whose last run ended on a person's answer at a
 * card keeps that answer, unless that card's fix was set aside with findings
 * left (reopened_at): then the problem is due whatever the answer. Also: how
 * many runs hold a machine now, the newest run with a machine, whose graph
 * and checkout a dispatch reuses, and the runs still waiting at a gate on a
 * problem that is closed (`orphaned`: no card can answer them).
 */
export async function dueProblems(ctx: Ctx, project: Doc<"projects">) {
  const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
  const due: Array<DueProblem & { row: Doc<"tasks"> }> = [];
  let running = 0;
  // The newest run of each route's graph with a machine: a dispatch copies it. The judge
  // route's runs carry its graph's name; every other run is the product graph's.
  const like: Record<"judge" | "product", Doc<"workflow_runs"> | null> = { judge: null, product: null };
  const judgeName = project.line_trial?.judge?.name;
  // Runs that died waiting at their own card, oldest first: the dispatcher picks them up at that gate.
  const lost: Array<{ task: Doc<"tasks">; run: Doc<"workflow_runs">; loss: GateLoss }> = [];
  const orphaned: Array<{ task: Doc<"tasks">; run: Doc<"workflow_runs"> }> = [];
  for (const task of tasks) {
    const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
    const ran = run && judgeName && run.workflow_name === judgeName ? "judge" : "product";
    if (run?.runner_device && (!like[ran] || run.created_at > like[ran]!.created_at)) like[ran] = run;
    if (run?.status === "running" || run?.status === "pending") running++;
    if (run?.status === "paused" && isTerminalTaskStatus(task.status)) orphaned.push({ task, run });
    const loss = run?.runner_device && !isTerminalTaskStatus(task.status) ? await gateLossOf(ctx, run) : null;
    if (loss) lost.push({ task, run: run!, loss });
    if (isTerminalTaskStatus(task.status) || (run && isLiveRunStatus(run.status)) || loss) continue;
    // A problem whose last run took the other route's graph is due on its own route.
    const misrouted = !!run && (routeOf(task) === "judge") !== (!!judgeName && run.workflow_name === judgeName);
    let reopened: string | undefined;
    if (run && !misrouted) {
      const cards: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect();
      reopened = cards.filter((c) => c.reopened_at).sort((a, b) => b.reopened_at! - a.reopened_at!)[0]?.short_id;
      if (!reopened) {
        if (!task.cause?.joined_at || task.cause.joined_at <= run.created_at) continue;
        if (cards.some((c) => c.kind === "card" && c.status === "answered" && !c.answer?.stand_in)) continue;
      }
    }
    const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    if (!live.length) continue;
    due.push({ row: task, task: task.short_id, title: task.title, route: routeOf(task), findings: live.length, severity: Math.max(0, ...live.map((s) => s.severity ?? 0)), regrouped: !!run && !reopened, last_run: run?.status ?? null, ...(reopened ? { reopened } : {}) });
  }
  due.sort((a, b) => b.findings - a.findings || b.severity - a.severity || a.row.created_at - b.row.created_at);
  lost.sort((a, b) => (a.run.updated_at ?? a.run.created_at) - (b.run.updated_at ?? b.run.created_at));
  return { due, running, like, lost, orphaned };
}

/**
 * Runs still waiting at a gate on a problem that is closed (merged away or
 * dropped while the run stood somewhere a close does not stop it, or before a
 * close stopped trial runs at all: ct-59242, ct-59534) end here: no card of
 * theirs can be answered, so they would hold a place in the runs list forever.
 */
async function endOrphaned(ctx: Ctx, orphaned: Array<{ task: Doc<"tasks">; run: Doc<"workflow_runs"> }>, now: number): Promise<string[]> {
  for (const o of orphaned) await cancelCore(ctx as any, o.run, now, `Stopped: the problem was ${o.task.cause?.merged_into ? "merged into another" : o.task.status === "dropped" ? "dropped" : "closed"} while the run waited`);
  return orphaned.map((o) => o.task.short_id);
}

/**
 * One dispatch pass over a trial project: start its most-needed due problems
 * while fewer than TRIAL_RUNNING_CAP runs hold the machine, the subscription
 * accounts its runs use have quota, and the trial's billed money, the runs in
 * flight at the average run's billed cost, and the next run's stay under the
 * project's cap. Writes what it did (or why it held) on the project only when
 * that changed.
 */
export async function dispatchPass(ctx: Ctx, project: Doc<"projects">, now: number, dry = false) {
  const dispatch = project.line_trial?.dispatch;
  if (!dispatch) throw new Error(`${project.title} does not dispatch: cast flow trial dispatch on --project "${project.title}" --cap <usd>`);
  const { due, running, like, lost, orphaned } = await dueProblems(ctx, project);
  const ended = dry ? orphaned.map((o) => o.task.short_id) : await endOrphaned(ctx, orphaned, now);
  const devices = Object.values(like).flatMap((r) => (r?.runner_device ? [r.runner_device] : []));
  const { spend, perRun, room, runsLeft, quota, quotaHold: waitQuota } = await trialRoom(ctx, project, now, running, devices);
  const slots = Math.max(0, TRIAL_RUNNING_CAP - running);
  const affordable = waitQuota ? 0 : runsAffordable(room, perRun);
  // A run that died waiting at its own card picks up at that gate first: its evidence is made, and it is the same run (no run of max_runs).
  const r = Math.min(slots, lost.length, affordable);
  const resumed: string[] = [];
  if (!dry) for (const l of lost.slice(0, r)) {
    await resumeRunAt(ctx as any, project.line_trial!.by, l.run, l.loss.node, now);
    resumed.push(l.task.short_id);
  }
  // A proposal that recommends waiting goes back for the evidence the pipeline can gather first; each takes a slot like a start.
  const waits = await gatherDue(ctx, project);
  const g = Math.min(slots - r, waits.length, affordable - r);
  const gathering: string[] = [];
  if (!dry) for (const w of waits.slice(0, g)) gathering.push((await answerTrialCardCore(ctx, project.line_trial!.by, w.short_id, "R", GATHER_NOTE, now, true)).short_id);
  // Each problem starts its own route's graph, copied from that route's newest run with a machine.
  const startable = due.filter((d) => like[d.route]);
  const n = Math.max(0, Math.min(slots - r - g, startable.length, affordable - r - g, runsLeft));
  let held: string | undefined;
  const unstarted = [...new Set(due.filter((d) => !like[d.route]).map((d) => d.route))];
  if (unstarted.length) held = `no earlier ${unstarted.map((r) => (r === "judge" ? "judge-route" : "product")).join(" or ")} run names a machine: start one with cast flow trial run`;
  else if (waitQuota && (startable.length || lost.length || waits.length)) held = waitQuota;
  else if (startable.length > n && n === runsLeft) held = `${spend.runs} of ${dispatch.max_runs} runs used: the trial starts no more`;
  else if (startable.length > n && n < slots) held = capHold(spend.billed.usd, dispatch.cap_usd, perRun);
  const started: string[] = [];
  if (!dry) {
    for (const d of startable.slice(0, n)) {
      const from = like[d.route]!;
      await queueTrialRun(ctx, project.line_trial!.by, d.row, from, from.runner_device!, now);
      started.push(d.task);
    }
  }
  const last = dispatch.last;
  if (!dry && (started.length || gathering.length || resumed.length || held !== last?.held)) {
    await ctx.db.patch(project._id, { line_trial: { ...project.line_trial!, dispatch: { ...dispatch, last: { at: now, started: [...resumed, ...started, ...gathering], ...(held ? { held } : {}) } } } });
  }
  return {
    project: project.title,
    cap_usd: dispatch.cap_usd,
    max_runs: dispatch.max_runs ?? null,
    runs: spend.runs,
    /** Money billed so far: the cap limits this alone. */
    billed_usd: spend.billed.usd,
    /** A run's average billed money (its sessions on metered keys). */
    per_run_usd: Math.round(perRun * 100) / 100,
    /** The subscription accounts the runs use, and how much of each window is spent. */
    quota,
    running,
    cap: TRIAL_RUNNING_CAP,
    started,
    /** Runs that died waiting at their own card, picked up at that gate (resumeRunAt), or due to be on a dry pass. */
    resumed: dry ? lost.slice(0, r).map((l) => l.task.short_id) : resumed,
    /** Proposal cards sent back to gather their own evidence (gatherDue), or due to be on a dry pass. */
    gathering: dry ? waits.slice(0, g).map((w) => w.short_id) : gathering,
    held: held ?? null,
    /** Runs that waited at a gate on a closed problem, ended on this pass (or due to be on a dry one). */
    ended,
    due: due.map(({ row: _row, ...d }) => d),
  };
}

/**
 * The stand-in's answer to a proposal that recommends waiting: the run goes
 * back to its proposal with this note, so the evidence the pipeline can make
 * itself is made before a person is asked. Once per run (gatherDue).
 */
/** The note's opening words, the same in every version of it: a run sent back once under any of them is not sent again. */
const GATHER_LEAD = "Gather before asking:";
export const GATHER_NOTE = "Gather before asking: the proposal recommends waiting for more evidence. Make what evidence the pipeline can make itself now (replay, read-only, the cases your proof or investigation already found, and count how many show the miss), then propose again with that result in the proposal, the card's measured count (how many of how many, over what, by replay or a production read), its proof and its recommendation. Recommend waiting only for evidence no replay or read can produce, such as a new real case.";

/** Waiting proposal cards whose own recommendation is to wait, on runs paused at them and not yet sent back to gather. */
export async function gatherDue(ctx: Ctx, project: Doc<"projects">): Promise<Doc<"trial_cards">[]> {
  const rows: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).collect();
  const out: Doc<"trial_cards">[] = [];
  for (const row of rows) {
    if (row.status !== "waiting" || row.kind !== "gate" || (row.proposal as ProposalCard | undefined)?.recommend?.verdict !== "wait") continue;
    if (rows.some((o) => String(o.run_id) === String(row.run_id) && o.answer?.note?.startsWith(GATHER_LEAD))) continue;
    const run: Doc<"workflow_runs"> | null = await ctx.db.get(row.run_id);
    if (!run || run.status !== "paused" || run.gate_node_id !== row.node_id || (run.gate_decision_id && String(run.gate_decision_id) !== String(row.decision_id))) continue;
    out.push(row);
  }
  return out.sort((a, b) => a.created_at - b.created_at);
}

/**
 * `cast line trial sweep`: end the runs still waiting on closed problems now
 * (endOrphaned, which the dispatcher also does each pass), close the cards
 * still waiting on closed problems, and name every closed problem's ended run, so the machine that ran it releases its
 * worktree (the branch stays).
 */
export const sweepForCli = mutation({
  // `only`: the problems named on the command line; their cards alone close.
  args: { ...scopeArgs, project: v.string(), dry: v.optional(v.boolean()), only: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const { project } = await trialProjectForCli(ctx, args);
    return sweepClosed(ctx, project, Date.now(), !!args.dry, args.only?.length ? args.only : undefined);
  },
});

export async function sweepClosed(ctx: Ctx, project: Doc<"projects">, now: number, dry: boolean, only?: string[]) {
  const { orphaned } = await dueProblems(ctx, project);
  const ended = dry ? orphaned.map((o) => o.task.short_id) : await endOrphaned(ctx, orphaned, now);
  const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
  // A closed problem asks nothing (sessionDecisions.withdrawClosedProblemAsks, which every close now runs): this
  // settles problems closed before it, and a card still waiting on one closes however its run ended.
  const shut = tasks.filter((t) => isTerminalTaskStatus(t.status) && (!only || only.includes(t.short_id)));
  const shutIds = new Set(shut.map((t) => String(t._id)));
  const cards: Doc<"trial_cards">[] = (await ctx.db.query("trial_cards").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).collect())
    .filter((c: Doc<"trial_cards">) => c.status === "waiting" && shutIds.has(String(c.task_id)));
  const withdrawn: string[] = [];
  if (!dry) {
    for (const t of shut) withdrawn.push(...(await withdrawClosedProblemAsks(ctx, t, t.cause?.dissolved?.note ?? `the problem was ${t.status === "done" ? "closed as done" : t.status}`, now)));
    for (const c of cards) await ctx.db.patch(c._id, { status: "closed", updated_at: now });
  }
  const closed: Array<{ task: string; status: string; run_id: string; run_status: string; workflow_name: string; project_path: string | null; runner_device: string | null }> = [];
  for (const task of tasks) {
    if (!isTerminalTaskStatus(task.status)) continue;
    const newest: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
    if (!newest) continue;
    // A runner on older code reported the gate it lost over the reason its run was ended for: the close is why.
    if (!dry && newest.status === "failed" && /^no outgoing edge from \S+ \(outcome failure\b/.test(newest.fail_reason ?? "")) {
      await ctx.db.patch(newest._id, { fail_reason: `Stopped: the problem was ${task.cause?.merged_into ? "merged into another" : task.status === "dropped" ? "dropped" : "closed"} while the run waited` });
    }
    const status = ended.includes(task.short_id) && !dry ? "failed" : newest.status;
    closed.push({ task: task.short_id, status: task.status, run_id: newest._id, run_status: status, workflow_name: newest.workflow_name ?? "workflow", project_path: newest.project_path ?? null, runner_device: newest.runner_device ?? null });
  }
  return { project: project.title, ended, closed, cards_closed: cards.map((c) => c.short_id), withdrawn };
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

/** `cast line trial dispatch on|off --project <ref> [--cap <usd>] [--max-runs <n>]`: the trial starts its own runs under a cap on billed money (and a run count), or stops. */
export const setDispatch = mutation({
  args: { ...scopeArgs, project: v.string(), cap_usd: v.optional(v.number()), max_runs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
    if (!project.line_trial) throw new Error(`${project.title} is not a trial project`);
    if (args.cap_usd !== undefined && !(args.cap_usd > 0)) throw new Error("--cap is a positive number of dollars");
    if (args.max_runs !== undefined && !(Number.isInteger(args.max_runs) && args.max_runs >= 0)) throw new Error("--max-runs is a whole number of runs");
    if (args.max_runs !== undefined && args.cap_usd === undefined) throw new Error("--max-runs goes with --cap");
    const { dispatch: _was, ...rest } = project.line_trial;
    const line_trial = args.cap_usd !== undefined ? { ...rest, dispatch: { cap_usd: args.cap_usd, ...(args.max_runs !== undefined ? { max_runs: args.max_runs } : {}) } } : rest;
    await ctx.db.patch(project._id, { line_trial, updated_at: Date.now() });
    return { project: project.title, cap_usd: args.cap_usd ?? null, max_runs: args.max_runs ?? null };
  },
});

/**
 * /trial's "Raise the limits…" (dispatch trialRaiseLimits): a person lifts the run limit and the spend cap its
 * dispatcher held at. Only raises: lowering a limit stops runs and stays the CLI's (setDispatch). The hold its last
 * pass recorded named the old limits, so it goes; the next pass (every 10 minutes) starts what the new ones allow,
 * or records the hold that still stands.
 */
export const raiseLimits = mutation({
  args: { project: v.string(), max_runs: v.number(), cap_usd: v.number() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const id = ctx.db.normalizeId("projects", args.project);
    const project = id ? await ctx.db.get(id) : null;
    if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error("No such project");
    const d = project.line_trial?.dispatch;
    if (!project.line_trial || !d) throw new Error(`${project.title} has no dispatcher`);
    if (!Number.isInteger(args.max_runs) || args.max_runs < (d.max_runs ?? 0)) throw new Error("The run limit only goes up from here");
    if (!(args.cap_usd >= d.cap_usd)) throw new Error("The spend cap only goes up from here");
    const { last, ...rest } = d;
    const dispatch = { ...rest, cap_usd: args.cap_usd, max_runs: args.max_runs, ...(last ? { last: { at: last.at, started: last.started } } : {}) };
    await ctx.db.patch(project._id, { line_trial: { ...project.line_trial, dispatch }, updated_at: Date.now() });
    return { project: project.title, cap_usd: args.cap_usd, max_runs: args.max_runs };
  },
});

/**
 * `cast line trial spend add <usd> <what> --billed-by <key>`: money the trial
 * was billed outside codecast's accounting (a shadow harness or evals on an API
 * key). It joins the trial's billed money, which the dispatcher's cap reads.
 * Subscription use (a dry run on a Claude login) bills nothing and is not
 * recorded here.
 */
/** The same spend recorded twice in this window is a repeat, not new spend: `spend add` refuses it unless forced. */
export const OUTSIDE_REPEAT_MS = 60 * 60_000;

export function repeatedOutside(outside: Array<{ usd: number; what: string; at: number }>, usd: number, what: string, now: number) {
  return outside.find((o) => o.usd === usd && o.what === what && now - o.at < OUTSIDE_REPEAT_MS) ?? null;
}

async function trialProjectForCli(ctx: Ctx, args: Record<string, any>) {
  const { userId, workspaceKey } = await scopeOf(ctx as any, args as any);
  const project = await resolveWorkspaceProject(ctx as any, workspaceKey, args.project);
  if (!project || !(await canAccessProject(ctx as any, userId, project))) throw new Error(`No project "${args.project}" in this workspace`);
  if (!project.line_trial) throw new Error(`${project.title} is not a trial project`);
  return { userId, project: project as Doc<"projects"> & { line_trial: NonNullable<Doc<"projects">["line_trial"]> } };
}

export const addOutsideSpend = mutation({
  args: { ...scopeArgs, project: v.string(), usd: v.number(), what: v.string(), billed_by: v.optional(v.string()), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { userId, project } = await trialProjectForCli(ctx, args);
    if (!(args.usd > 0) || args.usd > 10_000) throw new Error("The amount is dollars, above 0");
    const what = args.what.trim().slice(0, 200);
    if (!what) throw new Error("Say what it was spent on");
    const billed_by = args.billed_by?.trim().slice(0, 60);
    if (!billed_by) throw new Error("Name the key or account that billed it (--billed-by, e.g. \"evals key\" or \"openrouter\")");
    const now = Date.now();
    const usd = Math.round(args.usd * 100) / 100;
    const twice = repeatedOutside(project.line_trial.outside ?? [], usd, what, now);
    if (twice && !args.force) throw new Error(`$${usd} for "${what}" was recorded ${Math.round((now - twice.at) / 60_000)} min ago (at ${twice.at}); pass --force if this is new spend`);
    const outside = [...(project.line_trial.outside ?? []), { usd, what, billed_by, at: now, by: userId }];
    await ctx.db.patch(project._id, { line_trial: { ...project.line_trial, outside }, updated_at: now });
    const spend = await trialSpend(ctx, { ...project, line_trial: { ...project.line_trial, outside } }, now);
    return { project: project.title, added_usd: usd, billed_by, key_usd: spend.billed.keys.find((k) => k.billed_by === billed_by)?.usd ?? usd, billed_usd: spend.billed.usd, cap_usd: project.line_trial.dispatch?.cap_usd ?? null };
  },
});

/** Names the biller of hand entries recorded before entries named one: those whose words contain `match` (run from the dashboard or run.sh). */
export const nameOutsideBillers = internalMutation({
  args: { project: v.id("projects"), match: v.string(), billed_by: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.project);
    if (!project?.line_trial?.outside) return 0;
    let named = 0;
    const outside = project.line_trial.outside.map((o) => (o.billed_by || !o.what.includes(args.match) ? o : (named++, { ...o, billed_by: args.billed_by })));
    if (named) await ctx.db.patch(project._id, { line_trial: { ...project.line_trial, outside } });
    return named;
  },
});

/** `cast line trial spend rm <at>`: one outside entry taken back (recorded twice, or wrong), named by its time. */
export const removeOutsideSpend = mutation({
  args: { ...scopeArgs, project: v.string(), at: v.number() },
  handler: async (ctx, args) => {
    const { project } = await trialProjectForCli(ctx, args);
    const was = project.line_trial.outside ?? [];
    const gone = was.find((o) => o.at === args.at);
    if (!gone) throw new Error(`No outside spend recorded at ${args.at} (cast flow trial --json lists spend.outside)`);
    const outside = was.filter((o) => o !== gone);
    const now = Date.now();
    await ctx.db.patch(project._id, { line_trial: { ...project.line_trial, outside }, updated_at: now });
    const spend = await trialSpend(ctx, { ...project, line_trial: { ...project.line_trial, outside } }, now);
    return { project: project.title, removed: { usd: gone.usd, what: gone.what, billed_by: gone.billed_by ?? UNNAMED_BILLER, at: gone.at }, billed_usd: spend.billed.usd };
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
  args: { ...scopeArgs, card: v.string(), change_card: v.optional(v.any()), proposal: v.optional(v.any()), judge_fix: v.optional(v.any()), options: v.optional(v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) }))) },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    const row: Doc<"trial_cards"> | null = await ctx.db.query("trial_cards").withIndex("by_short_id", (q: any) => q.eq("short_id", args.card)).first();
    const project = row ? await ctx.db.get(row.project_id) : null;
    if (!row || !project || !(await canAccessProject(ctx, userId, project))) throw new Error("Trial card not found");
    // Options are replaced only when given, keyed the same as the ones they replace, so the answer rides the same edges.
    let options = row.options;
    if (args.options) {
      const had = row.options;
      if (!had) throw new Error(`${row.short_id}'s options are its session's decision: change them there (cast decide edit)`);
      const keys = (o: Array<{ key: string }>) => o.map((x) => x.key.toUpperCase()).sort().join();
      if (keys(args.options) !== keys(had)) throw new Error(`Options must keep the keys ${keys(had)}`);
      options = args.options.map((o) => ({ key: o.key, label: stripKey(o.label), ...(o.description ? { description: o.description } : {}) }));
    }
    // A proposal gate's card: what the gate asked stays as it was; the card is how it reads.
    if (args.proposal !== undefined) {
      if (row.kind !== "gate") throw new Error(`${row.short_id} is a change card, not a proposal gate`);
      const p = validateProposalCard(args.proposal, { line: true });
      if (!p.ok) throw new Error(`The proposal card is not ready:\n  ${p.errors.join("\n  ")}`);
      await ctx.db.patch(row._id, { proposal: p.card, options, carded_at: Date.now(), updated_at: Date.now() });
      return { short_id: row.short_id, headline: p.card.question, checks: [] as string[] };
    }
    // A judge fix measured again (split, its cases changed, or built on another waiting fix): same gate, same keys.
    if (args.judge_fix !== undefined) {
      if (!row.judge_fix || row.status !== "waiting") throw new Error(`${row.short_id} is not a waiting judge-fix card`);
      const f = validateJudgeFixCard(args.judge_fix);
      if (!f.ok) throw new Error(`The judge-fix card is not ready:\n  ${f.errors.join("\n  ")}`);
      if (f.card.problem !== (await ctx.db.get(row.task_id))?.short_id) throw new Error(`The card is for ${f.card.problem}, not ${row.short_id}'s problem`);
      await ctx.db.patch(row._id, { judge_fix: f.card, options, ...(row.decision_id ? {} : { question: f.card.question }), updated_at: Date.now() });
      return { short_id: row.short_id, headline: f.card.change, checks: [`A/B ${f.card.ab.verdict}`] };
    }
    if (row.kind !== "card" || row.status !== "waiting") throw new Error(`${row.short_id} is not a waiting change card`);
    const checked = validateChangeCard(args.change_card);
    if (!checked.ok) throw new Error(`The card is not ready:\n  ${checked.errors.join("\n  ")}`);
    if (checked.card.cause.task !== (await ctx.db.get(row.task_id))?.short_id) throw new Error(`The card is for ${checked.card.cause.task}, not ${row.short_id}'s problem`);
    await ctx.db.patch(row._id, { card: checked.card, options, ...(row.decision_id ? {} : { question: `Ship this change? ${checked.card.headline ?? ""}`.trim() }), updated_at: Date.now() });
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
  // `from`: verify, when the branch was already brought onto main outside the run and only needs proving again.
  args: { ...scopeArgs, card: v.string(), from: v.optional(v.union(v.literal("fresh"), v.literal("verify"))) },
  handler: async (ctx, args) => {
    const { userId } = await scopeOf(ctx, args);
    const row: Doc<"trial_cards"> | null = await ctx.db.query("trial_cards").withIndex("by_short_id", (q: any) => q.eq("short_id", args.card)).first();
    const project = row ? await ctx.db.get(row.project_id) : null;
    if (!row || !project || !(await canAccessProject(ctx, userId, project))) throw new Error("Trial card not found");
    if (row.kind !== "card" || row.status !== "waiting") throw new Error(`${row.short_id} is not a waiting change card`);
    const stale = ((row.card as ChangeCard | undefined)?.checks ?? []).find((c) => c.name === BASE_CHECK && !c.ok);
    if (!stale) throw new Error(`${row.short_id}'s branch is up to date with main: nothing to rebuild`);
    const run: Doc<"workflow_runs"> | null = await ctx.db.get(row.run_id);
    // Sent again while the rebuild has not reached its next card (its resume could not start, or stopped) is the same rebuild, from fresh.
    const again = !!row.rebuild_at && (run?.status === "running" || run?.status === "pending");
    if (!run || (!again && (run.status !== "paused" || run.gate_node_id !== row.node_id))) throw new Error(`${row.short_id}'s run is not waiting on it`);
    if (!run.runner_device) throw new Error(`${row.short_id}'s run names no machine`);
    const now = Date.now();
    // An older run may stand on a graph from before the fresh station: it resumes on the project's current product graph,
    // read again from its file (fresh_branch makes the daemon re-read it; on a resume it never resets the branch).
    const current = (await dueProblems(ctx, project)).like.product;
    const graph = current && current.workflow_id !== run.workflow_id ? { workflow_id: current.workflow_id, workflow_name: current.workflow_name } : {};
    await ctx.db.patch(run._id, { ...graph, fresh_branch: true, status: "running", current_node_id: args.from ?? "fresh", gate_node_id: undefined, gate_prompt: undefined, gate_choices: undefined, gate_response: undefined, updated_at: now });
    await ctx.db.patch(row._id, { rebuild_at: now, updated_at: now });
    await queueRunOnDaemon(ctx as any, userId, run._id, { device: run.runner_device, now });
    return { short_id: row.short_id, run_id: run._id, stale: stale.detail };
  },
});

