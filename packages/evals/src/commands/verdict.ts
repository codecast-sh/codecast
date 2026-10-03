import { InvalidArgumentError } from 'commander';
import type { RunSummary } from '@platform/evals';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';

import { repPassed } from '../adapters/replay';
import { codecastRunSource, rulerOf, type SurfaceRun } from '../adapters/runs';
import { loadSurface } from '../registry';
import { separate, separationLine } from '../stats';
import type { SurfaceMeta } from '../surface';
import { positiveValue } from './stale';

// A run set and its verdict, as `check` prints it and `publish` and `line`
// read it: the set a batch holds, the previous set it is weighed against, and
// the lines that compare them, with the flag parser the commands share. A
// leaf: it imports no command module but stale's flag parser, so every
// command can import it.

/** A commander parser for a positive number; NaN would disable every spend check, so it is a usage error. */
export const positiveNumber = (flag: string, integer = false) => (v: string): number => {
  const n = positiveValue(v, integer);
  if (n == null) throw new InvalidArgumentError(`${flag} takes a positive ${integer ? 'whole number' : 'number'}, not "${v}"`);
  return n;
};

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

/** Why a newer batch on a freeze was passed over for the previous set: it ran on another model, or a judge other than the current set's graded it. */
export interface SkippedBatch {
  batch: string;
  freezeId: string;
  why: 'model' | 'judge';
}

/** What a rep is weighed on: the model it answered on and the judge's ruler (rulerOf). */
const footing = (r: SurfaceRun, ruler: (r: SurfaceRun) => string | null) => ({ model: r.model ?? null, ruler: ruler(r) });

/**
 * The run set a check is weighed against: for each freeze, the reps of the
 * newest other batch that graded it on the current set's footing, the same
 * model and the same judge ruler (rulerOf). A later run of one freeze then
 * never hides the other freezes' sets; a batch whose reps on a freeze all
 * crashed graded nothing there; and a batch on another model, or judged by
 * another prompt or criterion, would read the model or the ruler as a prompt
 * change. The comparison falls back past each of those, and `skipped` names
 * the newer batches it passed over for a footing that differs.
 */
export function previousRuns(history: SurfaceRun[], batch: string, ruler: (r: SurfaceRun) => string | null = rulerOf): { set: SurfaceRun[]; skipped: SkippedBatch[] } {
  const want = new Map<string, ReturnType<typeof footing>>();
  for (const r of batchSet(history, batch)) if (r.status !== 'crash' && !want.has(r.freezeId ?? '')) want.set(r.freezeId ?? '', footing(r, ruler));
  const real = history.filter((r) => r.batch && r.batch !== batch && r.status !== 'dry' && r.status !== 'unscored');
  // One graded rep per freeze and batch stands for the batch there: a model and a judge apply to a whole batch, and a rejudge to every rep of it.
  const graded = new Map<string, SurfaceRun>();
  for (const r of real) if (r.status !== 'crash' && !graded.has(`${r.freezeId}\x1f${r.batch}`)) graded.set(`${r.freezeId}\x1f${r.batch}`, r);
  const newest = new Map<string, string>();
  const skipped: SkippedBatch[] = [];
  for (const r of [...graded.values()].sort((x, y) => (y.batch! < x.batch! ? -1 : y.batch! > x.batch! ? 1 : 0))) {
    const freezeId = r.freezeId ?? '';
    if (newest.has(freezeId)) continue;
    const w = want.get(freezeId);
    const f = w ? footing(r, ruler) : null;
    if (w && f && (f.model !== w.model || f.ruler !== w.ruler)) {
      skipped.push({ batch: r.batch!, freezeId, why: f.model !== w.model ? 'model' : 'judge' });
      continue;
    }
    newest.set(freezeId, r.batch!);
  }
  return { set: onePerSeed(real.filter((r) => newest.get(r.freezeId ?? '') === r.batch)), skipped };
}

/** The previous run set alone (previousRuns). */
export const previousRunSet = (history: SurfaceRun[], batch: string, ruler?: (r: SurfaceRun) => string | null): SurfaceRun[] => previousRuns(history, batch, ruler).set;

/** How many of its own earlier batches a cadence batch is weighed against by default (check --baseline-batches). */
export const CADENCE_BASELINE_BATCHES = 7;

/**
 * The pooled baseline a cadence batch is weighed against: for each freeze, the
 * reps of the newest `n` other batches of the same cadence on the current
 * set's footing (previousRuns, taken n times over). Only runs stamped with the
 * cadence join it, so no other run's notes can move it, and one unlucky rep
 * among n nights moves nothing: only a shift the pool disagrees with separates.
 */
export function pooledRuns(history: SurfaceRun[], batch: string, cadence: string, n: number, ruler: (r: SurfaceRun) => string | null = rulerOf): { set: SurfaceRun[]; skipped: SkippedBatch[]; batches: string[] } {
  let rest = history.filter((r) => r.batch === batch || r.cadence === cadence);
  const set: SurfaceRun[] = [];
  const skipped = new Map<string, SkippedBatch>();
  for (let i = 0; i < n; i++) {
    const prev = previousRuns(rest, batch, ruler);
    if (!prev.set.length) break;
    set.push(...prev.set);
    for (const s of prev.skipped) skipped.set(`${s.batch}\x1f${s.freezeId}`, s);
    const taken = new Set(prev.set.map((r) => `${r.freezeId}\x1f${r.batch}`));
    rest = rest.filter((r) => !taken.has(`${r.freezeId}\x1f${r.batch}`));
  }
  return { set, skipped: [...skipped.values()], batches: [...new Set(set.map((r) => r.batch!))].sort() };
}

