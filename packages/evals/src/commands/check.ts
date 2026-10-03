import { InvalidArgumentError, type Command } from 'commander';
import { mapLimit } from '@codecast/shared/async';
import type { EvalSources, Freeze, RunSummary } from '@platform/evals';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';
import { stripAnsi } from '@platform/cli-kit/render';

import { outcomeOf, prepareFreeze, repCount, repPassed, replayModel, replayRep, treeFacts, type RepLedger } from '../adapters/replay';
import { hasSnapshot, loadLabel, loadSnapshot } from '../adapters/resolver';
import { codecastRunSource, surfaceRuns, type SurfaceRun } from '../adapters/runs';
import { loadSurface } from '../registry';
import { addSpend, checkMinutes, DAILY_USD, patchSurfaceState, perRepUsd, readState, repCostsByModel, spentToday, staleness, suggestedBudget } from '../state';
import { evalSignals, reportSignals, type SurfaceVerdict } from '../signals';
import { separate, separationLine } from '../stats';
import type { SurfaceMeta } from '../surface';
import { publishSite } from './publish';
import { pickSurfaces } from './stale';

// `./evals check`: replay every freeze of each chosen surface, grade every
// rep, and print a verdict per surface against its previous run set. It
// estimates the spend first and refuses past --budget (with none given, it
// stops at the estimate and half again), stops mid-run when the budget is
// spent, and exits 1 on a refusal, a gate failure, a crash or a separated
// regression, and EXIT_INCOMPLETE when part of what was asked never ran. A
// bare `check` runs the call surfaces only: agent surfaces run by name or
// with --route agent. Every rep of every freeze goes through one pool of
// --parallel slots, so a wide check finishes in a fraction of its serial time.
// A --batch that already holds reps resumes it: only the reps it lacks or
// that crashed run, and the verdict covers the whole set.

/** The exit code of a check that stopped short: a budget stop, or a requested surface with no rep scored. */
export const EXIT_INCOMPLETE = 3;

/**
 * Reps in flight at once by default. Each rep is a harness process plus a
 * `claude -p`, so this stays modest for a loaded machine; measured on
 * 2026-10-02 at load 400 to 800 (docs/architecture/evals-home.md 2.9).
 */
export const DEFAULT_PARALLEL = 4;

/** A commander parser for a positive number; NaN would disable every spend check, so it is a usage error. */
export const positiveNumber = (flag: string, integer = false) => (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new InvalidArgumentError(`${flag} takes a positive ${integer ? 'whole number' : 'number'}, not "${v}"`);
  return n;
};

export interface CheckFlags {
  stale?: boolean;
  route?: string;
  freeze?: string[];
  reps?: number;
  model?: string;
  budget?: number;
  dry?: boolean;
  publish?: boolean;
  notes?: string;
  /** Name the run set, so a caller (`line`) can find it again; a set that already holds reps is resumed. */
  batch?: string;
  /** false: leave the cadence state alone (a base or branch run is not the tree's last run). */
  state?: boolean;
  /** File a signal (`cast signal add`) for each regression, failed gate and failing freeze. */
  signal?: boolean;
  /** With --stale: refuse once today's real spend reaches this (default DAILY_USD). */
  daily?: number;
  /** Start no rep after this many minutes: the run stops like a budget stop, and exits EXIT_INCOMPLETE. */
  maxMinutes?: number;
  /** Reps in flight at once across every freeze and surface (default DEFAULT_PARALLEL). */
  parallel?: number;
}

interface Plan {
  meta: SurfaceMeta;
  freezes: Freeze[];
  reps: number;
}

interface Job {
  plan: Plan;
  freeze: Freeze;
  rep: number;
}

const surfaceOf = (f: Freeze): string => String((f.meta as { surface?: string } | undefined)?.surface ?? '');
export const scoreOrZero = (r: RunSummary): number => r.score ?? 0;

