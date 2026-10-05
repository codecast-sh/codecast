import { attributionSearchable, flipReading, largestDrops, type Attribution, type BisectPlan, type Candidate, type CostBound, type ProbeReading, type RenderClass, type RunRow } from '@codecast/shared/contracts/evalsApi';
import { formatCost } from '@platform/cli-kit/format';

import { median, separate } from '../stats';
import type { AttributionMeta } from './attribution';
import { batchSet, BISECT_CADENCE, gradedSet, scoreOrZero, type VerdictKit } from './verdict';

// The bisect's pure parts: how a set of reps reads against the ends of a
// range (evals-ui.md section 5), the plan and its cost bound, and Tier 1's
// render classes over an env that runs the checks. The worktrees, the state
// on disk and the runner stay with the product.

// ── Reading a probe ─────────────────────────────────────────────────────────

/** A probe's reading before the unsure rule: `split` asks for 2 more reps per freeze. */
export type Reading = ProbeReading;

/** The focus freezes a set has no scored rep on: every rep there crashed, so the set says nothing about them. */
export const crashedFocus = (set: RunRow[], focus: string[]): string[] => focus.filter((f) => !set.some((r) => r.freezeId === f && r.status !== 'crash'));

/**
 * How a probe's reps read. In flip mode, the contract's flipReading over the
 * graded reps (crashes vote nowhere). In score mode, the focus scores against
 * the good control's: separated worse is bad, too few to separate is a split,
 * otherwise good.
 */
export function readProbe(v: VerdictKit, set: RunRow[], focus: string[], mode: 'flip' | 'score', goodControl: RunRow[]): Reading {
  const ran = set.filter((r) => focus.includes(r.freezeId) && r.status !== 'crash');
  if (mode === 'score') {
    const s = separate(ran.map(scoreOrZero), goodControl.filter((r) => focus.includes(r.freezeId)).map(scoreOrZero));
    return s.kind === 'worse' ? 'bad' : s.kind === 'too-few' ? 'split' : 'good';
  }
  return flipReading(ran.map((r) => ({ freezeId: r.freezeId, passed: v.passed(r) })), focus);
}

/**
 * The control freezes a set fails by majority, a tie failing nothing (the
 * contract's flipReading over that freeze alone). A control passed on both
 * ends in the records, so failing now says the tool, the judge or the tree
 * under test moved, never the source between the ends.
 */
export function failedControls(v: VerdictKit, set: RunRow[], controls: string[]): string[] {
  const ran = set.filter((r) => r.status !== 'crash').map((r) => ({ freezeId: r.freezeId, passed: v.passed(r) }));
  return controls.filter((f) => flipReading(ran, [f]) === 'bad');
}

/**
 * The unsure rule: a probe still split after its extra reps sides with the
 * control its focus median sits nearer, the bad one on a tie, and is marked
 * unsure so the answer's confidence drops.
 */
export function unsureSide(set: RunRow[], focus: string[], good: RunRow[], bad: RunRow[]): 'good' | 'bad' {
  const med = (s: RunRow[]) => median(s.filter((r) => focus.includes(r.freezeId)).map(scoreOrZero));
  const [p, g, b] = [med(set), med(good), med(bad)];
  if (!Number.isFinite(p) || !Number.isFinite(g) || !Number.isFinite(b)) return 'bad';
  return Math.abs(p - g) < Math.abs(p - b) - 1e-9 ? 'good' : 'bad';
}

// ── Trees, probes and Tier 1 renders ────────────────────────────────────────

/** Where a probe runs: a commit, plus a dirty rep's treePatch on top. */
export interface Tree {
  sha: string;
  patch: string | null;
}

/** How a check ended: its surface did not load in the tree, or it ran and exited (with its last error line, when it printed one). */
export type CheckExit = { kind: 'load-error'; error: string } | { kind: 'exit'; code: number | null; error?: string };

/** What a Tier 1 render asks of a check: one dry rep per focus freeze, in the render's batch. */
export interface RenderCheck {
  batch: string;
  dry: true;
  reps: number;
  freeze: string[];
  cadence: string;
  notes: string;
}

