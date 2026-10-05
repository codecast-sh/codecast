import { join } from 'node:path';

import type { Command } from 'commander';
import { mapLimit } from '@codecast/shared/async';
import type { EvalSources, Freeze } from '@platform/evals';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';
import { stripAnsi } from '@platform/cli-kit/render';

import { acquireLock, releaseLock, type LockOptions } from '../../../cli/src/capabilities/lock';
import { outcomeOf, prepareFreeze, repCount, replayModel, replayRep, treeFacts, type RepLedger } from '../adapters/replay';
import { agentScratchGap } from '../adapters/dryRun';
import { hasSnapshot, loadLabel, loadSnapshot } from '../adapters/resolver';
import { surfaceRuns } from '../adapters/runs';
import { loadSurface } from '../registry';
import { homePaths } from '../paths';
import { checkMinutes, DAILY_USD, patchSurfaceState, perRepPeakUsd, perRepUsd, readState, repCostsByModel, spentToday, staleness, suggestedBudget, type EvalsState } from '../state';
import { evalSignals, reportSignals, type SurfaceVerdict } from '../signals';
import { holdsAcross, type Separation } from '../stats';
import type { SurfaceMeta } from '../surface';
import { publishSite } from './publish';
import { pickSurfaces } from './stale';
import { batchSet, BISECT_CADENCE, CADENCE_BASELINE_BATCHES, majority, positiveNumber, setVerdict } from './verdict';

export { BISECT_CADENCE };

// `./evals check`: replay every freeze of each chosen surface, grade every
// rep, and print a verdict per surface against its previous run set. It
// estimates the spend first and refuses past --budget (with none given, it
// stops at the estimate and half again; with --stale, it runs the surfaces
// that fit, stale longest first, and leaves the rest stale for the next
// firing), stops mid-run when the budget is
// spent, and exits 1 on a refusal, a gate failure, a crash or a separated
// regression, and EXIT_INCOMPLETE when part of what was asked never ran. A
// bare `check` runs the call surfaces only: agent surfaces run by name or
// with --route agent. Every rep of every freeze goes through one pool of
// --parallel slots, so a wide check finishes in a fraction of its serial time.
// A --batch that already holds reps resumes it: only the reps it lacks or
// that crashed run, and the verdict covers the whole set. --against weighs the
// set against one named batch instead of each freeze's newest other one, so
// an ablation compares the variant with its own baseline whatever ran since.
// --cadence names a standing run (the nightly): its reps carry the name, and
// its set is weighed against that cadence's own last batches night by night
// per freeze, so drift is a `separated: worse` decided here, and nothing
// else's reps join that baseline.
// --cadence bisect marks a bisect's probe reps: they ran some other commit, so
// they leave the cadence state alone and are no baseline. --stop-file cancels
// between reps. A named --batch is held by one check at a time (its lock under
// EVALS_HOME/locks), so a retried firing never runs the same reps twice. A
// separated `worse` is a regression only when it holds across every surface
// the check weighed (Holm), so a wide check is not a lottery of false alarms.

/** The exit code of a check that stopped short: a budget stop, or a requested surface with no rep scored. */
export const EXIT_INCOMPLETE = 3;

/**
 * Reps in flight at once by default. Each rep is a harness process plus a
 * `claude -p`, so this stays modest for a loaded machine; measured on
 * 2026-10-02 at load 400 to 800 (docs/architecture/evals-home.md 2.9).
 */
export const DEFAULT_PARALLEL = 4;

/** The lock a named batch is held by while a check runs on it: one file per batch, stale once its pid is gone. */
export const batchLock = (batch: string): LockOptions & { root: string } => ({ root: join(homePaths().root, 'locks'), name: `${batch.replace(/[^\w.-]/g, '_')}.lock`, ceilingMs: Infinity });

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
  /** Weigh the set against this named batch instead of each freeze's newest other batch. */
  against?: string;
  /** The standing run this check is (the nightly): stamped on every rep, and the set is weighed against this cadence's own last --baseline-batches batches pooled. */
  cadence?: string;
  /** How many of the cadence's earlier batches the pooled baseline holds (default CADENCE_BASELINE_BATCHES). */
  baselineBatches?: number;
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
  /** Start no rep once this file exists: the run stops like a budget stop, and exits EXIT_INCOMPLETE. */
  stopFile?: string;
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