/** Each freeze's verdict over its reps: passed by majority. */
export const majority = (runs: RunSummary[]): Map<string, boolean> => {
  const by = new Map<string, number[]>();
  for (const r of runs) by.set(r.freezeId ?? '', [...(by.get(r.freezeId ?? '') ?? []), repPassed(r) ? 1 : 0]);
  return new Map([...by].map(([k, v]) => [k, v.reduce((s, x) => s + x, 0) * 2 > v.length]));
};

/**
 * One rep per batch, freeze and seed, from runs listed newest first
 * (surfaceRuns): a seed a resume ran again after a crash counts once, as its
 * newest rep.
 */
export function onePerSeed<R extends SurfaceRun>(runs: R[]): R[] {
  const seen = new Set<string>();
  return runs.filter((r) => {
    const key = `${r.batch}\x1f${r.freezeId}\x1f${r.seed}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A batch's reps as a set: every rep that ran (a stop folder did not), one per freeze and seed. */
export const batchSet = (history: SurfaceRun[], batch: string): SurfaceRun[] => onePerSeed(history.filter((r) => r.batch === batch && r.status !== 'unscored'));

/**
 * The run set a check is weighed against: for each freeze, the reps of the
 * newest other batch that ran it. A later run of one freeze then never hides
 * the other freezes' sets.
 */
export function previousRunSet(history: SurfaceRun[], batch: string): SurfaceRun[] {
  const real = history.filter((r) => r.batch && r.batch !== batch && r.status !== 'dry' && r.status !== 'unscored');
  const newest = new Map<string, string>();
  for (const r of real) if ((newest.get(r.freezeId ?? '') ?? '') < r.batch!) newest.set(r.freezeId ?? '', r.batch!);
  return onePerSeed(real.filter((r) => newest.get(r.freezeId ?? '') === r.batch));
}

/**
 * Pass rate, mean, range and flips of a run set against the previous one on
 * the same surface, and how many of its reps read the live workspace. The
 * comparison covers only the freezes both sets ran, so a one-freeze run is
 * never weighed against a whole surface. A crash graded nothing (the model
 * never answered, or the agent left its world), so it is counted apart and
 * weighed as neither a pass nor a 0, on either side.
 */
function verdictLines(meta: SurfaceMeta, batch: string, set: SurfaceRun[], previousSet: RunSummary[]): { lines: string[]; regression: boolean } {
  if (set.length && set.every((r) => r.status === 'dry')) {
    return { lines: [`${fmt.bold(meta.id)}  dry: ${set.length} rep(s) ran through the wiring on canned output; nothing is graded or compared`], regression: false };
  }
  const crashes = set.filter((r) => r.status === 'crash').length;
  const current = set.filter((r) => r.status !== 'crash');
  const ranNow = new Set(current.map((r) => r.freezeId));
  const ranBefore = new Set(previousSet.map((r) => r.freezeId));
  const previous = previousSet.filter((r) => ranNow.has(r.freezeId) && r.status !== 'crash');
  const compared = current.filter((r) => ranBefore.has(r.freezeId)).map(scoreOrZero);
  const scores = current.map(scoreOrZero);
  const passed = current.filter((r) => r.status === 'pass').length;
  const mean = scores.reduce((s, x) => s + x, 0) / Math.max(1, scores.length);
  // What the set spent, its crashes included.
  const cost = set.reduce((s, r) => s + r.costUsd, 0);
  const now = majority(current);
  const before = majority(previous);
  const flips = [...now].filter(([k, v]) => before.has(k) && before.get(k) !== v).length;
  const models = [...new Set(current.map((r) => r.model ?? meta.model))].join(',');
  const gatesFailed = [...new Set(current.flatMap((r) => r.gatesFailed))];
  const lines = [
    `${fmt.bold(meta.id)}  pass ${passed}/${current.length} (${Math.round((100 * passed) / Math.max(1, current.length))}%)  mean ${mean.toFixed(2)}  ${scores.length ? `${Math.min(...scores).toFixed(2)}-${Math.max(...scores).toFixed(2)}` : '-'}  flips ${previous.length ? flips : '-'}  ${formatCost(cost)}  ${models}`,
    `  ${previous.length ? `${separationLine(compared, previous.map(scoreOrZero))}${compared.length < scores.length ? ` (over the ${ranBefore.size} freeze(s) the previous set ran)` : ''}` : 'no previous run set to compare with'}`,
  ];
  if (gatesFailed.length) lines.push(`  ${fmt.error('gates failed')}: ${gatesFailed.join(', ')}`);
  // A live read answers from today's workspace, not the frozen moment: such a rep is not reproducible, and its verdict may rest on what the record holds now.
  const live = current.filter((r) => r.liveReads > 0);
  if (live.length) lines.push(`  ${fmt.warning('live reads')}: ${live.length}/${current.length} reps read the live workspace (${live.reduce((t, r) => t + r.liveReads, 0)} reads; ./evals runs show <run> lists them)`);
  if (crashes) lines.push(`  ${fmt.error(`${crashes} crashed`)}, left out of the numbers above: ./evals runs list --scenario ${meta.id}- --status crash; ./evals check ${meta.id} --batch ${batch} with the same --reps and --freeze runs them again`);
  const regression = previous.length > 0 && separate(compared, previous.map(scoreOrZero)).kind === 'worse';
  return { lines, regression };
}

/**
 * A surface's run set `batch` as `check` reports it: the verdict against its
 * previous set, then the surface's own summary lines over the reps it scored.
 * `history` is the surface's runs, newest first; `check` and `publish` both
 * print from here.
 */
export async function setVerdict(meta: SurfaceMeta, batch: string, history: SurfaceRun[]): Promise<{ lines: string[]; regression: boolean; scored: SurfaceRun[] }> {
  const scored = batchSet(history, batch);
  const v = verdictLines(meta, batch, scored, previousRunSet(history, batch));
  const impl = await loadSurface(meta.id);
  if (impl.summarize) {
    const details = await Promise.all(scored.map((r) => codecastRunSource().get(r.id)));
    v.lines.push(...impl.summarize(details.flatMap((d) => (d?.verdict ? [d.verdict] : []))).map((l) => `  ${l}`));
  }
  return { ...v, scored };
}

export async function runCheck(ids: string[], flags: CheckFlags, sources: EvalSources): Promise<number> {
  const store = sources.freezes!;
  let metas = pickSurfaces(ids, flags.route);
  const state = readState();
  // A dry or --no-state run leaves the cadence alone: no notice silenced, no refusal recorded. Real spend always counts toward the day.
  const keepState = !flags.dry && flags.state !== false;
  if (!ids.length && !flags.route && !flags.stale) {
    const agents = metas.filter((m) => m.route === 'agent');
    if (agents.length) console.log(fmt.muted(`left out the agent surfaces (${agents.map((m) => m.id).join(', ')}): they run by hand, by name or with --route agent`));
    metas = metas.filter((m) => m.route === 'call');
  }

  if (flags.stale) {
    const daily = flags.daily ?? DAILY_USD;
    const spent = spentToday();
    if (!flags.dry && spent >= daily) {
      console.log(`refused: ${formatCost(spent)} spent today reaches the ${formatCost(daily)} daily ceiling for unattended runs; the next day's firing runs it, or ./evals check by hand`);
      return 1;
    }
    const { due, waiting, hashes } = staleness(metas, state);
    for (const m of due.filter((s) => s.route === 'agent')) {
      console.log(`manual run needed: ${m.id} changed at HEAD (agent surfaces never run unattended): ./evals check ${m.id}`);
      if (keepState) patchSurfaceState(m.id, (s) => ({ ...s, lastNotifiedHash: hashes.get(m.id) }));
    }
    for (const m of waiting) console.log(`skipped ${m.id}: its sources are dirty in the checkout`);
    metas = due.filter((s) => s.route === 'call');
    if (!metas.length) {
      console.log('nothing changed');
      return 0;
    }
  }

  const all = await store.list();
  const plans: Plan[] = [];
  /** Requested surfaces that cannot run here: their freezes' snapshots are on another machine, or a named one has none. */
  const unrun: string[] = [];
  for (const meta of metas) {
    const freezes = all.filter((f) => surfaceOf(f) === meta.id && (!flags.freeze?.length || flags.freeze.some((p) => f.id.startsWith(p))));
    const here = freezes.filter((f) => {
      if (hasSnapshot(f)) return true;
      console.log(`skipped ${meta.id} freeze ${f.id.slice(0, 8)}: its snapshot is not on this machine`);
      return false;
    });
    const ownChecks = Boolean((await loadSurface(meta.id)).checks);
    for (const f of here) {
      const label = (() => {
        try {
          return loadLabel(f, loadSnapshot(f));
        } catch {
          return undefined;
        }
      })();
      if (!f.judge && label === undefined && !ownChecks) console.log(`${meta.id} freeze ${f.id.slice(0, 8)}: only gates grade this freeze (no label, no criteria)`);
    }
    if (!here.length) {
      console.log(`${meta.id}: no freezes here; make one with ./evals freeze create ${meta.id}@fixture:<case>`);
      if (freezes.length || ids.includes(meta.id)) unrun.push(meta.id);
      continue;
    }
    plans.push({ meta, freezes: here, reps: flags.reps ?? meta.reps.check });
  }

  const batch = flags.batch ?? new Date().toISOString();
  // A named batch that already holds reps is resumed: a rep it scored is not run again, and a seed whose newest rep crashed is.
  const done = new Set<string>();
  if (flags.batch) for (const p of plans) for (const r of batchSet(await surfaceRuns(p.meta.id), batch)) if (r.status !== 'crash') done.add(`${r.freezeId}:${r.seed}`);
  const jobs: Job[] = plans.flatMap((plan) => plan.freezes.flatMap((freeze) => Array.from({ length: repCount(plan.reps) }, (_, i) => ({ plan, freeze, rep: i + 1 })).filter((j) => !done.has(`${freeze.id}:${j.rep}`))));
  if (done.size) console.log(`resuming batch ${batch}: ${done.size} rep(s) already scored there are not run again`);
  // Each rep is estimated on the model its freeze replays on, from that model's own history.
  const modelOf = (j: Job) => replayModel(j.plan.meta, j.freeze, flags.model);
  const estimate = flags.dry ? 0 : jobs.reduce((s, j) => s + perRepUsd(j.plan.meta, state, modelOf(j)), 0);
  const parallel = flags.parallel ?? DEFAULT_PARALLEL;
  // The time is what a real run would take, so a dry check sizes one for free.
  const minutes = checkMinutes(jobs.map((j) => ({ meta: j.plan.meta, reps: 1, model: modelOf(j) })), state, parallel);
  const took = minutes != null ? `about ${Math.ceil(minutes)} min at --parallel ${parallel}` : null;
  console.log(`${jobs.length} reps over ${plans.length} surface(s), estimated ${formatCost(estimate)}${flags.dry ? ` (dry: nothing is spent${took ? `; a real run takes ${took}` : ''})` : took ? ` and ${took}` : ''}`);
  if (minutes != null && flags.maxMinutes && minutes > flags.maxMinutes) console.log(fmt.warning(`the time estimate is over --max-minutes ${flags.maxMinutes}: expect a time stop; fewer --reps or more --parallel`));
  const facts = treeFacts(plans.map((p) => p.meta));
  const hashes = facts.hashes;
  if (flags.budget != null && estimate > flags.budget) {
    console.log(`refused: the estimate ${formatCost(estimate)} is over the --budget ${formatCost(flags.budget)}; fewer --reps, fewer surfaces, or a bigger budget`);
    // An unattended refusal is named once per source change; the next firing leaves these surfaces for a run by hand.
    if (flags.stale && keepState) {
      for (const p of plans) patchSurfaceState(p.meta.id, (s) => ({ ...s, lastRefusedHash: hashes.get(p.meta.id) }));
      console.log(`not retried until their sources change: ./evals check ${plans.map((p) => p.meta.id).join(' ')} --budget ${suggestedBudget(estimate)} runs them by hand`);
    }
    return 1;
  }
  const budget = flags.budget ?? (flags.dry ? null : suggestedBudget(estimate));
  if (flags.budget == null && budget != null) console.log(fmt.muted(`no --budget: stopping at ${formatCost(budget)}, the estimate and half again`));
  // Unattended, the stop is also what is left of the day.
  const stopAt = flags.stale && budget != null ? Math.min(budget, Math.max(0, (flags.daily ?? DAILY_USD) - spentToday())) : budget;

  const spent: RepLedger = { usd: 0 };
  const deadline = flags.maxMinutes ? Date.now() + flags.maxMinutes * 60_000 : null;
  const opts = (plan: Plan, est = 0) => ({ reps: plan.reps, model: flags.model ?? null, dry: Boolean(flags.dry), notes: flags.notes ?? null, batch, budgetUsd: stopAt, spent, estPerRep: est, deadline, onLine: (l: string) => console.log(fmt.muted(l)) });
  // Jobs in surface order, so a stop leaves the later surfaces unreached rather than every surface half run.
  const prepared = new Map(await Promise.all(plans.flatMap((plan) => plan.freezes.map(async (f) => [f.id, await prepareFreeze(f, opts(plan), facts)] as const))));
  const results = await mapLimit(jobs, parallel, (j) => replayRep(prepared.get(j.freeze.id)!, j.rep, repCount(j.plan.reps), opts(j.plan, perRepUsd(j.plan.meta, state, modelOf(j)))));
  const budgetHit = Boolean(spent.stoppedBy);
  let failed = false;
  const report: string[] = [];
  const verdicts: SurfaceVerdict[] = [];
  for (const plan of plans) {
    const outcome = outcomeOf(results.filter((_, i) => jobs[i]!.plan === plan), spent);
    const crashes = outcome.crashes;
    if (!flags.dry) addSpend(outcome.costUsd);
    // The set is the whole batch on these freezes: on a resume, the reps it already held count with the ones run now.
    const history = (await surfaceRuns(plan.meta.id)).filter((r) => plan.freezes.some((f) => f.id === r.freezeId));
    // The previous run set: each freeze's newest other batch of real reps; a dry rep is wiring, never a baseline.
    const v = await setVerdict(plan.meta, batch, history);
    const scored = v.scored;
    // A surface the stop cut off before its first rep never ran: it is named below, not graded.
    if (budgetHit && !scored.length) continue;
    if (!scored.length) unrun.push(plan.meta.id);
    report.push(...v.lines);
    // A dry rep's gates grade canned output, so only a crash fails a dry check.
    if (v.regression || crashes || scored.some((r) => r.status !== 'dry' && r.gatesFailed.length)) failed = true;
    verdicts.push({
      surface: plan.meta.id,
      regression: v.regression,
      gatesFailed: [...new Set(scored.flatMap((r) => r.gatesFailed))],
      failingFreezes: [...majority(scored.filter((r) => r.status !== 'crash'))].filter(([, pass]) => !pass).map(([id]) => id),
      summary: v.lines.map(stripAnsi),
    });

    const hash = hashes.get(plan.meta.id)!;
    // What reps cost on each model, from the reps this run made (a resumed batch's earlier reps ran under another load).
    const real = outcome.runs.filter((r) => r.status !== 'unscored' && r.status !== 'crash' && r.status !== 'dry');
    // A surface the stop cut short has not run on these sources, so it stays stale for the next firing.
    const cutShort = budgetHit && scored.length < plan.freezes.length * repCount(plan.reps);
    if (flags.state !== false) patchSurfaceState(plan.meta.id, (s) => ({
      ...s,
      crash: crashes ? { hash, count: s.crash?.hash === hash ? s.crash.count + 1 : 1 } : undefined,
      ...(flags.dry || crashes || cutShort ? {} : { lastRunHash: hash }),
      ...(!flags.dry && real.length ? { perRep: { ...s.perRep, ...repCostsByModel(real, plan.meta.model) } } : {}),
    }));
  }

  console.log('');
  for (const line of report) console.log(line);
  const neverReached = plans.filter((p) => !verdicts.some((v) => v.surface === p.meta.id)).map((p) => p.meta.id);
  if (budgetHit) console.log(fmt.warning(`stopped: ${spent.stoppedBy === 'time' ? `the ${flags.maxMinutes} minute limit passed` : `the ${formatCost(stopAt ?? 0)} budget is spent`} (endedBecause: budget)${neverReached.length ? `; never reached: ${neverReached.join(', ')}` : ''} (exit ${EXIT_INCOMPLETE})`));
  if (unrun.length) console.log(fmt.warning(`incomplete: ${[...new Set(unrun)].join(', ')} scored no rep here (exit ${EXIT_INCOMPLETE})`));
  console.log(`\nNext: ./evals runs list --since 1h · ./evals freeze results <freeze> · ./evals runs diff <A> <B>`);
  const published = flags.publish ? await publishSite({ since: '24h' }) : undefined;
  if (flags.signal) {
    const lines = reportSignals(verdicts.flatMap((v) => evalSignals(v, published?.url)), { dry: flags.dry });
    console.log(lines.length ? `\nSignals:\n${lines.map((l) => `  ${l}`).join('\n')}` : '\nSignals: none, every surface held');
  }
  if (failed) return 1;
  return budgetHit || unrun.length ? EXIT_INCOMPLETE : 0;
}

