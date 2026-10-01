import type { Command } from 'commander';
import type { EvalSources, Freeze, RunSummary } from '@platform/evals';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';

import { replayFreeze } from '../adapters/replay';
import { hasSnapshot, loadLabel, loadSnapshot } from '../adapters/resolver';
import { codecastRunSource, surfaceRuns } from '../adapters/runs';
import { loadSurface } from '../registry';
import { checkCostUsd, patchSurfaceState, perRepUsd, readState, sourceHashes, staleness } from '../state';
import { separate, separationLine } from '../stats';
import type { SurfaceMeta } from '../surface';
import { publishSite } from './publish';
import { pickSurfaces } from './stale';

// `./evals check`: replay every freeze of each chosen surface, grade every
// rep, and print a verdict per surface against its previous run set. It
// estimates the spend first and refuses past --budget, stops mid-run when the
// budget is spent, and exits 1 on any gate failure, crash or separated
// regression.

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
}

interface Plan {
  meta: SurfaceMeta;
  freezes: Freeze[];
  reps: number;
  perRep: number;
}

const surfaceOf = (f: Freeze): string => String((f.meta as { surface?: string } | undefined)?.surface ?? '');
const scoreOrZero = (r: RunSummary): number => r.score ?? 0;

/** Pass rate, mean, range and flips of a run set against the previous one on the same surface. */
function verdictLines(meta: SurfaceMeta, current: RunSummary[], previous: RunSummary[]): { lines: string[]; regression: boolean } {
  const scores = current.map(scoreOrZero);
  const passed = current.filter((r) => r.status === 'pass').length;
  const mean = scores.reduce((s, x) => s + x, 0) / Math.max(1, scores.length);
  const cost = current.reduce((s, r) => s + r.costUsd, 0);
  const majority = (runs: RunSummary[]) => {
    const by = new Map<string, number[]>();
    for (const r of runs) by.set(r.freezeId ?? '', [...(by.get(r.freezeId ?? '') ?? []), r.status === 'pass' ? 1 : 0]);
    return new Map([...by].map(([k, v]) => [k, v.reduce((s, x) => s + x, 0) * 2 > v.length]));
  };
  const now = majority(current);
  const before = majority(previous);
  const flips = [...now].filter(([k, v]) => before.has(k) && before.get(k) !== v).length;
  const models = [...new Set(current.map((r) => r.model ?? meta.model))].join(',');
  const gatesFailed = [...new Set(current.flatMap((r) => r.gatesFailed))];
  const crashes = current.filter((r) => r.status === 'crash').length;
  const lines = [
    `${fmt.bold(meta.id)}  pass ${passed}/${current.length} (${Math.round((100 * passed) / Math.max(1, current.length))}%)  mean ${mean.toFixed(2)}  ${scores.length ? `${Math.min(...scores).toFixed(2)}-${Math.max(...scores).toFixed(2)}` : '-'}  flips ${previous.length ? flips : '-'}  ${formatCost(cost)}  ${models}`,
    `  ${previous.length ? separationLine(scores, previous.map(scoreOrZero)) : 'no previous run set to compare with'}`,
  ];
  if (gatesFailed.length) lines.push(`  ${fmt.error('gates failed')}: ${gatesFailed.join(', ')}`);
  if (crashes) lines.push(`  ${fmt.error(`${crashes} crashed`)}: ./evals runs list --scenario ${meta.id}- --status crash`);
  const regression = previous.length > 0 && separate(scores, previous.map(scoreOrZero)).kind === 'worse';
  return { lines, regression };
}