export async function runCheck(ids: string[], flags: CheckFlags, sources: EvalSources): Promise<number> {
  if (!flags.batch) return checkBatch(ids, flags, sources);
  // A second check on a batch another is still running would see its queued reps as missing and run them too, on a budget of its own.
  const { root, ...lock } = batchLock(flags.batch);
  const held = acquireLock(root, (l) => console.log(fmt.muted(l)), lock);
  if (!held.acquired) {
    console.log(`refused: batch ${flags.batch} is being run by pid ${held.heldBy?.pid ?? '?'} (since ${held.heldBy?.acquired_at ?? '?'}); a second check would run its reps twice. Wait for it, or stop it with its --stop-file, then run this again to resume (exit ${EXIT_INCOMPLETE})`);
    return EXIT_INCOMPLETE;
  }
  try {
    return await checkBatch(ids, flags, sources);
  } finally {
    releaseLock(root, lock);
  }
}

async function checkBatch(ids: string[], flags: CheckFlags, sources: EvalSources): Promise<number> {
  const store = sources.freezes!;
  let metas = pickSurfaces(ids, flags.route);
  const state = readState();
  // A bisect probe ran another commit, so it is never the tree's last run.
  const stateful = flags.state !== false && flags.cadence !== BISECT_CADENCE;
  // A dry or --no-state run leaves the cadence alone: no notice silenced, no refusal recorded. Real spend always counts toward the day.
  const keepState = !flags.dry && stateful;
  if (!ids.length && !flags.route && !flags.stale) {
    const agents = metas.filter((m) => m.route === 'agent');
    if (agents.length) console.log(fmt.muted(`left out the agent surfaces (${agents.map((m) => m.id).join(', ')}): they run by hand, by name or with --route agent`));
    metas = metas.filter((m) => m.route === 'call');
  }

  /** With --stale: each surface's source hash at HEAD, which a budget refusal records. */
  let staleHashes = new Map<string, string>();
  if (flags.stale) {
    const daily = flags.daily ?? DAILY_USD;
    const spent = spentToday();
    if (!flags.dry && spent >= daily) {
      console.log(`refused: ${formatCost(spent)} spent today reaches the ${formatCost(daily)} daily ceiling for unattended runs; the next day's firing runs it, or ./evals check by hand`);
      return 1;
    }
    const { due, waiting, hashes } = staleness(metas, state, undefined, flags.budget);
    staleHashes = hashes;
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
  let plans: Plan[] = [];
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
  let jobs: Job[] = plans.flatMap((plan) => plan.freezes.flatMap((freeze) => Array.from({ length: repCount(plan.reps) }, (_, i) => ({ plan, freeze, rep: i + 1 })).filter((j) => !done.has(`${freeze.id}:${j.rep}`))));
  if (done.size) console.log(`resuming batch ${batch}: ${done.size} rep(s) already scored there are not run again`);
  // Each rep is estimated on the model its freeze replays on, from that model's own history.
  const modelOf = (j: Job) => replayModel(j.plan.meta, j.freeze, flags.model);
  const usdOf = (js: Job[]) => js.reduce((s, j) => s + perRepUsd(j.plan.meta, state, modelOf(j)), 0);
  // Unattended, a stale set over what the budget and the day leave runs the surfaces that fit, stale longest first; the rest stay stale for the next firing. A dry run picks the same set, so it previews a firing.
  const fit = flags.stale && flags.budget != null ? fitBudget(plans, (p) => usdOf(jobs.filter((j) => j.plan === p)), flags.budget, Math.min(flags.budget, Math.max(0, (flags.daily ?? DAILY_USD) - spentToday())), state) : null;
  if (fit && (fit.deferred.length || fit.refused.length)) {
    const named = (ps: Plan[]) => ps.map((p) => `${p.meta.id} (${formatCost(fit.usd.get(p)!)})`).join(', ');
    if (fit.deferred.length) console.log(`deferred, stale for the next firing: ${named(fit.deferred)}; together they are over what --budget ${formatCost(flags.budget!)} and the day leave after ${fit.run.map((p) => p.meta.id).join(', ') || 'nothing'}`);
    if (fit.refused.length) {
      console.log(`refused: ${named(fit.refused)} alone over the --budget ${formatCost(flags.budget!)}`);
      // An unattended refusal is named once per source change: later firings leave these surfaces for a run by hand, or for a bigger --budget.
      if (keepState) {
        for (const p of fit.refused) patchSurfaceState(p.meta.id, (s) => ({ ...s, lastRefusedHash: staleHashes.get(p.meta.id), lastRefusedBudget: flags.budget }));
        console.log(`not retried until their sources change or a firing passes more than --budget ${flags.budget}: ./evals check ${fit.refused.map((p) => p.meta.id).join(' ')} --budget ${suggestedBudget(Math.max(...fit.refused.map((p) => fit.usd.get(p)!)))} runs them by hand`);
      }
    }
    plans = plans.filter((p) => fit.run.includes(p));
    jobs = jobs.filter((j) => fit.run.includes(j.plan));
    if (!plans.length) return fit.refused.length ? 1 : 0;
  }
  const estimate = flags.dry ? 0 : usdOf(jobs);
  const parallel = flags.parallel ?? DEFAULT_PARALLEL;
  // Each agent rep gets private scratch from the harness (ct-56832). Where it
  // cannot, two agents in flight share /tmp and read each other's inputs, so
  // agent reps run one at a time in a lane of their own beside the call reps.
  const isAgent = (j: Job) => j.plan.meta.route === 'agent';
  const scratchGap = parallel > 1 && jobs.filter(isAgent).length > 1 ? await agentScratchGap() : null;
  const lanes = scratchGap ? [{ jobs: jobs.filter((j) => !isAgent(j)), slots: parallel }, { jobs: jobs.filter(isAgent), slots: 1 }] : [{ jobs, slots: parallel }];
  if (scratchGap) console.log(fmt.muted(`agent reps run one at a time: their scratch is not private here (${scratchGap}); call reps keep --parallel ${parallel}`));
  // The time is what a real run would take, so a dry check sizes one for free. Lanes run side by side: the slowest sets it.
  const laneMinutes = lanes.map((l) => checkMinutes(l.jobs.map((j) => ({ meta: j.plan.meta, reps: 1, model: modelOf(j) })), state, l.slots));
  const minutes = laneMinutes.includes(null) ? null : Math.max(...(laneMinutes as number[]));
  const took = minutes != null ? `about ${Math.ceil(minutes)} min at --parallel ${parallel}${scratchGap ? ', agent reps one at a time' : ''}` : null;
  console.log(`${jobs.length} reps over ${plans.length} surface(s), estimated ${formatCost(estimate)}${flags.dry ? ` (dry: nothing is spent${took ? `; a real run takes ${took}` : ''})` : took ? ` and ${took}` : ''}`);
  if (minutes != null && flags.maxMinutes && minutes > flags.maxMinutes) console.log(fmt.warning(`the time estimate is over --max-minutes ${flags.maxMinutes}: expect a time stop; fewer --reps or more --parallel`));
  const facts = treeFacts(plans.map((p) => p.meta));
  const hashes = facts.hashes;
  // A stale run has already fitted its surfaces to the budget, so only a check by hand refuses here.
  if (flags.budget != null && estimate > flags.budget) {
    console.log(`refused: the estimate ${formatCost(estimate)} is over the --budget ${formatCost(flags.budget)}; fewer --reps, fewer surfaces, or a bigger budget`);
    return 1;
  }
  const budget = flags.budget ?? (flags.dry ? null : suggestedBudget(estimate));
  if (flags.budget == null && budget != null) console.log(fmt.muted(`no --budget: stopping at ${formatCost(budget)}, the estimate and half again`));
  // Unattended, the stop is also what is left of the day.
  const stopAt = flags.stale && budget != null ? Math.min(budget, Math.max(0, (flags.daily ?? DAILY_USD) - spentToday())) : budget;

  const spent: RepLedger = { usd: 0 };
  const deadline = flags.maxMinutes ? Date.now() + flags.maxMinutes * 60_000 : null;
  const opts = (plan: Plan, est = 0, peak = 0) => ({ reps: plan.reps, model: flags.model ?? null, dry: Boolean(flags.dry), notes: flags.notes ?? null, batch, cadence: flags.cadence ?? null, budgetUsd: stopAt, spent, estPerRep: est, peakPerRep: peak, deadline, stopFile: flags.stopFile ?? null, onLine: (l: string) => console.log(fmt.muted(l)) });
  // Jobs in surface order, so a stop leaves the later surfaces unreached rather than every surface half run.
  const prepared = new Map(await Promise.all(plans.flatMap((plan) => plan.freezes.map(async (f) => [f.id, await prepareFreeze(f, opts(plan), facts)] as const))));
  const runJob = (j: (typeof jobs)[number]) => replayRep(prepared.get(j.freeze.id)!, j.rep, repCount(j.plan.reps), opts(j.plan, perRepUsd(j.plan.meta, state, modelOf(j)), perRepPeakUsd(j.plan.meta, state, modelOf(j))));
  const laneResults = await Promise.all(lanes.map((l) => mapLimit(l.jobs, l.slots, runJob)));
  const resultOf = new Map(lanes.flatMap((l, i) => l.jobs.map((j, k) => [j, laneResults[i]![k]!] as const)));
  const results = jobs.map((j) => resultOf.get(j)!);
  const budgetHit = Boolean(spent.stoppedBy);
  let failed = false;
  const reports: string[][] = [];
  const verdicts: SurfaceVerdict[] = [];
  const separations: Separation[] = [];
  for (const plan of plans) {
    const outcome = outcomeOf(results.filter((_, i) => jobs[i]!.plan === plan), spent);
    const crashes = outcome.crashes;
    // The set is the whole batch on these freezes: on a resume, the reps it already held count with the ones run now.
    const history = (await surfaceRuns(plan.meta.id)).filter((r) => plan.freezes.some((f) => f.id === r.freezeId));
    // The previous run set: each freeze's newest other batch of real reps, or a cadence's own batches pooled; a dry rep is wiring, never a baseline.
    const v = await setVerdict(plan.meta, batch, history, flags.against, flags.baselineBatches);
    const scored = v.scored;
    // A surface the stop cut off before its first rep never ran: it is named below, not graded.
    if (budgetHit && !scored.length) continue;
    if (!scored.length) unrun.push(plan.meta.id);
    reports.push(v.lines);
    separations.push(v.verdict.separation);
    // A dry rep's gates grade canned output, so only a crash fails a dry check.
    if (crashes || scored.some((r) => r.status !== 'dry' && r.gatesFailed.length)) failed = true;
    verdicts.push({
      surface: plan.meta.id,
      regression: v.regression,
      gatesFailed: [...new Set(scored.flatMap((r) => r.gatesFailed))],
      failingFreezes: [...majority(scored.filter((r) => r.status !== 'crash'))].filter(([, pass]) => !pass).map(([id]) => id),
      summary: v.lines.map(stripAnsi),
      batch,
    });

    const hash = hashes.get(plan.meta.id)!;
    // What reps cost on each model, from the reps this run made (a resumed batch's earlier reps ran under another load).
    const real = outcome.runs.filter((r) => r.status !== 'unscored' && r.status !== 'crash' && r.status !== 'dry');
    // A surface the stop cut short has not run on these sources, so it stays stale for the next firing.
    const cutShort = budgetHit && scored.length < plan.freezes.length * repCount(plan.reps);
    // The hash names HEAD's sources; a checkout with them dirty graded something else, so it is not their run.
    const dirty = facts.dirty.has(plan.meta.id);
    if (stateful) patchSurfaceState(plan.meta.id, (s) => ({
      ...s,
      crash: crashes ? { hash, count: s.crash?.hash === hash ? s.crash.count + 1 : 1 } : undefined,
      ...(flags.dry || crashes || cutShort || dirty ? {} : { lastRunHash: hash, lastRunAt: new Date().toISOString() }),
      ...(!flags.dry && real.length ? { perRep: { ...s.perRep, ...repCostsByModel(real, plan.meta.model) } } : {}),
    }));
  }

  // A worse separation is a regression only when it holds across every surface this check weighed.
  const holds = holdsAcross(separations);
  const tested = separations.filter((x) => x.kind !== 'too-few').length;
  verdicts.forEach((v, i) => {
    const s = separations[i]!;
    if (!v.regression || holds[i] || s.kind !== 'worse') return;
    const note = `  ${fmt.muted(`not a regression: p=${s.p.toFixed(4)} does not hold across the ${tested} surfaces this check weighed (Holm)`)}`;
    reports[i]!.splice(2, 0, note);
    v.summary.splice(2, 0, stripAnsi(note));
    v.regression = false;
  });
  if (verdicts.some((v) => v.regression)) failed = true;
  console.log('');
  for (const line of reports.flat()) console.log(line);
  const neverReached = plans.filter((p) => !verdicts.some((v) => v.surface === p.meta.id)).map((p) => p.meta.id);
  const stopWhy = spent.stoppedBy === 'stop-file' ? `${flags.stopFile} exists` : spent.stoppedBy === 'time' ? `the ${flags.maxMinutes} minute limit passed` : `the ${formatCost(stopAt ?? 0)} budget is spent`;
  if (budgetHit) console.log(fmt.warning(`stopped: ${stopWhy} (endedBecause: budget)${neverReached.length ? `; never reached: ${neverReached.join(', ')}` : ''} (exit ${EXIT_INCOMPLETE})`));
  if (unrun.length) console.log(fmt.warning(`incomplete: ${[...new Set(unrun)].join(', ')} scored no rep here (exit ${EXIT_INCOMPLETE})`));
  console.log(`\nNext: ./evals runs list --since 1h · ./evals freeze results <freeze> · ./evals runs diff <A> <B>`);
  // A signal cites the published report as its evidence, so --signal publishes whenever it will file one.
  const signalling = flags.signal && !flags.dry && verdicts.some((v) => evalSignals(v).length > 0);
  const published = flags.publish || signalling ? await publishSite({ since: '24h' }) : undefined;
  if (flags.signal) {
    const lines = reportSignals(verdicts.flatMap((v) => evalSignals(v, published?.url)), { dry: flags.dry });
    console.log(lines.length ? `\nSignals:\n${lines.map((l) => `  ${l}`).join('\n')}` : '\nSignals: none, every surface held');
  }
  if (failed || fit?.refused.length) return 1;
  return budgetHit || unrun.length ? EXIT_INCOMPLETE : 0;
}

/**
 * Which stale surfaces a budget runs: the longest stale first (the oldest
 * lastRunAt, never run first), each while it fits in `room` (the budget, or
 * less when the day's ceiling leaves less). A surface over the budget alone
 * is refused; one that fits alone but not beside the others is deferred, and
 * being staler next time, it goes first then.
 */
export function fitBudget<P extends { meta: SurfaceMeta }>(plans: P[], usd: (p: P) => number, budget: number, room: number, state: EvalsState): { run: P[]; deferred: P[]; refused: P[]; usd: Map<P, number> } {
  const costs = new Map(plans.map((p) => [p, usd(p)]));
  const order = [...plans].sort((a, b) => (state[a.meta.id]?.lastRunAt ?? '').localeCompare(state[b.meta.id]?.lastRunAt ?? ''));
  const out = { run: [] as P[], deferred: [] as P[], refused: [] as P[], usd: costs };
  let used = 0;
  for (const p of order) {
    const c = costs.get(p)!;
    if (c > budget) out.refused.push(p);
    else if (used + c <= room) {
      out.run.push(p);
      used += c;
    } else out.deferred.push(p);
  }
  return out;
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
    .option('--budget <usd>', "refuse when the estimate is over; start no rep whose likely cost (the costliest recent rep on its surface and model) would cross it, while reps in flight finish (default: the estimate and half again)", positiveNumber('--budget'))
    .option('--daily <usd>', `with --stale: refuse once today's spend reaches this (default ${DAILY_USD})`, positiveNumber('--daily'))
    .option('--max-minutes <n>', 'start no rep after this many minutes; stops like the budget (exit 3)', positiveNumber('--max-minutes'))
    .option('--stop-file <path>', 'start no rep once this file exists; stops like the budget (exit 3)')
    .option('--parallel <n>', `reps in flight at once, across freezes and surfaces (default ${DEFAULT_PARALLEL})`, positiveNumber('--parallel', true))
    .option('--dry', 'canned model output: proves the wiring, spends nothing')
    .option('--notes <text>', 'what changed, kept on every rep')
    .option('--publish', 'publish the report afterwards')
    .option('--batch <id>', 'name this run set (default: the start time)')
    .option('--against <batch>', "weigh the set against this named batch instead of each freeze's newest other one")
    .option('--cadence <name>', `stamp every rep as this standing run's (e.g. nightly) and weigh the set against the cadence's own last batches pooled; ${BISECT_CADENCE} marks a bisect's probes, which leave the cadence state alone`)
    .option('--baseline-batches <n>', `with --cadence: how many earlier batches the pooled baseline holds (default ${CADENCE_BASELINE_BATCHES})`, positiveNumber('--baseline-batches', true))
    .option('--no-state', 'leave the cadence state untouched')
    .option('--signal', 'file a signal for each regression, failed gate and failing freeze, citing the published report (publishes it when one is filed; with --dry: print them)')
    .action(async (ids: string[], flags: CheckFlags) => {
      process.exitCode = await runCheck(ids, flags, sources);
    });
}