/** The world a bisect acts on. A product's real env makes trees and runs its checks; tests hand in a fake check. */
export interface ProbeEnv<C = RenderCheck> {
  surface: string;
  /** Run a check in a tree; `tick` runs every few seconds while it does, so landed reps show before it ends. */
  check(tree: Tree, o: C, tick?: () => Promise<void>): Promise<CheckExit>;
  /** The surface's index rows, fresh. */
  rows(): Promise<RunRow[]>;
  /** What a rep asked the model with besides its prompts (each call's request less the prompt text). */
  params(runId: string): string;
  /** Where a check's output lines go. */
  out?: (line: string) => void;
}

const sha9 = (sha: string) => sha.slice(0, 9);

/** A tree as one word: `<sha9>`, or `<sha9>+<patch8>` for a patch on top. */
export const treeLabel = (t: Tree): string => `${sha9(t.sha)}${t.patch ? `+${t.patch.slice(0, 8)}` : ''}`;

export const treeOf = (c: Candidate): Tree => (c.kind === 'commit' ? { sha: c.commit.sha, patch: null } : { sha: c.base, patch: c.treePatch });

/** A candidate as one word, the form RenderClass.shas holds: a commit's sha, or `patch:<treePatch>` for a dirty batch's edits. */
export const candidateKey = (c: Candidate): string => (c.kind === 'commit' ? c.commit.sha : `patch:${c.treePatch}`);

/**
 * The batch a dry render of `tree` lands in. Keyed by the tool's head and
 * the tree, not by a bisect, so a plan's renders are reused by the start
 * that follows it and by later bisects on the same tool; a render that lacks
 * a freeze is topped up in place (check resumes a named batch).
 */
export const renderBatch = (tree: Tree, toolHead: string): string => `bisect-render-${sha9(toolHead)}~dry-${treeLabel(tree)}`;

/** One freeze's render in a batch: its most common promptSha and the request parameters of a rep that sent it. */
function renderKey(set: RunRow[], freezeId: string, params: ProbeEnv['params']): string | null {
  const reps = set.filter((r) => r.freezeId === freezeId && r.promptSha);
  if (!reps.length) return null;
  const n = new Map<string, number>();
  for (const r of reps) n.set(r.promptSha!, (n.get(r.promptSha!) ?? 0) + 1);
  const sha = [...n].sort((a, b) => b[1] - a[1])[0]![0];
  return `${sha}|${params(reps.find((r) => r.promptSha === sha)!.id)}`;
}

/** Every freeze's render key over a set of reps, or null when one is missing. */
export function renderKeys(set: RunRow[], focus: string[], params: ProbeEnv['params']): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const f of focus) {
    const k = renderKey(set, f, params);
    if (!k) return null;
    out[f] = k;
  }
  return out;
}

/** Told of each candidate's render: `ran` when it needed a dry check, false when its render was on record. */
export type RenderHook = (c: Candidate, batch: string, ran: boolean) => void;

/**
 * Tier 1: render every candidate dry on the focus freezes (free: canned model
 * output, real prompt files), and fold adjacent candidates whose renders
 * match on every focus freeze into one class: a replay cannot tell them
 * apart. Only neighbours fold, so the classes keep ancestry order and the
 * search can halve them. A candidate whose surface does not load, or whose
 * render crashed, is a class of its own marked skip. `n` is the class's
 * index; each candidate's renderClass is set to it.
 */