export async function runCheck(ids: string[], flags: CheckFlags, sources: EvalSources): Promise<number> {
  const store = sources.freezes!;
  let metas = pickSurfaces(ids, flags.route);
  const state = readState();

  if (flags.stale) {
    const { due, waiting, hashes } = staleness(metas, state);
    for (const m of due.filter((s) => s.route === 'agent')) {
      console.log(`manual run needed: ${m.id} changed at HEAD (agent surfaces never run unattended): ./evals check ${m.id}`);
      patchSurfaceState(m.id, (s) => ({ ...s, lastNotifiedHash: hashes.get(m.id) }));
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
      continue;
    }
    plans.push({ meta, freezes: here, reps: flags.reps ?? meta.reps.check, perRep: perRepUsd(meta, state) });
  }

  const estimate = flags.dry ? 0 : plans.reduce((s, p) => s + checkCostUsd(p.meta, p.freezes.length, state, p.reps), 0);
  const totalReps = plans.reduce((s, p) => s + p.reps * p.freezes.length, 0);
  console.log(`${totalReps} reps over ${plans.length} surface(s), estimated ${formatCost(estimate)}${flags.dry ? ' (dry: nothing is spent)' : ''}`);
  if (flags.budget != null && estimate > flags.budget) {
    console.log(`refused: the estimate ${formatCost(estimate)} is over the --budget ${formatCost(flags.budget)}; fewer --reps, fewer surfaces, or a bigger budget`);
    return 1;
  }

  const batch = new Date().toISOString();
  const spent = { usd: 0 };
  const hashes = sourceHashes(plans.map((p) => p.meta));
  let failed = false;
  let budgetHit = false;
  const report: string[] = [];
  for (const plan of plans) {
    if (budgetHit) break;
    const runs: RunSummary[] = [];
    let crashes = 0;
    for (const f of plan.freezes) {
      const outcome = await replayFreeze(f, { reps: plan.reps, model: flags.model ?? null, dry: Boolean(flags.dry), notes: flags.notes ?? null, batch, budgetUsd: flags.budget ?? null, spent, estPerRep: plan.perRep, onLine: (l) => console.log(fmt.muted(l)) });
      runs.push(...outcome.runs);
      crashes += outcome.crashes;
      if (outcome.budgetHit) {
        budgetHit = true;
        break;
      }
    }
    const scored = runs.filter((r) => r.status !== 'unscored');
    const history = (await surfaceRuns(plan.meta.id)).filter((r) => r.batch && r.batch !== batch && plan.freezes.some((f) => f.id === r.freezeId));
    const lastBatch = history.map((r) => r.batch!).sort().pop();
    const previous = history.filter((r) => r.batch === lastBatch && r.status !== 'unscored');
    const v = verdictLines(plan.meta, scored, previous);
    report.push(...v.lines);
    const impl = await loadSurface(plan.meta.id);
    if (impl.summarize) {
      const details = await Promise.all(scored.map((r) => codecastRunSource().get(r.id)));
      report.push(...impl.summarize(details.flatMap((d) => (d?.verdict ? [d.verdict] : []))).map((l) => `  ${l}`));
    }
    if (v.regression || crashes || scored.some((r) => r.gatesFailed.length)) failed = true;

    const hash = hashes.get(plan.meta.id)!;
    const real = scored.filter((r) => r.status !== 'crash');
    patchSurfaceState(plan.meta.id, (s) => ({
      ...s,
      crash: crashes ? { hash, count: s.crash?.hash === hash ? s.crash.count + 1 : 1 } : undefined,
      ...(flags.dry || crashes ? {} : { lastRunHash: hash }),
      ...(!flags.dry && real.length ? { lastCostPerRep: real.reduce((sum, r) => sum + r.costUsd, 0) / real.length } : {}),
    }));
  }

  console.log('');
  for (const line of report) console.log(line);
  if (budgetHit) console.log(fmt.warning(`stopped: the ${formatCost(flags.budget ?? 0)} budget is spent (endedBecause: budget)`));
  console.log(`\nNext: ./evals runs list --since 1h · ./evals freeze results <freeze> · ./evals runs diff <A> <B>`);
  if (flags.publish) await publishSite({ since: '24h' });
  return failed ? 1 : 0;
}

export function registerCheck(program: Command, sources: EvalSources): void {
  program
    .command('check [surfaces...]')
    .description('replay every freeze of each surface, grade every rep, and compare with the previous run set')
    .option('--stale', 'only the surfaces `stale` names; agent surfaces get a manual-run notice instead')
    .option('--route <route>', 'call or agent')
    .option('--freeze <id>', 'only this freeze (repeatable, prefix ok)', (v: string, all: string[]) => [...all, v], [] as string[])
    .option('--reps <n>', 'reps per freeze (default: the surface meta, 5 for calls)', (v) => Number(v))
    .option('--model <id>', 'ablate the model under test; the judge is unaffected')
    .option('--budget <usd>', 'refuse when the estimate is over, stop when the spend reaches it', (v) => Number(v))
    .option('--dry', 'canned model output: proves the wiring, spends nothing')
    .option('--notes <text>', 'what changed, kept on every rep')
    .option('--publish', 'publish the report afterwards')
    .action(async (ids: string[], flags: CheckFlags) => {
      process.exitCode = await runCheck(ids, flags, sources);
    });
}
