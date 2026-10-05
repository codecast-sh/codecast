import { InvalidArgumentError } from 'commander';
import type { BatchVerdict, SkippedBatch } from '@codecast/shared/contracts/evalsApi';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';

import { repPassed } from '../adapters/replay';
import { codecastRunSource, rulerOf, type SurfaceRun } from '../adapters/runs';
import { batchSet, CADENCE_BASELINE_BATCHES, makeVerdict, type RulerOf, type VerdictRun } from '../core/verdict';
import { loadSurface } from '../registry';
import { separationLine } from '../stats';
import type { SurfaceMeta } from '../surface';
import { positiveValue } from './stale';

export type { SkippedBatch };
export { askedSet, BISECT_CADENCE, batchSet, batchStarts, CADENCE_BASELINE_BATCHES, footingChange, gradedSet, nightStrata, onePerSeed, scoreOrZero, upTo } from '../core/verdict';
export type { BatchVerdictOptions, RulerOf, VerdictRun } from '../core/verdict';

// Codecast's verdict: the pure verdict (core/verdict.ts) bound to codecast's
// policy, a rep passes by repPassed and is judged on its ruler (the index's,
// else read from its folder), plus the lines `check` prints. `check`,
// `publish` and `line` read it, and the Evals UI shows it. A leaf: it imports
// no command module but stale's flag parser, so every command and history/
// module can import it.

/** The ruler a rep was judged on: the index's, else read from its folder (rulerOf). */
export const defaultRuler: RulerOf = (r) => (r.ruler !== undefined ? r.ruler : rulerOf(r));

/** The verdict bound to codecast's policy. */
export const codecastVerdict = makeVerdict<VerdictRun>({ passed: (r) => repPassed(r), ruler: defaultRuler });

export const { majority, footingOf, previousRuns, previousRunSet, pooledRuns, verdictFlips, batchStats, batchFlips, batchVerdict } = codecastVerdict;

/** A commander parser for a positive number; NaN would disable every spend check, so it is a usage error. */
export const positiveNumber = (flag: string, integer = false) => (v: string): number => {
  const n = positiveValue(v, integer);
  if (n == null) throw new InvalidArgumentError(`${flag} takes a positive ${integer ? 'whole number' : 'number'}, not "${v}"`);
  return n;
};

/** The basis a verdict's second line opens with: the pooled nights, or the named batch. */
function basisOf(v: BatchVerdict): string {
  const b = v.baseline!;
  if (b.kind === 'against') return `against ${b.batches[0]}: `;
  if (b.kind === 'previous') return '';
  const [first, k] = [b.batches[0], b.batches.length];
  return `${!k ? `${b.cadence}: building its baseline` : k === 1 ? `against the last ${b.cadence} batch (${first}, ${b.reps} reps)` : `against the last ${k} ${b.cadence} batches night by night (${first} to ${b.batches.at(-1)}, ${b.reps} reps)`}: `;
}

/** The lines `check` prints for a verdict: the set's numbers, the comparison, and every note on what the comparison weighs. */
export function verdictLinesOf(v: BatchVerdict): string[] {
  const s = v.set;
  if (v.dry) return [`${fmt.bold(v.surface)}  dry: ${s.reps} rep(s) ran through the wiring on canned output; nothing is graded or compared`];
  const b = v.baseline!;
  const compared = v.compared.previous.length > 0;
  const lines = [
    `${fmt.bold(v.surface)}  pass ${s.passed}/${s.reps} (${Math.round((100 * s.passed) / Math.max(1, s.reps))}%)  mean ${(s.mean ?? 0).toFixed(2)}  ${s.min !== null && s.max !== null ? `${s.min.toFixed(2)}-${s.max.toFixed(2)}` : '-'}  flips ${compared ? v.flips.length : '-'}  ${formatCost(s.costUsd)}  ${v.models.join(',')}`,
    `  ${basisOf(v)}${compared ? `${b.kind === 'pooled' && v.separation.kind === 'too-few' ? 'too few nights and freezes to separate (each freeze counts once a night; one freeze alone needs 19 earlier nights)' : separationLine(v.compared.current, v.compared.previous, v.separation)}${v.compared.current.length < s.reps ? ` (over the ${v.compared.previousFreezes} freeze(s) the previous set ran)` : ''}` : 'no previous run set to compare with'}`,
  ];
  const model = new Set(v.footingNotes.flatMap((n) => (n.model ? [`${n.freezeId.slice(0, 8)} (${n.model.then ?? '?'} then, ${n.model.now ?? '?'} now)`] : [])));
  const judge = new Set(v.footingNotes.flatMap((n) => (n.judge ? [n.freezeId.slice(0, 8)] : [])));
  if (model.size) lines.push(`  ${fmt.warning('another model')}: ${[...model].join(', ')}: the comparison weighs the model as well as the prompt`);
  if (judge.size) lines.push(`  ${fmt.warning('another judge')}: ${[...judge].join(', ')} graded on a different judge prompt, criterion or write guard: ./evals rescore --batch ${b.batches[0]} --rejudge puts the baseline on today's (a guard alone needs no --rejudge)`);
  // Newer batches the default comparison passed over, so a missing or older baseline is never a mystery.
  const passedOver = (why: SkippedBatch['why']) => [...new Set(b.skipped.filter((x) => x.why === why).map((x) => x.batch))];
  if (passedOver('model').length) lines.push(fmt.muted(`  passed over ${passedOver('model').join(', ')}: another model on the same freezes`));
  if (passedOver('judge').length) lines.push(fmt.muted(`  passed over ${passedOver('judge').join(', ')}: graded on another ruler (judge or write guard); ./evals rescore --batch <it> --rejudge brings it onto today's (a guard alone needs no --rejudge)`));
  if (v.gatesFailed.length) lines.push(`  ${fmt.error('gates failed')}: ${v.gatesFailed.join(', ')}`);
  // A live read answers from today's workspace, not the frozen moment: such a rep is not reproducible, and its verdict may rest on what the record holds now.
  if (s.liveReads.reps) lines.push(`  ${fmt.warning('live reads')}: ${s.liveReads.reps}/${s.reps} reps read the live workspace (${s.liveReads.reads} reads; ./evals runs show <run> lists them)`);
  if (s.crashes) lines.push(`  ${fmt.error(`${s.crashes} crashed`)}, left out of the numbers above: ./evals runs list --scenario ${v.surface}- --status crash; ./evals check ${v.surface} --batch ${v.batch} with the same --reps and --freeze runs them again`);
  return lines;
}

/**
 * A surface's run set `batch` as `check` reports it: the verdict against its
 * baseline (batchVerdict), then the surface's own summary lines over the reps
 * it scored. `check` and `publish` both print from here.
 */
export async function setVerdict(meta: SurfaceMeta, batch: string, history: SurfaceRun[], against?: string, baselineBatches = CADENCE_BASELINE_BATCHES): Promise<{ lines: string[]; regression: boolean; scored: SurfaceRun[]; verdict: BatchVerdict }> {
  const scored = batchSet(history, batch);
  const verdict = batchVerdict(meta, batch, history, { against, baselineBatches });
  const lines = verdictLinesOf(verdict);
  const impl = await loadSurface(meta.id);
  if (impl.summarize) {
    const details = await Promise.all(scored.map((r) => codecastRunSource().get(r.id)));
    lines.push(...impl.summarize(details.flatMap((d) => (d?.verdict ? [d.verdict] : []))).map((l) => `  ${l}`));
  }
  return { lines, regression: verdict.regression, scored, verdict };
}
