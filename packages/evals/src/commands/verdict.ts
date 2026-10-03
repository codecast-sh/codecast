import { InvalidArgumentError } from 'commander';
import type { BatchStats, BatchVerdict, EvalVisibility, Footing, RunRow, SkippedBatch, VerdictFlip } from '@codecast/shared/contracts/evalsApi';
import type { RunSummary } from '@platform/evals';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';

import { repPassed } from '../adapters/replay';
import { codecastRunSource, rulerOf, type SurfaceRun } from '../adapters/runs';
import { loadSurface } from '../registry';
import { median, separate, separateNights, separationLine, type Stratum } from '../stats';
import type { SurfaceMeta } from '../surface';
import { positiveValue } from './stale';

export type { SkippedBatch };

// A run set and its verdict, as `check` prints it, `publish` and `line` read
// it, and the Evals UI shows it: the set a batch holds, the baseline it is
// weighed against, and the verdict between them as one value (batchVerdict),
// which verdictLinesOf prints. A leaf: it imports no command module but
// stale's flag parser, so every command and history/ module can import it.

/**
 * What the verdict reads from a rep. The CLI hands it SurfaceRuns; the api
 * child hands it the index's RunRows, which also carry the freeze's name and
 * visibility, the judge's spend, the rep's head and its ruler.
 */
export type VerdictRun = Pick<SurfaceRun, 'id' | 'seed' | 'score' | 'gatesFailed' | 'missedFloors' | 'costUsd' | 'batch' | 'cadence' | 'liveReads'> & {
  status: RunSummary['status'];
  freezeId?: string | null;
  model?: string | null;
  createdAt?: string;
} & Partial<Pick<RunRow, 'freezeName' | 'judgeCostUsd' | 'dirty' | 'gitHead' | 'batchAt' | 'stamp' | 'ruler'>> & { visibility?: EvalVisibility };

/** The ruler a rep was judged on: the index's, else read from its folder (rulerOf). */
export type RulerOf<R extends VerdictRun = VerdictRun> = (r: R) => string | null;
export const defaultRuler: RulerOf = (r) => (r.ruler !== undefined ? r.ruler : rulerOf(r));

/** A commander parser for a positive number; NaN would disable every spend check, so it is a usage error. */
export const positiveNumber = (flag: string, integer = false) => (v: string): number => {
  const n = positiveValue(v, integer);
  if (n == null) throw new InvalidArgumentError(`${flag} takes a positive ${integer ? 'whole number' : 'number'}, not "${v}"`);
  return n;
};

export const scoreOrZero = (r: Pick<RunSummary, 'score'>): number => r.score ?? 0;

/** The cadence a bisect's probes run under (check --cadence bisect): a probe ran another commit than the checkout's, so it is never a baseline, never weighed against other probes, and views hide it by default. */
export const BISECT_CADENCE = 'bisect';

/** Each freeze's verdict over its reps: passed by majority. */
export const majority = (runs: VerdictRun[]): Map<string, boolean> => {
  const by = new Map<string, number[]>();
  for (const r of runs) {
    const k = r.freezeId ?? '';
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(repPassed(r) ? 1 : 0);
  }
  return new Map([...by].map(([k, v]) => [k, v.reduce((s, x) => s + x, 0) * 2 > v.length]));
};

/**
 * One rep per batch, freeze and seed, from runs listed newest first
 * (surfaceRuns): a seed a resume ran again after a crash counts once, as its
 * newest rep.
 */
