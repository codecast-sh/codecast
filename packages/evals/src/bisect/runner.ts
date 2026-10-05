import { existsSync, rmSync } from 'node:fs';

import type { BisectAnswer, BisectPlan, BisectProbe, BisectRep, BisectState, Candidate, ProbeVerdict, RenderClass, RunRow, SeparationResult } from '@codecast/shared/contracts/evalsApi';
import { formatCost } from '@platform/cli-kit/format';
import { separate } from '@platform/evals/analysis';

import { repPassed } from '../adapters/replay';
import { BISECT_CADENCE } from '../commands/check';
import { scoreOrZero } from '../commands/verdict';
import { argsOf, CONFIRM_REPS, legacyMap, NO_LEGACY, planFrom, planSearchable, renderPlan, type LegacyMap, type PlanArgs, type PlanWorld } from './plan';
import { candidateKey, missingReps, probeSet, treeLabel, treeOf, type ProbeEnv, type Tree } from './probe';
import { crashedFocus, failedControls, readProbe, unsureSide } from './reading';
import { acquireRunLock, Journal, recordedState } from './state';

// The paid part of a bisect, after the free answers (section 5 of
// docs/architecture/evals-ui.md):
//
// 1. Controls: replay the good and bad endpoints under today's tool and
//    judge. If good does not read good or bad does not read bad, stop:
//    drift, not source. Their reps also stand for the search's endpoints.
// 2. Search: halve the render classes between the bounds, one replay probe
//    at each class's newest commit. A probe whose surface does not load is a
//    skip; a split vote gets 2 more reps per freeze once and is then unsure,
//    siding with the control it sits nearer.
// 3. Confirm: top the culprit class and the class before it up to 5 reps a
//    side; the culprit is named only when they separate worse, else the
//    answer is a range with p.
//
// Every decision is a function of the reps on record, and a probe whose reps
// are all on record is never run again, so a bisect killed at any point
// resumes by running again from the top: it walks the same path for free up
// to where it stopped. The stop file, the budget and the time limit are
// checked before every probe and by check itself between reps.

export interface RunnerOptions {
  /** The agent-surface confirm (--yes). */
  yes?: boolean;
  /** A resume: clears an earlier stop request and says so. */
  resume?: boolean;
  /** Search with one class per candidate instead of rendering them first. */
  noRender?: boolean;
  tmux?: string | null;
  /** The terminal, when there is one: steps and check output also go there. */
  echo?: (line: string) => void;
  home?: string;
  /** What the plan reads besides the rows (tests hand in a fake git and prompt reader). */
  world?: Omit<PlanWorld, 'rows'>;
  toolHead?: string;
}

/** Why a plan cannot start at all, or null. Nothing is written for a refused start. */
export function startRefusal(plan: BisectPlan, yes = false): string | null {
  if (!planSearchable(plan)) return `nothing to search: ${plan.summary}`;
  if (plan.needsConfirm && !yes) return `${plan.surface} is an agent surface: its reps are slow and dear; pass --yes to start (${plan.summary})`;
  return null;
}

/** Why a plan's bound does not fit its budget, or null. Checked once Tier 1 has folded the candidates, since that can only shrink the bound. */
export const budgetRefusal = (plan: BisectPlan): string | null =>
  plan.bound.maxUsd > plan.budgetUsd ? `refused: the bound ${formatCost(plan.bound.maxUsd)} is over the budget ${formatCost(plan.budgetUsd)} (${plan.summary}); a bigger --budget, fewer --reps or fewer freezes` : null;

/** The classes a search walks: Tier 1's, or one per candidate when the renders were skipped. */
export const searchClasses = (plan: BisectPlan): RenderClass[] =>
  plan.classes ?? plan.candidates.map((c, n) => ({ n, shas: [candidateKey(c)], representative: candidateKey(c), promptShas: {}, skip: null }));

type Halt = 'stopped' | 'budget' | 'time';

