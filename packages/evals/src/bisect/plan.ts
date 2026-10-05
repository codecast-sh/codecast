import { attributionSearchable, type Attribution, type BisectPlan, type Candidate, type CostBound, type RenderClass, type RunRow } from '@codecast/shared/contracts/evalsApi';
import { formatCost } from '@platform/cli-kit/format';

import { repPassed } from '../adapters/replay';
import { attribute, largestDrops, type AttributionGit } from '../history/attribution';
import { gradedSet } from '../history/flips';
import type { PromptReader } from '../history/epochs';
import type { HeadsFile } from '../provenance';
import { surfaceMeta } from '../registry';
import { perRepUsd, readState, type EvalsState } from '../state';
import { separate } from '../stats';
import { candidateKey, mapToClass, renderClasses, type ProbeEnv, type RenderHook } from './probe';

// A bisect's plan: Tier 0's answer from the records, the freezes a probe
// replays (the flipped ones and two stable controls), the candidate commits
// folded into render classes by Tier 1, and the most it can spend. The cost
// bound is shown before Start and enforced by check --budget:
//
//   C = render classes left after Tier 0 narrowing and Tier 1 collapse
//   P = ceil(log2(C + 1))
//   F = freezes in the set, r = reps per probe
//   reps <= (2 + P) x F x (r + 2)  +  2 x (F + 2) x 5
//   usd  <= reps x (model usd per rep + judge usd per rep)

export const DEFAULT_REPS = 3;
export const CONFIRM_REPS = 5;
export const CONTROL_FREEZES = 2;
export const DEFAULT_MAX_MINUTES = 120;
/** The default budget over the bound. */
export const BUDGET_HEADROOM = 1.2;

export interface PlanArgs {
  surface: string;
  /** A batch name or a sha; found from the records when left out. */
  good?: string;
  bad?: string;
  /** Limit the search to these freezes (ids or id prefixes). */
  freezes?: string[];
  /** The control freezes exactly, when a plan is rebuilt from itself (`argsOf`); else they are picked from the records, within `freezes`. */
  controls?: string[];
  reps?: number;
  budgetUsd?: number;
  maxMinutes?: number;
  allCommits?: boolean;
}

/** What the plan reads beyond its args; every field has a real default. */
export interface PlanWorld {
  rows: RunRow[];
  git?: AttributionGit;
  heads?: HeadsFile | null;
  reader?: PromptReader;
  state?: EvalsState;
}

export function costBound(o: { classes: number; freezes: number; reps: number; perRepUsd: number; judgePerRepUsd: number }): CostBound {
  const probes = o.classes > 0 ? Math.ceil(Math.log2(o.classes + 1)) : 0;
  const maxReps = o.classes > 0 ? (2 + probes) * o.freezes * (o.reps + 2) + 2 * (o.freezes + 2) * CONFIRM_REPS : 0;
  return { classes: o.classes, probes, freezes: o.freezes, reps: o.reps, maxReps, perRepUsd: o.perRepUsd, judgePerRepUsd: o.judgePerRepUsd, maxUsd: maxReps * (o.perRepUsd + o.judgePerRepUsd) };
}

/** The judge's average spend per graded rep on this model, from the newest 50 such reps; 0 before any. */
export function judgeUsdPerRep(rows: RunRow[], model: string | null): number {
  const graded = rows.filter((r) => (r.status === 'pass' || r.status === 'fail') && (!model || r.model === model)).slice(0, 50);
  return graded.length ? graded.reduce((t, r) => t + r.judgeCostUsd, 0) / graded.length : 0;
}

/**
 * Two stable controls: freezes both endpoints graded, outside the focus,
 * that passed by majority on both sides, the most decisive first. They catch
 * a tool or judge drift that the flipped freezes alone would read as source.
 */
export function controlFreezes(good: RunRow[], bad: RunRow[], focus: string[], k = CONTROL_FREEZES): string[] {
  const rate = (s: RunRow[], f: string) => {
    const reps = s.filter((r) => r.freezeId === f);
    return reps.length ? reps.filter(repPassed).length / reps.length : 0;
  };
  const both = [...new Set(bad.map((r) => r.freezeId))].filter((f) => !focus.includes(f) && good.some((r) => r.freezeId === f));
  return both
    .map((f) => ({ f, at: Math.min(rate(good, f), rate(bad, f)) }))
    .filter((x) => x.at > 0.5)
    .sort((a, b) => b.at - a.at || a.f.localeCompare(b.f))
    .slice(0, k)
    .map((x) => x.f);
}