export async function renderClasses(env: ProbeEnv, candidates: Candidate[], focus: string[], o: { toolHead: string; onRender?: RenderHook }): Promise<RenderClass[]> {
  const toolHead = o.toolHead;
  const keys: Array<{ c: Candidate; key: Record<string, string> | null; skip: string | null }> = [];
  let rows = await env.rows();
  for (const c of candidates) {
    const tree = treeOf(c);
    const batch = renderBatch(tree, toolHead);
    let key = renderKeys(batchSet(rows, batch), focus, env.params);
    let skip: string | null = null;
    if (!key) {
      o.onRender?.(c, batch, true);
      const exit = await env.check(tree, { batch, dry: true, reps: 1, freeze: focus, cadence: BISECT_CADENCE, notes: `bisect render of ${treeLabel(tree)}` });
      rows = await env.rows();
      if (exit.kind === 'load-error') skip = exit.error;
      else {
        key = renderKeys(batchSet(rows, batch), focus, env.params);
        if (!key) skip = `the dry render at ${treeLabel(tree)} recorded no prompt for every freeze (exit ${exit.code}${exit.error ? `: ${exit.error}` : ''})`;
      }
    } else o.onRender?.(c, batch, false);
    keys.push({ c, key: skip ? null : key, skip });
  }
  const classes: RenderClass[] = [];
  const same = (a: Record<string, string> | null, b: Record<string, string> | null) => !!a && !!b && focus.every((f) => a[f] === b[f]);
  for (const k of keys) {
    const last = classes.at(-1);
    const prev = keys[keys.indexOf(k) - 1];
    if (last && !last.skip && !k.skip && prev && same(prev.key, k.key)) {
      last.shas.push(candidateKey(k.c));
      last.representative = candidateKey(k.c);
    } else classes.push({ n: classes.length, shas: [candidateKey(k.c)], representative: candidateKey(k.c), promptShas: k.key ?? {}, skip: k.skip });
    k.c.renderClass = classes.length - 1;
  }
  return classes;
}

/**
 * Tier 1's legacy mapping: an endpoint that ran on uncommitted edits with no
 * patch, whose render equals a class's on every focus freeze, ran what that
 * class runs. The bad side takes the newest matching class and the good side
 * the oldest, so a render that recurs never narrows past what it proves.
 * Null when nothing matches.
 */
export function mapToClass(side: RunRow[], classes: RenderClass[], focus: string[], params: ProbeEnv['params'], which: 'good' | 'bad'): number | null {
  const key = renderKeys(side, focus, params);
  if (!key) return null;
  const hits = classes.filter((c) => !c.skip && focus.every((f) => c.promptShas[f] === key[f])).map((c) => c.n);
  return hits.length ? (which === 'bad' ? hits.at(-1)! : hits[0]!) : null;
}

/** A probe batch's graded reps (one per seed; crashes and dry reps left out). */
export const probeSet = (rows: RunRow[], batch: string): RunRow[] => gradedSet(rows, batch);

/** The seeds a batch still lacks for `reps` per freeze: a crashed seed counts as missing, as check's resume runs it again. */
export function missingReps(rows: RunRow[], batch: string, freezes: string[], reps: number): number {
  const have = new Set(batchSet(rows, batch).filter((r) => r.status !== 'crash').map((r) => `${r.freezeId}:${r.seed}`));
  let n = 0;
  for (const f of freezes) for (let s = 1; s <= reps; s++) if (!have.has(`${f}:${s}`)) n++;
  return n;
}

// ── The plan ────────────────────────────────────────────────────────────────

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

/** What the plan reads beyond its args and the attribution: the index rows, and whatever else the product's deps read. */
export interface PlanWorldCore {
  rows: RunRow[];
}