interface Probed {
  set: RunRow[];
  skip: string | null;
  halt: Halt | null;
}

/**
 * Run a bisect to its answer, or resume one: a bisect whose state is on disk
 * goes on from its own plan.json, and `args` are only read for a new one.
 * The state is written before the first render, so a page watching the id
 * sees it plan.
 */
export async function runBisect(id: string, args: PlanArgs, env: ProbeEnv, o: RunnerOptions = {}): Promise<BisectState> {
  const prior = recordedState(id, o.home);
  let rows = await env.rows();
  const world = (): PlanWorld => ({ ...o.world, rows });
  let plan = prior?.plan ?? planFrom(args, world());
  if (!prior) {
    const why = startRefusal(plan, o.yes);
    if (why) throw new Error(why);
  }
  if (prior?.status === 'done') return prior;
  const lock = acquireRunLock(id, o.home);
  if (!lock.ok) throw new Error(`bisect ${lock.holder} is running; one bisect runs at a time (./evals bisect stop ${lock.holder})`);
  const j = Journal.open(id, plan, { home: o.home, tmux: o.tmux, echo: o.echo });
  const s = j.state;
  try {
    if (prior && o.resume) {
      rmSync(j.paths.stop, { force: true });
      j.step('plan', null, `resumed at ${s.status}; reps already on record are not run again`);
    } else if (!prior) j.step('plan', null, plan.summary);
    s.finishedAt = null;
    s.answer = null;
    if (!plan.classes && !o.noRender) {
      s.status = 'planning';
      j.step('render', null, `dry renders of ${plan.candidates.length} candidate(s) on ${plan.freezes.filter((f) => f.role === 'flipped').length} freeze(s), free`);
      // A budget the caller set stays; a default one follows the bound Tier 1 narrows.
      const done = await renderPlan(plan, { ...argsOf(plan), budgetUsd: prior ? plan.budgetUsd : args.budgetUsd }, world(), env, {
        toolHead: o.toolHead,
        onRender: (c, batch, ran) => {
          if (ran) j.step('render', treeOf(c).sha, `dry render at ${treeLabel(treeOf(c))} (${batch})`);
        },
      });
      plan = done.plan;
      rows = await env.rows();
      j.setPlan(plan);
      const classes = plan.classes ?? [];
      j.step('render', null, `${plan.candidates.length} candidate(s) fold into ${classes.length} render class(es)${classes.some((c) => c.skip) ? `, ${classes.filter((c) => c.skip).length} that do not load` : ''}: ${plan.summary}`);
      s.tier = 1;
      if (!planSearchable(plan)) {
        finishWith(j, 'done', { kind: 'attribution', answer: plan.attribution.answer }, `answered by the renders: ${plan.summary}`);
        return s;
      }
    }
    const over = budgetRefusal(plan);
    if (over) {
      finishWith(j, 'budget', null, over);
      return s;
    }
    await search(j, plan, env);
  } catch (e) {
    s.status = 'failed';
    s.finishedAt = new Date().toISOString();
    j.step('error', null, (e instanceof Error ? e.message : String(e)).split('\n')[0]!);
  } finally {
    lock.release();
  }
  return s;
}

function finishWith(j: Journal, status: BisectState['status'], answer: BisectAnswer | null, text: string): void {
  j.state.status = status;
  j.state.answer = answer;
  j.state.finishedAt = new Date().toISOString();
  j.step(answer ? 'answer' : 'stop', null, text);
}