/** The focus freezes the attribution weighed: the flipped ones, or in score mode the largest median drops (as attribute picks them). */
export function focusOf(a: Attribution, rows: RunRow[], freezes?: string[]): string[] {
  if (a.flipped.length) return a.flipped.map((f) => f.freezeId);
  const only = (r: RunRow) => !freezes?.length || freezes.some((p) => r.freezeId.startsWith(p));
  const side = (batch: string | null) => (batch ? gradedSet(rows, batch).filter(only) : []);
  return largestDrops(side(a.good.batch), side(a.bad.batch));
}

/** Whether a plan can start: a searchable answer with a class in play that loads. */
export const planSearchable = (p: BisectPlan): boolean => searchable(p.attribution) && p.bound.classes > 0;

/** Whether a replay search has anything to do (the contract's rule, which the launcher page asks too). */
export const searchable = (a: Attribution): boolean => attributionSearchable(a);

const short = (s: string | null | undefined) => (s ? s.slice(0, 9) : 'none');

/** The plan's answer in plain words when there is nothing to search. */
function answerWords(a: Attribution): string {
  const x = a.answer;
  switch (x.kind) {
    case 'footing':
      if (x.freezeIds?.length) return `the per-freeze rubric changed on ${x.freezeIds.map((f) => f.slice(0, 8)).join(', ')} (${x.from ?? 'none'} to ${x.to ?? 'none'}): not a source change, nothing to search`;
      return `the ${x.change === 'model' ? 'model' : "judge's ruler"} moved (${x.from ?? 'none'} to ${x.to ?? 'none'}): not a source change, nothing to search`;
    case 'freeze':
      return `the frozen moment changed on ${x.freezeIds.map((f) => f.slice(0, 8)).join(', ')}: not a source change, nothing to search`;
    case 'live-reads':
      return `${x.reps} bad rep(s) read the live workspace: not reproducible, nothing to search`;
    case 'noise':
      return `nothing differs between the two sides (${x.separation.kind === 'too-few' ? 'too few reps to separate' : `${x.separation.kind}, p=${x.separation.p.toFixed(4)}`}): noise, nothing to search`;
    case 'source': {
      const c = x.candidates[0];
      const more = x.candidates.length > 1 ? ` (${x.candidates.length - 1} later commit(s) render the same)` : '';
      if (x.confidence === 'pinned' && c) return `pinned by the records to ${c.kind === 'commit' ? `${short(c.commit.sha)} ${c.commit.subject}` : `the uncommitted edits on top of ${short(c.base)}`}${more}: nothing to spend`;
      if (x.noDeclaredSourceMoved) return 'no declared source moved in the range; --all-commits searches every commit';
      if (!x.candidates.length) return `${x.reason ?? 'no candidate left'}: nothing to search`;
      return `${x.candidates.length} candidate(s): nothing to search`;
    }
  }
}

/** The cost line in plain words: "2 controls + up to 2 probes + confirmation, 3 freezes, 3 to 5 reps: at most 110 reps, about $2.20, budget $2.60". */
export function costLine(b: CostBound, budgetUsd: number): string {
  return `2 controls + up to ${b.probes} probe${b.probes === 1 ? '' : 's'} + confirmation, ${b.freezes} freeze${b.freezes === 1 ? '' : 's'}, ${b.reps} to ${b.reps + 2} reps: at most ${b.maxReps} reps, about ${formatCost(b.maxUsd)}, budget ${formatCost(budgetUsd)}`;
}

/** What Tier 1 mapped: the class each endpoint that ran on edits nothing can replay matches, or null. */
export interface LegacyMap {
  good: number | null;
  bad: number | null;
}

export const NO_LEGACY: LegacyMap = { good: null, bad: null };

/** Tier 1's output: every candidate's class (all of them, in ancestry order) and the legacy endpoints mapped onto them. */
export interface Tier1 {
  classes: RenderClass[];
  candidates: Candidate[];
  legacy: LegacyMap;
}

/** The classes still in play: after a mapped good class, up to a mapped bad class. */
export const openClasses = (classes: RenderClass[], legacy: LegacyMap): RenderClass[] => classes.filter((c) => c.n > (legacy.good ?? -1) && c.n <= (legacy.bad ?? classes.length - 1));