export function registerCheck(program: Command, sources: EvalSources): void {
  program
    .command('check [surfaces...]')
    .description('replay every freeze of each surface, grade every rep, and compare with the previous run set')
    .option('--stale', 'only the surfaces `stale` names; agent surfaces get a manual-run notice instead')
    .option('--route <route>', 'call or agent')
    .option('--freeze <id>', 'only this freeze (repeatable, prefix ok)', (v: string, all: string[]) => [...all, v], [] as string[])
    .option('--reps <n>', 'reps per freeze (default: the surface meta, 5 for calls)', positiveNumber('--reps', true))
    .option('--model <id>', 'ablate the model under test; the judge is unaffected')
    .option('--budget <usd>', 'refuse when the estimate is over, stop when the spend reaches it (default: stop at the estimate and half again)', positiveNumber('--budget'))
    .option('--daily <usd>', `with --stale: refuse once today's spend reaches this (default ${DAILY_USD})`, positiveNumber('--daily'))
    .option('--max-minutes <n>', 'start no rep after this many minutes; stops like the budget (exit 3)', positiveNumber('--max-minutes'))
    .option('--parallel <n>', `reps in flight at once, across freezes and surfaces (default ${DEFAULT_PARALLEL})`, positiveNumber('--parallel', true))
    .option('--dry', 'canned model output: proves the wiring, spends nothing')
    .option('--notes <text>', 'what changed, kept on every rep')
    .option('--publish', 'publish the report afterwards')
    .option('--batch <id>', 'name this run set (default: the start time)')
    .option('--no-state', 'leave the cadence state untouched')
    .option('--signal', 'file a signal for each regression, failed gate and failing freeze (with --dry: print them)')
    .action(async (ids: string[], flags: CheckFlags) => {
      process.exitCode = await runCheck(ids, flags, sources);
    });
}