/** What a plan asks of the product. */
export interface PlanDeps<W extends PlanWorldCore = PlanWorldCore> {
  verdict: VerdictKit;
  meta: Pick<AttributionMeta, 'surfaceInfo'>;
  /** What one rep of `surface` costs on `model`, by the product's own spend records. */
  perRepUsd(surface: string, model: string, world: W): number;
  /** The tool's head, which keys Tier 1's render batches (renderBatch). Read only when a plan renders. */
  toolHead(): string;
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
export function controlFreezes(v: VerdictKit, good: RunRow[], bad: RunRow[], focus: string[], k = CONTROL_FREEZES): string[] {
  const rate = (s: RunRow[], f: string) => {
    const reps = s.filter((r) => r.freezeId === f);
    return reps.length ? reps.filter((r) => v.passed(r)).length / reps.length : 0;
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

/** Whether a replay search has anything to do (the contract's rule, which the launcher page asks too). */
export const searchable = (a: Attribution): boolean => attributionSearchable(a);

/** Whether a plan can start: a searchable answer with a class in play that loads. */
export const planSearchable = (p: BisectPlan): boolean => searchable(p.attribution) && p.bound.classes > 0;

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
 * The plan from Tier 0's attribution and, once Tier 1 has run, its classes.
 * With no classes each candidate counts as a class of its own. The plan
 * keeps every candidate and class so the ruler can show them all; the
 * attribution's answer names the ones still in play. The attribution may
 * come as a thunk, read only once the surface is known.
 */
export function planFrom<W extends PlanWorldCore>(args: PlanArgs, world: W, deps: PlanDeps<W>, attribution: Attribution | (() => Attribution), tier1: Tier1 | null = null): BisectPlan {
  const meta = deps.meta.surfaceInfo(args.surface);
  if (!meta) throw new Error(`no surface ${args.surface}`);
  const a = typeof attribution === 'function' ? attribution() : attribution;
  const rows = world.rows.filter((r) => r.surface === args.surface);
  const focus = focusOf(a, rows, args.freezes);
  const g = a.good.batch ? gradedSet(rows, a.good.batch) : [];
  const b = a.bad.batch ? gradedSet(rows, a.bad.batch) : [];
  // A chosen freeze list (`--freeze`, the launcher's checkboxes) holds for the controls too.
  const chosen = (f: string) => !args.freezes?.length || args.freezes.some((p) => f.startsWith(p));
  const controls = args.controls ?? controlFreezes(deps.verdict, g, b, focus).filter(chosen);
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
  const bound = costBound({ classes: can ? live : 0, freezes: freezes.length, reps, perRepUsd: deps.perRepUsd(args.surface, model, world), judgePerRepUsd: judgeUsdPerRep(rows, model) });
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
    summary: can ? costLine(bound, budgetUsd) : !focus.length ? 'no freeze graded on both ends fell, so every commit renders alike; pick a good and a bad batch that both graded the freeze that broke' : searchable(a) ? `${open!.length} class(es) left and none loads under today's tool (${open!.find((c) => c.skip)?.skip ?? 'no render'}): no replay can probe them` : answerWords(a),
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
export async function renderPlan<W extends PlanWorldCore>(plan: BisectPlan, args: PlanArgs, world: W, env: ProbeEnv, deps: PlanDeps<W>, o: { toolHead?: string; onRender?: RenderHook } = {}): Promise<{ plan: BisectPlan; legacy: LegacyMap }> {
  const a = plan.attribution;
  if (!searchable(a) || a.answer.kind !== 'source') return { plan, legacy: NO_LEGACY };
  const candidates = a.answer.candidates.map((c) => ({ ...c }));
  const classes = await renderClasses(env, candidates, focusFreezes(plan), { onRender: o.onRender, toolHead: o.toolHead ?? deps.toolHead() });
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
      return { plan: planFrom(args, { ...world, rows }, deps, { ...a, answer }, tier1), legacy };
    }
    const focus = new Set(focusFreezes(plan));
    const scores = (batch: string | null) => (batch ? gradedSet(rows.filter((r) => r.surface === plan.surface), batch).filter((r) => focus.has(r.freezeId)).map((r) => r.score ?? 0) : []);
    const separation = separate(scores(a.bad.batch), scores(a.good.batch));
    const checklist = a.checklist.map((c) => (c.class === 'source' ? { ...c, differs: false, detail: `${c.detail}; but ${rendered}` } : c.class === 'noise' ? { ...c, differs: true, detail: c.detail.replace(/^not the answer/, 'nothing that renders differs') } : c));
    return { plan: planFrom(args, { ...world, rows }, deps, { ...a, checklist, answer: { kind: 'noise', separation } }, tier1), legacy };
  }
  const answer = {
    ...a.answer,
    candidates: candidates.filter((c) => keys.has(candidateKey(c))),
    confidence: unmapped ? ('unattributable' as const) : open.length === 1 ? ('pinned' as const) : ('narrowed' as const),
    reason: unmapped ? a.answer.reason : null,
  };
  return { plan: planFrom(args, { ...world, rows }, deps, { ...a, answer }, tier1), legacy };
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