/**
 * The plan from the records alone (Tier 0) and, once Tier 1 has run, its
 * classes. With no classes each candidate counts as a class of its own.
 * The plan keeps every candidate and class so the ruler can show them all;
 * the attribution's answer names the ones still in play.
 */
export function planFrom(args: PlanArgs, world: PlanWorld, attribution?: Attribution, tier1: Tier1 | null = null): BisectPlan {
  const meta = surfaceMeta(args.surface);
  if (!meta) throw new Error(`no surface ${args.surface}`);
  const a = attribution ?? attribute({ surface: args.surface, rows: world.rows, good: args.good, bad: args.bad, freezes: args.freezes, allCommits: args.allCommits, git: world.git, heads: world.heads, reader: world.reader });
  const rows = world.rows.filter((r) => r.surface === args.surface);
  const focus = focusOf(a, rows, args.freezes);
  const g = a.good.batch ? gradedSet(rows, a.good.batch) : [];
  const b = a.bad.batch ? gradedSet(rows, a.bad.batch) : [];
  // A chosen freeze list (`--freeze`, the launcher's checkboxes) holds for the controls too.
  const chosen = (f: string) => !args.freezes?.length || args.freezes.some((p) => f.startsWith(p));
  const controls = args.controls ?? controlFreezes(g, b, focus).filter(chosen);
  const name = (f: string) => rows.find((r) => r.freezeId === f)?.freezeName ?? f.slice(0, 8);
  const freezes = [...focus.map((id) => ({ id, name: name(id), role: 'flipped' as const })), ...controls.map((id) => ({ id, name: name(id), role: 'control' as const }))];
  const candidates: Candidate[] = tier1?.candidates ?? (a.answer.kind === 'source' ? a.answer.candidates : []);
  // In score mode a probe is read by separation, which needs 5 scores a side over the focus freezes.
  const reps = args.reps ?? (a.mode === 'score' ? Math.max(DEFAULT_REPS, Math.ceil(5 / Math.max(1, focus.length))) : DEFAULT_REPS);
  const model = a.bad.footing.model ?? meta.model;
  const open = tier1 ? openClasses(tier1.classes, tier1.legacy) : null;
  const live = open ? open.filter((c) => !c.skip).length : candidates.length;
  // A range whose every class fails to load has nothing a replay can probe.
  const can = searchable(a) && live > 0;
  const bound = costBound({ classes: can ? live : 0, freezes: freezes.length, reps, perRepUsd: perRepUsd(meta, world.state ?? readState(), model), judgePerRepUsd: judgeUsdPerRep(rows, model) });
  const budgetUsd = args.budgetUsd ?? Math.round(bound.maxUsd * BUDGET_HEADROOM * 100) / 100;
  return {
    surface: args.surface,
    good: a.good,
    bad: a.bad,
    attribution: a,
    freezes,
    reps,
    candidates,
    classes: tier1?.classes ?? null,
    bound,
    budgetUsd,
    maxMinutes: args.maxMinutes ?? DEFAULT_MAX_MINUTES,
    allCommits: Boolean(args.allCommits),
    needsConfirm: meta.route === 'agent',
    summary: can ? costLine(bound, budgetUsd) : !focus.length ? 'no freeze graded on both ends fell: nothing to search' : searchable(a) ? `${open!.length} class(es) left and none loads under today's tool (${open!.find((c) => c.skip)?.skip ?? 'no render'}): no replay can probe them` : answerWords(a),
  };
}

const focusFreezes = (plan: BisectPlan) => plan.freezes.filter((f) => f.role === 'flipped').map((f) => f.id);

/** Which class each legacy endpoint (dirty, no patch) ran, by its render. */
export function legacyMap(plan: BisectPlan, classes: RenderClass[], rows: RunRow[], params: ProbeEnv['params']): LegacyMap {
  const side = (batch: string | null) => (batch ? gradedSet(rows.filter((r) => r.surface === plan.surface), batch) : []);
  const legacy = (e: BisectPlan['good']) => e.dirty && !e.treePatch;
  return {
    good: legacy(plan.good) ? mapToClass(side(plan.good.batch), classes, focusFreezes(plan), params, 'good') : null,
    bad: legacy(plan.bad) ? mapToClass(side(plan.bad.batch), classes, focusFreezes(plan), params, 'bad') : null,
  };
}