async function search(j: Journal, plan: BisectPlan, env: ProbeEnv): Promise<void> {
  const s = j.state;
  const set = plan.freezes.map((f) => f.id);
  const focus = plan.freezes.filter((f) => f.role === 'flipped').map((f) => f.id);
  const controls = plan.freezes.filter((f) => f.role === 'control').map((f) => f.id);
  const ids = (fs: string[]) => fs.map((f) => f.slice(0, 8)).join(', ');
  const mode = plan.attribution.mode;
  const classes = searchClasses(plan);
  s.tier = plan.classes ? 1 : 0;
  let rows = await env.rows();
  const legacy: LegacyMap = plan.classes ? legacyMap(plan, classes, rows, env.params) : NO_LEGACY;
  const candidateOf = (key: string): Candidate => plan.candidates.find((c) => candidateKey(c) === key)!;
  const classTree = (n: number): Tree => treeOf(candidateOf(classes[n]!.representative));
  const end = (e: BisectPlan['good']): Tree => ({ sha: e.sha, patch: e.treePatch });
  const goodTree = legacy.good !== null ? classTree(legacy.good) : end(plan.good);
  const badTree = legacy.bad !== null ? classTree(legacy.bad) : end(plan.bad);
  const batchOf = (t: Tree) => `${s.id}~${treeLabel(t)}`;
  const deadline = Date.now() + plan.maxMinutes * 60_000;
  const spent = () => rows.filter((r) => r.batch?.startsWith(`${s.id}~`)).reduce((t, r) => t + r.costUsd + r.judgeCostUsd, 0);
  const classOfSha = (sha: string) => classes.find((c) => c.shas.includes(sha))?.n ?? null;

  // The batches the records already hold inside the range: shown on the ruler as recorded.
  if (plan.attribution.answer.kind === 'source') {
    for (const p of plan.attribution.answer.narrowedBy) {
      if (s.probes.some((x) => x.recorded && x.batch === p.batch)) continue;
      const reps = probeSet(rows, p.batch).filter((r) => set.includes(r.freezeId));
      s.probes.push({ sha: p.sha, kind: 'probe', renderClass: classOfSha(p.sha), batch: p.batch, recorded: true, reps: reps.map(repOf), verdict: p.verdict, skipReason: null, costUsd: 0 });
    }
  }

  const entry = (kind: BisectProbe['kind'], t: Tree, renderClass: number | null): BisectProbe => {
    const batch = batchOf(t);
    let p = s.probes.find((x) => !x.recorded && x.kind === kind && x.batch === batch);
    if (!p) {
      p = { sha: t.sha, kind, renderClass, batch, recorded: false, reps: [], verdict: 'pending', skipReason: null, costUsd: 0 };
      s.probes.push(p);
      j.save();
    }
    return p;
  };

  /** Land the batch's new reps in every probe that reads it, one rep step each. */
  const sweep = async (batch: string) => {
    rows = await env.rows();
    const reps = rows.filter((r) => r.batch === batch && r.status !== 'unscored');
    for (const p of s.probes.filter((x) => !x.recorded && x.batch === batch)) {
      for (const r of reps) {
        if (p.reps.some((x) => x.runId === r.id)) continue;
        const rep = repOf(r);
        p.reps.push(rep);
        p.costUsd += r.costUsd + r.judgeCostUsd;
        if (p === s.probes.find((x) => !x.recorded && x.batch === batch)) j.step('rep', p.sha, `${r.freezeId.slice(0, 8)} seed ${r.seed}: ${r.status}${r.score != null ? ` ${r.score.toFixed(2)}` : ''}`, rep);
      }
    }
    s.spentUsd = spent();
    j.save();
  };

  const halt = (): Halt | null => (existsSync(j.paths.stop) ? 'stopped' : spent() >= s.budgetUsd ? 'budget' : Date.now() >= deadline ? 'time' : null);

  /** Bring a tree's batch to `reps` per freeze, running check only for what the records lack. */
  const ensure = async (kind: BisectProbe['kind'], t: Tree, renderClass: number | null, reps: number): Promise<Probed> => {
    const p = entry(kind, t, renderClass);
    if (p.verdict === 'skip') return { set: [], skip: p.skipReason, halt: null };
    rows = await env.rows();
    const lacking = missingReps(rows, p.batch, set, reps);
    if (lacking > 0) {
      const h = halt();
      if (h) return { set: [], skip: null, halt: h };
      const words = kind === 'probe' ? 'probe' : kind.replace('-', ' ');
      j.step(kind.startsWith('control') ? 'control' : kind.startsWith('confirm') ? 'confirm' : 'probe', t.sha, `${words} at ${treeLabel(t)}${renderClass != null ? ` (class ${renderClass})` : ''}: ${lacking} rep(s) to run, ${reps} per freeze on ${set.length} freeze(s)`);
      const before = rows.filter((r) => r.batch === p.batch).length;
      const exit = await env.check(
        t,
        { batch: p.batch, reps, freeze: set, model: plan.bad.footing.model ?? undefined, budget: Math.max(0.01, s.budgetUsd - spent()), maxMinutes: Math.max(1, Math.ceil((deadline - Date.now()) / 60_000)), cadence: BISECT_CADENCE, stopFile: j.paths.stop, notes: `bisect ${s.id}: ${kind} at ${treeLabel(t)}` },
        () => sweep(p.batch),
      );
      if (exit.kind === 'load-error') {
        p.verdict = 'skip';
        p.skipReason = exit.error;
        j.step(kind.startsWith('control') ? 'control' : 'probe', t.sha, `skip: ${exit.error}`);
        return { set: [], skip: exit.error, halt: null };
      }
      await sweep(p.batch);
      if (missingReps(rows, p.batch, set, reps) > 0) {
        // check refused its estimate (exit 1, nothing ran) or stopped between reps (exit 3): a budget, time or stop halt. Otherwise some seeds crashed, and the rest still read.
        const ranNone = rows.filter((r) => r.batch === p.batch).length === before;
        const h = halt() ?? (exit.code === 3 || (exit.code === 1 && ranNone) ? 'budget' : null);
        if (h) return { set: [], skip: null, halt: h };
      }
    }
    return { set: probeSet(rows, p.batch), skip: null, halt: null };
  };

  const finish = (status: BisectState['status'], answer: BisectAnswer | null, text: string) => {
    s.spentUsd = spent();
    finishWith(j, status, answer, text);
  };
  const halted = (h: Halt) =>
    finish(h === 'stopped' ? 'stopped' : 'budget', null, h === 'stopped' ? 'stopped: the stop file was written' : h === 'time' ? `stopped: the ${plan.maxMinutes} minute limit passed` : `stopped: the ${formatCost(s.budgetUsd)} budget is spent (${formatCost(spent())})`);

  /** Read a probe, topping a split up by 2 reps per freeze once; still split, it is unsure and sides by its median. */
  const read = async (kind: BisectProbe['kind'], t: Tree, n: number | null, refs: { good: RunRow[]; bad: RunRow[] } | null): Promise<{ side: 'good' | 'bad' | null; verdict: ProbeVerdict; set: RunRow[]; skip: string | null; halt: Halt | null }> => {
    let r = await ensure(kind, t, n, plan.reps);
    if (r.halt || r.skip) return { side: null, verdict: r.skip ? 'skip' : 'pending', ...r };
    const dead = crashedFocus(r.set, focus);
    // A stable control failing at a probe says this tree does not run the surface as the ends do, so its flipped freezes say nothing about the source.
    const broken = kind === 'probe' ? failedControls(r.set, controls) : [];
    if (dead.length || broken.length) {
      const p = entry(kind, t, n);
      p.verdict = 'skip';
      p.skipReason = dead.length ? `every rep crashed on ${ids(dead)}` : `the control freeze${broken.length > 1 ? 's' : ''} ${ids(broken)} failed here`;
      j.step(kind.startsWith('control') ? 'control' : 'probe', t.sha, `skip: ${p.skipReason}`);
      return { side: null, verdict: 'skip', set: r.set, skip: p.skipReason, halt: null };
    }
    let reading = readProbe(r.set, focus, mode, refs?.good ?? r.set);
    if (reading === 'split') {
      r = await ensure(kind, t, n, plan.reps + 2);
      if (r.halt || r.skip) return { side: null, verdict: r.skip ? 'skip' : 'pending', ...r };
      reading = readProbe(r.set, focus, mode, refs?.good ?? r.set);
    }
    const p = entry(kind, t, n);
    const side = reading !== 'split' ? reading : refs ? unsureSide(r.set, focus, refs.good, refs.bad) : null;
    p.verdict = reading === 'split' ? 'unsure' : reading;
    j.save();
    return { side, verdict: p.verdict, ...r };
  };

  // 1. Controls.
  s.status = 'controls';
  j.save();
  const cg = await ensure('control-good', goodTree, legacy.good, plan.reps);
  if (cg.halt) return halted(cg.halt);
  const crashedControl = (side: 'good' | 'bad', t: Tree, n: number | null, set: RunRow[]) => {
    const dead = crashedFocus(set, focus);
    if (!dead.length) return false;
    const batch = entry(side === 'good' ? 'control-good' : 'control-bad', t, n).batch;
    const runIds = rows.filter((x) => x.batch === batch && x.status === 'crash' && dead.includes(x.freezeId)).map((x) => x.id);
    finish('done', { kind: 'crashed', detail: `every ${side} control rep at ${treeLabel(t)} crashed on ${dead.map((f) => f.slice(0, 8)).join(', ')}; read call1/harness.log in ${runIds[0] ?? 'its run folder'}`, runIds }, `crashed: the ${side} control could not run a rep`);
    return true;
  };
  if (!cg.skip && crashedControl('good', goodTree, legacy.good, cg.set)) return;
  const cgRead = cg.skip ? 'skip' : mode === 'score' ? 'good' : readProbe(cg.set, focus, mode, cg.set);
  entry('control-good', goodTree, legacy.good).verdict = cgRead === 'split' ? 'unsure' : cgRead;
  const cb = await read('control-bad', badTree, legacy.bad, mode === 'score' ? { good: cg.set, bad: [] } : null);
  if (cb.halt) return halted(cb.halt);
  if (crashedControl('bad', badTree, legacy.bad, cb.set)) return;
  if (cg.skip || cb.skip) return finish('done', { kind: 'drift', detail: `an endpoint does not load under today's tool: ${cg.skip ?? cb.skip}` }, 'the controls could not run');
  // The stable controls passed on both ends in the records: failing at either end now is the tool or the judge moving, not the source.
  const drifted = (['good', 'bad'] as const).flatMap((side) => {
    const failed = failedControls(side === 'good' ? cg.set : cb.set, controls);
    return failed.length ? [`the control freeze${failed.length > 1 ? 's' : ''} ${ids(failed)} failed at the ${side} end`] : [];
  });
  if (cgRead !== 'good' || cb.verdict !== 'bad' || drifted.length) {
    const words = (v: string) => (v === 'unsure' || v === 'split' ? 'split' : v);
    const detail = [`the good control read ${words(cgRead)} and the bad control read ${words(cb.verdict)}`, ...drifted].join('; ') + " on today's tool and judge";
    const unreplayable = !drifted.length && plan.bad.dirty && !plan.bad.treePatch && legacy.bad === null && cb.verdict === 'good';
    return finish(
      'done',
      unreplayable ? { kind: 'unreplayable', detail: `the bad batch ran on uncommitted edits to ${plan.bad.sha.slice(0, 9)} that nothing recorded can replay, and that commit alone reads good` } : { kind: 'drift', detail: `${detail[0]!.toUpperCase()}${detail.slice(1)}.` },
      unreplayable ? 'unreplayable: the bad side owes its fall to edits nothing recorded holds' : `drift: ${detail}`,
    );
  }
  const refs = { good: cg.set, bad: cb.set };

  // 2. Search the classes between the bounds.
  s.status = 'probing';
  j.save();
  let lo = legacy.good ?? -1;
  let hi = legacy.bad ?? classes.length - 1;
  let [sureLo, sureHi] = [lo, hi];
  const skipped = new Set(classes.filter((c) => c.skip).map((c) => c.n));
  const probed = new Set<number>();
  for (;;) {
    const mid = Math.floor((lo + hi) / 2);
    const open = Array.from({ length: Math.max(0, hi - lo - 1) }, (_, i) => lo + 1 + i).filter((i) => !skipped.has(i));
    if (!open.length) break;
    const pick = open.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)[0]!;
    s.tier = 2;
    const r = await read('probe', classTree(pick), pick, refs);
    if (r.halt) return halted(r.halt);
    if (r.skip) {
      skipped.add(pick);
      continue;
    }
    probed.add(pick);
    if (r.side === 'good') {
      lo = pick;
      if (r.verdict === 'good') sureLo = pick;
    } else {
      hi = pick;
      if (r.verdict === 'bad') sureHi = pick;
    }
    j.step('narrow', classTree(pick).sha, `class ${pick} reads ${r.verdict}${r.verdict === 'unsure' ? ` (siding ${r.side})` : ''}: ${hi - lo - 1} class(es) left between ${lo < 0 ? 'good' : `class ${lo}`} and class ${hi}`);
  }
  const unsure = sureLo !== lo || sureHi !== hi;
  const between = (a: number, b: number) => classes.filter((c) => c.n > a && c.n <= b).flatMap((c) => c.shas.map(candidateOf));
  if (hi - lo !== 1) {
    const left = between(lo, hi);
    return finish('done', { kind: 'range', candidates: left, separation: null, tier: s.tier }, `range: ${left.length} candidate(s) between ${lo < 0 ? 'good' : `class ${lo}`} and class ${hi}; the classes between them do not load`);
  }

  // 3. Confirm the culprit against the class before it.
  s.status = 'confirming';
  j.save();
  const reps = Math.max(CONFIRM_REPS, plan.reps);
  const culpritTree = probed.has(hi) ? classTree(hi) : badTree;
  // The class before the culprit renders as the good side when the search never moved off it.
  const parentTree = lo >= 0 ? classTree(lo) : goodTree;
  const cc = await ensure('confirm-culprit', culpritTree, hi, reps);
  if (cc.halt) return halted(cc.halt);
  const cp = await ensure('confirm-parent', parentTree, lo >= 0 ? lo : null, reps);
  if (cp.halt) return halted(cp.halt);
  const focusScores = (x: RunRow[]) => x.filter((r) => focus.includes(r.freezeId)).map(scoreOrZero);
  const separation: SeparationResult = separate(focusScores(cc.set), focusScores(cp.set));
  const sep = separation.kind === 'too-few' ? 'too few to separate' : `${separation.kind}, p=${separation.p.toFixed(4)}`;
  const first = candidateOf(classes[hi]!.shas[0]!);
  if (separation.kind === 'worse' && first.kind === 'commit') {
    return finish('done', { kind: 'culprit', commit: first.commit, separation, tier: s.tier }, `culprit ${first.commit.sha.slice(0, 9)} ${first.commit.subject} (confirmed: ${sep})`);
  }
  const left = separation.kind === 'worse' ? [first] : unsure ? between(sureLo, sureHi) : between(lo, hi);
  return finish('done', { kind: 'range', candidates: left, separation, tier: s.tier }, separation.kind === 'worse' ? `the uncommitted edits on top of ${first.kind === 'patch' ? first.base.slice(0, 9) : ''} (confirmed: ${sep})` : `range of ${left.length} candidate(s): the confirmation did not separate worse (${sep})`);
}

const repOf = (r: RunRow): BisectRep => ({ freezeId: r.freezeId, runId: r.id, passed: r.status === 'crash' ? null : repPassed(r), score: r.score });