export function onePerSeed<R extends VerdictRun>(runs: R[]): R[] {
  const seen = new Set<string>();
  return runs.filter((r) => {
    const key = `${r.batch}\x1f${r.freezeId}\x1f${r.seed}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A batch's reps as a set: every rep that ran (a stop folder did not), one per freeze and seed. */
export const batchSet = <R extends VerdictRun>(history: R[], batch: string): R[] => onePerSeed(history.filter((r) => r.batch === batch && r.status !== 'unscored'));

/** What a rep is weighed on: the model it answered on and the judge's ruler (rulerOf). */
export const footingOf = <R extends VerdictRun>(r: R, ruler: RulerOf<R> = defaultRuler): Footing => ({ model: r.model ?? null, ruler: ruler(r) });

/** What moved between two footings: the model first, then the judge's ruler; null on the same footing. */
export const footingChange = (a: Footing, b: Footing): 'model' | 'judge' | null => (a.model !== b.model ? 'model' : a.ruler !== b.ruler ? 'judge' : null);

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
export function previousRuns<R extends VerdictRun>(history: R[], batch: string, ruler: RulerOf<R> = defaultRuler): { set: R[]; skipped: SkippedBatch[] } {
  const want = new Map<string, Footing>();
  for (const r of batchSet(history, batch)) if (r.status !== 'crash' && !want.has(r.freezeId ?? '')) want.set(r.freezeId ?? '', footingOf(r, ruler));
  // A bisect probe ran another commit, so it is no baseline for anything.
  const real = history.filter((r) => r.batch && r.batch !== batch && r.status !== 'dry' && r.status !== 'unscored' && r.cadence !== BISECT_CADENCE);
  // One graded rep per freeze and batch stands for the batch there: a model and a judge apply to a whole batch, and a rejudge to every rep of it.
  const graded = new Map<string, R>();
  for (const r of real) if (r.status !== 'crash' && !graded.has(`${r.freezeId}\x1f${r.batch}`)) graded.set(`${r.freezeId}\x1f${r.batch}`, r);
  const newest = new Map<string, string>();
  const skipped: SkippedBatch[] = [];
  for (const r of [...graded.values()].sort((x, y) => (y.batch! < x.batch! ? -1 : y.batch! > x.batch! ? 1 : 0))) {
    const freezeId = r.freezeId ?? '';
    if (newest.has(freezeId)) continue;
    const w = want.get(freezeId);
    const change = w ? footingChange(footingOf(r, ruler), w) : null;
    if (change) {
      skipped.push({ batch: r.batch!, freezeId, why: change });
      continue;
    }
    newest.set(freezeId, r.batch!);
  }
  return { set: onePerSeed(real.filter((r) => newest.get(r.freezeId ?? '') === r.batch)), skipped };
}

/** The previous run set alone (previousRuns). */
export const previousRunSet = <R extends VerdictRun>(history: R[], batch: string, ruler?: RulerOf<R>): R[] => previousRuns(history, batch, ruler).set;

/** How many of its own earlier batches a cadence batch is weighed against by default (check --baseline-batches). */
export const CADENCE_BASELINE_BATCHES = 7;

/**
 * The baseline a cadence batch is weighed against: for each freeze, the reps
 * of the newest `n` other batches of the same cadence on the current set's
 * footing (previousRuns, taken n times over). Only runs stamped with the
 * cadence join it, so no other run's notes can move it. batchVerdict weighs
 * the set against it night by night per freeze (nightStrata), so one unlucky
 * night moves nothing: only a shift the earlier nights disagree with separates.
 */
export function pooledRuns<R extends VerdictRun>(history: R[], batch: string, cadence: string, n: number, ruler: RulerOf<R> = defaultRuler): { set: R[]; skipped: SkippedBatch[]; batches: string[] } {
  let rest = history.filter((r) => r.batch === batch || r.cadence === cadence);
  const set: R[] = [];
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
 * The freezes whose majority verdict differs between two graded sets (crashes
 * left out of both), with the reps behind each side. Only freezes both sets
 * ran can flip. Whether the two stand on one footing is the caller's to
 * decide: flipsBetween refuses when they do not.
 */
export function verdictFlips(current: VerdictRun[], previous: VerdictRun[]): VerdictFlip[] {
  const now = majority(current);
  const before = majority(previous);
  const ids = (runs: VerdictRun[], freezeId: string) => runs.filter((r) => (r.freezeId ?? '') === freezeId).map((r) => r.id);
  return [...now].flatMap(([freezeId, passes]) => {
    if (!before.has(freezeId) || before.get(freezeId) === passes) return [];
    const rep = current.find((r) => (r.freezeId ?? '') === freezeId);
    return [{ freezeId, name: rep?.freezeName ?? freezeId, visibility: rep?.visibility ?? 'private', direction: passes ? 'fixed' : 'broke', before: ids(previous, freezeId), after: ids(current, freezeId) } satisfies VerdictFlip];
  });
}

/**
 * A cadence set against its earlier batches as separateNights weighs them:
 * each freeze both sides graded is a stratum holding the set's mean score on
 * it and each earlier batch's mean, so a freeze counts once on each night
 * however many reps it ran.
 */
export function nightStrata(current: VerdictRun[], previous: VerdictRun[]): Stratum[] {
  const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
  const nights = new Map<string, Map<string, number[]>>();
  for (const r of previous) {
    const f = r.freezeId ?? '';
    if (!nights.has(f)) nights.set(f, new Map());
    const byBatch = nights.get(f)!;
    byBatch.set(r.batch ?? '', [...(byBatch.get(r.batch ?? '') ?? []), scoreOrZero(r)]);
  }
  const now = new Map<string, number[]>();
  for (const r of current) now.set(r.freezeId ?? '', [...(now.get(r.freezeId ?? '') ?? []), scoreOrZero(r)]);
  return [...now].flatMap(([f, xs]) => (nights.has(f) ? [{ current: mean(xs), previous: [...nights.get(f)!.values()].map(mean) }] : []));
}

const separations = new Map<string, BatchVerdict['separation']>();

/**
 * separate() over two score lists, kept: its exact count can take a second
 * on a hundred reps, and the history views weigh the same batches again and
 * again. separate() is deterministic (its sampled tails are seeded), so a
 * kept answer is the answer.
 */
function separationOf(current: number[], previous: number[]): BatchVerdict['separation'] {
  const k = `${current.join(',')}|${previous.join(',')}`;
  const hit = separations.get(k);
  if (hit) return hit;
  const s = separate(current, previous);
  if (separations.size >= 512) separations.delete(separations.keys().next().value!);
  separations.set(k, s);
  return s;
}

/** When a rep ran: the index's batch time, else its stamp or creation time. */
type Timed = Pick<VerdictRun, 'batch' | 'batchAt' | 'stamp' | 'createdAt'>;
const repAt = (r: Timed): string | undefined => r.batchAt ?? r.stamp ?? r.createdAt;

/** A batch's reps as BatchStats: what the strip and the verdict's first line show. Crashes count apart and graded nothing. */
export function batchStats<R extends VerdictRun>(batch: string, set: R[], ruler: RulerOf<R> = defaultRuler): BatchStats {
  const current = set.filter((r) => r.status !== 'crash');
  const scores = current.map(scoreOrZero);
  const passed = current.filter((r) => r.status === 'pass').length;
  const live = current.filter((r) => r.liveReads > 0);
  const first = current[0];
  const times = set.map(repAt).filter((t): t is string => !!t).sort();
  return {
    batch,
    reps: current.length,
    passed,
    median: scores.length ? median(scores) : null,
    mean: scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : null,
    min: scores.length ? Math.min(...scores) : null,
    max: scores.length ? Math.max(...scores) : null,
    // What the set spent, its crashes included.
    costUsd: set.reduce((s, r) => s + r.costUsd, 0),
    batchAt: times[0] ?? batch,
    cadence: set.find((r) => r.cadence)?.cadence ?? null,
    passRate: current.length ? passed / current.length : null,
    crashes: set.length - current.length,
    judgeCostUsd: set.reduce((s, r) => s + (r.judgeCostUsd ?? 0), 0),
    liveReads: { reps: live.length, reads: live.reduce((t, r) => t + r.liveReads, 0) },
    dry: set.length > 0 && set.every((r) => r.status === 'dry'),
    dirtyReps: set.filter((r) => r.dirty).length,
    freezes: new Set(set.map((r) => r.freezeId ?? '')).size,
    footing: first ? footingOf(first, ruler) : { model: null, ruler: null },
    gitHeads: [...new Set(set.map((r) => r.gitHead).filter((h): h is string => !!h))],
  };
}

export interface BatchVerdictOptions<R extends VerdictRun> {
  /** Weigh the batch against this one (check --against). */
  against?: string;
  /** How many of its cadence's earlier batches a cadence batch is pooled against (check --baseline-batches). */
  baselineBatches?: number;
  ruler?: RulerOf<R>;
  /**
   * Weigh it only against batches that began before it; a named `against` is
   * kept wherever it sits. The history views need this for an older batch.
   * `check` weighs its newest batch, where it changes nothing, so the CLI
   * leaves it off.
   */
  earlierOnly?: boolean;
}

/** When each batch began: its earliest rep. */
export function batchStarts(history: Timed[]): Map<string, string> {
  const at = new Map<string, string>();
  for (const r of history) {
    const t = repAt(r);
    if (r.batch && t && (!at.has(r.batch) || t < at.get(r.batch)!)) at.set(r.batch, t);
  }
  return at;
}

/** The reps of `batch` and of every batch that began before it. */
export function upTo<R extends VerdictRun>(history: R[], batch: string): R[] {
  const at = batchStarts(history);
  const t = at.get(batch);
  return t === undefined ? history : history.filter((r) => r.batch === batch || (r.batch !== null && (at.get(r.batch) ?? t) < t));
}

/**
 * A surface's run set `batch` weighed against its baseline: `against` when
 * named (check --against); else a cadence batch (its reps stamped by check
 * --cadence) against its own last `baselineBatches` batches (pooledRuns),
 * weighed night by night per freeze (separateNights), and any other, a
 * bisect probe included, against each freeze's newest other batch
 * (previousRuns) with per-rep scores (separate). `history` is the surface's
 * runs, newest first.
 *
 * Pass rate, mean, range and flips cover the set; the separation covers only
 * the freezes both sets ran, so a one-freeze run is never weighed against a
 * whole surface. A crash graded nothing (the model never answered, or the
 * agent left its world), so it is counted apart and weighed as neither a pass
 * nor a 0, on either side.
 */
export function batchVerdict<R extends VerdictRun>(meta: Pick<SurfaceMeta, 'id' | 'model'>, batch: string, history: R[], o: BatchVerdictOptions<R> = {}): BatchVerdict {
  const { against, baselineBatches = CADENCE_BASELINE_BATCHES, ruler = defaultRuler } = o;
  if (o.earlierOnly && !against) history = upTo(history, batch);
  const set = batchSet(history, batch);
  const stats = batchStats(batch, set, ruler);
  const base = { surface: meta.id, batch, footing: stats.footing, set: stats };
  if (stats.dry) {
    return { ...base, models: [], dry: true, baseline: null, compared: { current: [], previous: [], previousFreezes: 0 }, separation: { kind: 'too-few' }, footingNotes: [], flips: [], gatesFailed: [], regression: false };
  }
  let prev: { set: R[]; skipped: SkippedBatch[]; batches: string[] };
  let kind: NonNullable<BatchVerdict['baseline']>['kind'];
  if (against) {
    const set = batchSet(history, against);
    [prev, kind] = [{ set, skipped: [], batches: [against] }, 'against'];
  } else if (stats.cadence && stats.cadence !== BISECT_CADENCE) [prev, kind] = [pooledRuns(history, batch, stats.cadence, baselineBatches, ruler), 'pooled'];
  else {
    const p = previousRuns(history, batch, ruler);
    [prev, kind] = [{ ...p, batches: [...new Set(p.set.map((r) => r.batch!))].sort() }, 'previous'];
  }
  const current = set.filter((r) => r.status !== 'crash');
  const ranNow = new Set(current.map((r) => r.freezeId ?? ''));
  const ranBefore = new Set(prev.set.map((r) => r.freezeId ?? ''));
  const previous = prev.set.filter((r) => ranNow.has(r.freezeId ?? '') && r.status !== 'crash');
  const compared = { current: current.filter((r) => ranBefore.has(r.freezeId ?? '')).map(scoreOrZero), previous: previous.map(scoreOrZero), previousFreezes: ranBefore.size };
  const separation = kind === 'pooled' ? separateNights(nightStrata(current, previous)) : separationOf(compared.current, compared.previous);
  // For a named baseline: the freezes weighed on another model or ruler, in the order the set's reps name them.
  const notes = new Map<string, BatchVerdict['footingNotes'][number]>();
  if (against) {
    for (const r of current) {
      const other = previous.find((p) => p.freezeId === r.freezeId);
      if (!other) continue;
      const [a, b] = [footingOf(r, ruler), footingOf(other, ruler)];
      const note = { freezeId: r.freezeId ?? '', model: a.model !== b.model ? { then: b.model, now: a.model } : null, judge: a.ruler !== b.ruler };
      if (note.model || note.judge) notes.set(JSON.stringify(note), note);
    }
  }
  return {
    ...base,
    models: [...new Set(current.map((r) => r.model ?? meta.model))],
    dry: false,
    baseline: { kind, batches: prev.batches, reps: prev.set.length, cadence: kind === 'pooled' ? stats.cadence : null, skipped: prev.skipped.filter((s) => ranNow.has(s.freezeId)) },
    compared,
    separation,
    footingNotes: [...notes.values()],
    flips: verdictFlips(current, previous),
    gatesFailed: [...new Set(current.flatMap((r) => r.gatesFailed))],
    regression: separation.kind === 'worse',
  };
}

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