/**
 * Tier 1 over a plan: dry renders of every candidate fold into classes, and
 * an endpoint that ran on edits with no patch is mapped to the class whose
 * render it matches. A mapped endpoint narrows the classes in play (and can
 * turn an unattributable answer into a narrowed or pinned one); an unmapped
 * one stays "uncommitted edits nothing recorded can replay", and the search
 * brackets to its last commit. A plan with nothing to search comes back as
 * it was.
 */
export async function renderPlan(plan: BisectPlan, args: PlanArgs, world: PlanWorld, env: ProbeEnv, o: { toolHead?: string; onRender?: RenderHook } = {}): Promise<{ plan: BisectPlan; legacy: LegacyMap }> {
  const a = plan.attribution;
  if (!searchable(a) || a.answer.kind !== 'source') return { plan, legacy: NO_LEGACY };
  const candidates = a.answer.candidates.map((c) => ({ ...c }));
  const classes = await renderClasses(env, candidates, focusFreezes(plan), o);
  const rows = await env.rows();
  const legacy = legacyMap(plan, classes, rows, env.params);
  const open = openClasses(classes, legacy);
  const keys = new Set(open.flatMap((c) => c.shas));
  const badUnmapped = a.bad.dirty && !a.bad.treePatch && legacy.bad === null;
  const unmapped = (a.good.dirty && !a.good.treePatch && legacy.good === null) || badUnmapped;
  const tier1 = { classes, candidates, legacy };
  if (!open.length) {
    // The good side renders as the newest candidate does: no commit in the range changes what the model sees.
    const rendered = `every candidate renders as the good side does (Tier 1)`;
    if (badUnmapped) {
      const answer = { ...a.answer, candidates: [], confidence: 'unattributable' as const, reason: `${a.answer.reason}; ${rendered}, so only those edits remain` };
      return { plan: planFrom(args, { ...world, rows }, { ...a, answer }, tier1), legacy };
    }
    const focus = new Set(focusFreezes(plan));
    const scores = (batch: string | null) => (batch ? gradedSet(rows.filter((r) => r.surface === plan.surface), batch).filter((r) => focus.has(r.freezeId)).map((r) => r.score ?? 0) : []);
    const separation = separate(scores(a.bad.batch), scores(a.good.batch));
    const checklist = a.checklist.map((c) => (c.class === 'source' ? { ...c, differs: false, detail: `${c.detail}; but ${rendered}` } : c.class === 'noise' ? { ...c, differs: true, detail: c.detail.replace(/^not the answer/, 'nothing that renders differs') } : c));
    return { plan: planFrom(args, { ...world, rows }, { ...a, checklist, answer: { kind: 'noise', separation } }, tier1), legacy };
  }
  const answer = {
    ...a.answer,
    candidates: candidates.filter((c) => keys.has(candidateKey(c))),
    confidence: unmapped ? ('unattributable' as const) : open.length === 1 ? ('pinned' as const) : ('narrowed' as const),
    reason: unmapped ? a.answer.reason : null,
  };
  return { plan: planFrom(args, { ...world, rows }, { ...a, answer }, tier1), legacy };
}

/** The plan, with Tier 1's classes when an env is given (`bisect plan` without --no-render). */
export async function buildPlan(args: PlanArgs, world: PlanWorld, o: { env?: ProbeEnv; toolHead?: string; onRender?: RenderHook } = {}): Promise<{ plan: BisectPlan; legacy: LegacyMap }> {
  const plan = planFrom(args, world);
  return o.env ? renderPlan(plan, args, world, o.env, o) : { plan, legacy: NO_LEGACY };
}

/** The args that rebuild a plan: its endpoints, its focus freezes (which a limit to freezes left), and its numbers. */
export const argsOf = (plan: BisectPlan): PlanArgs => ({
  surface: plan.surface,
  good: plan.good.batch ?? plan.good.sha,
  bad: plan.bad.batch ?? plan.bad.sha,
  freezes: focusFreezes(plan),
  controls: plan.freezes.filter((f) => f.role === 'control').map((f) => f.id),
  reps: plan.reps,
  budgetUsd: plan.budgetUsd,
  maxMinutes: plan.maxMinutes,
  allCommits: plan.allCommits,
});