/**
 * Where a named baseline (check --against) stands on another footing than
 * the current set: the freezes whose reps ran on another model, or were
 * judged on another ruler. Those freezes are still weighed, so the line says
 * so rather than letting the model or the judge pass for the prompt.
 */
function footingNotes(current: SurfaceRun[], previous: SurfaceRun[], against: string, ruler: (r: SurfaceRun) => string | null): string[] {
  const model = new Set<string>();
  const judge = new Set<string>();
  for (const r of current) {
    const other = previous.find((p) => p.freezeId === r.freezeId);
    if (!other) continue;
    const a = footing(r, ruler);
    const b = footing(other, ruler);
    if (a.model !== b.model) model.add(`${(r.freezeId ?? '').slice(0, 8)} (${b.model ?? '?'} then, ${a.model ?? '?'} now)`);
    if (a.ruler !== b.ruler) judge.add((r.freezeId ?? '').slice(0, 8));
  }
  return [
    ...(model.size ? [`  ${fmt.warning('another model')}: ${[...model].join(', ')}: the comparison weighs the model as well as the prompt`] : []),
    ...(judge.size ? [`  ${fmt.warning('another judge')}: ${[...judge].join(', ')} graded on a different judge prompt or criterion: ./evals rescore --batch ${against} --rejudge puts the baseline on today's`] : []),
  ];
}

/**
 * Pass rate, mean, range and flips of a run set against the previous one on
 * the same surface, and how many of its reps read the live workspace. The
 * comparison covers only the freezes both sets ran, so a one-freeze run is
 * never weighed against a whole surface. A crash graded nothing (the model
 * never answered, or the agent left its world), so it is counted apart and
 * weighed as neither a pass nor a 0, on either side.
 */
function verdictLines(meta: SurfaceMeta, batch: string, set: SurfaceRun[], previousSet: SurfaceRun[], o: { against?: string; basis?: string; skipped?: SkippedBatch[]; ruler?: (r: SurfaceRun) => string | null } = {}): { lines: string[]; regression: boolean } {
  const { against, skipped = [], ruler = rulerOf } = o;
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
    `  ${o.basis ? `${o.basis}: ` : against ? `against ${against}: ` : ''}${previous.length ? `${separationLine(compared, previous.map(scoreOrZero))}${compared.length < scores.length ? ` (over the ${ranBefore.size} freeze(s) the previous set ran)` : ''}` : 'no previous run set to compare with'}`,
  ];
  if (against) lines.push(...footingNotes(current, previous, against, ruler));
  // Newer batches the default comparison passed over, so a missing or older baseline is never a mystery.
  const passedOver = (why: SkippedBatch['why']) => [...new Set(skipped.filter((s) => s.why === why && ranNow.has(s.freezeId)).map((s) => s.batch))];
  if (passedOver('model').length) lines.push(fmt.muted(`  passed over ${passedOver('model').join(', ')}: another model on the same freezes`));
  if (passedOver('judge').length) lines.push(fmt.muted(`  passed over ${passedOver('judge').join(', ')}: judged on another ruler; ./evals rescore --batch <it> --rejudge brings it onto today's`));
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
 * print from here. `against` names the batch to weigh it with (check
 * --against). Without it, a cadence batch (its reps stamped by check
 * --cadence) is weighed against its own last `baselineBatches` batches pooled
 * (pooledRuns), and any other against each freeze's newest other batch.
 */
export async function setVerdict(meta: SurfaceMeta, batch: string, history: SurfaceRun[], against?: string, baselineBatches = CADENCE_BASELINE_BATCHES): Promise<{ lines: string[]; regression: boolean; scored: SurfaceRun[] }> {
  const scored = batchSet(history, batch);
  const cadence = scored.find((r) => r.cadence)?.cadence;
  let basis: string | undefined;
  let prev: { set: SurfaceRun[]; skipped: SkippedBatch[] };
  if (against) prev = { set: batchSet(history, against), skipped: [] };
  else if (cadence) {
    const pooled = pooledRuns(history, batch, cadence, baselineBatches);
    prev = pooled;
    const [first, k] = [pooled.batches[0], pooled.batches.length];
    basis = !k ? `${cadence}: building its baseline` : k === 1 ? `against the last ${cadence} batch (${first}, ${pooled.set.length} reps)` : `against the last ${k} ${cadence} batches pooled (${first} to ${pooled.batches.at(-1)}, ${pooled.set.length} reps)`;
  } else prev = previousRuns(history, batch);
  const v = verdictLines(meta, batch, scored, prev.set, { against, basis, skipped: prev.skipped });
  const impl = await loadSurface(meta.id);
  if (impl.summarize) {
    const details = await Promise.all(scored.map((r) => codecastRunSource().get(r.id)));
    v.lines.push(...impl.summarize(details.flatMap((d) => (d?.verdict ? [d.verdict] : []))).map((l) => `  ${l}`));
  }
  return { ...v, scored };
}
