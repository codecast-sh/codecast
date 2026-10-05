import { unaskedSet, type BatchStats, type BatchVerdict, type EvalVisibility, type Footing, type RunRowCore, type SkippedBatch, type VerdictFlip } from '../contract';
import type { RunStatus } from '../model';

import { median, separate, separateNights, type Stratum } from './stats';

// A run set and its verdict: the set a batch holds, the baseline it is
// weighed against, and the verdict between them as one value (batchVerdict).
// Pure: what passes a rep and which ruler judged it are the product's to say
// (VerdictPolicy), so makeVerdict binds them once and every function that
// reads either comes from the bound kit. Everything else is free.

/**
 * What the verdict reads from a rep. A CLI hands it its run summaries; a
 * server hands it index rows (RunRowCore), which also carry the freeze's name
 * and visibility, the judge's spend and model, the rep's head and its ruler.
 */
export type VerdictRun = Pick<RunRowCore, 'id' | 'seed' | 'score' | 'gatesFailed' | 'missedFloors' | 'costUsd' | 'batch' | 'cadence'> & {
  status: RunStatus;
  freezeId?: string | null;
  model?: string | null;
  createdAt?: string;
  /** Agent reads that went to the live workspace; a product without them leaves it out. */
  liveReads?: number;
} & Partial<Pick<RunRowCore, 'freezeName' | 'judgeCostUsd' | 'judgeModel' | 'dirty' | 'gitHead' | 'batchAt' | 'stamp' | 'ruler'>> & { visibility?: EvalVisibility };

/** The ruler a rep was judged on. */
export type RulerOf<R extends VerdictRun = VerdictRun> = (r: R) => string | null;

/** What a product decides about a rep: whether it passed, and the ruler that judged it. */
export interface VerdictPolicy<R extends VerdictRun = VerdictRun> {
  passed(rep: R): boolean;
  ruler(rep: R): string | null;
}

/** The surface a verdict is for: its id, and the model a rep that names none answered on. */
export interface VerdictSurface {
  id: string;
  model: string;
}

/** The pass rule at a mark: every gate held, no check under its floor, and the score at `passAt` or over. */
export const passMarkRule =
  (passAt: number) =>
  (score: number, gatesFailed: number, missedFloors: number): boolean =>
    gatesFailed === 0 && missedFloors === 0 && score >= passAt;

/**
 * A rep's verdict at a pass mark. A dry rep's status is `dry` (it grades
 * canned output), but its score keeps the verdict its gates gave, so a dry
 * run can prove the pass rule's wiring end to end.
 */
export const statusPassRule = (passAt: number): ((r: Pick<VerdictRun, 'status' | 'score' | 'gatesFailed' | 'missedFloors'>) => boolean) => {
  const passes = passMarkRule(passAt);
  return (r) => r.status === 'pass' || (r.status === 'dry' && r.score !== null && passes(r.score, r.gatesFailed.length, r.missedFloors.length));
};

export const scoreOrZero = (r: Pick<VerdictRun, 'score'>): number => r.score ?? 0;

/** The cadence a bisect's probes run under (check --cadence bisect): a probe ran another commit than the checkout's, so it is never a baseline, never weighed against other probes, and views hide it by default. */
export const BISECT_CADENCE = 'bisect';

/** How many of its own earlier batches a cadence batch is weighed against by default (check --baseline-batches). */
export const CADENCE_BASELINE_BATCHES = 7;

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

/** The graded reps of a batch: one per seed, crashes and dry reps left out (they graded nothing). */
export const gradedSet = <R extends VerdictRun>(rows: R[], batch: string): R[] => batchSet(rows, batch).filter((r) => r.status !== 'crash' && r.status !== 'dry');

/**
 * The graded reps of a batch the model was asked about, else none: a batch
 * where every rep failed before the model answered (unaskedSet) says nothing
 * about the prompt or the ruler, so it can neither show a regression, stand
 * as a good end, nor move a footing.
 */
export const askedSet = <R extends VerdictRun>(rows: R[], batch: string): R[] => (unaskedSet(batchSet(rows, batch)) ? [] : gradedSet(rows, batch));

/** What a rep is weighed on: the model it answered on and the judge's ruler. */
export const footingWith = <R extends VerdictRun>(r: R, ruler: RulerOf<R>): Footing => ({ model: r.model ?? null, ruler: ruler(r) });

/** What moved between two footings: the model first, then the judge's ruler; null on the same footing. */
export const footingChange = (a: Footing, b: Footing): 'model' | 'judge' | null => (a.model !== b.model ? 'model' : a.ruler !== b.ruler ? 'judge' : null);

/** Each freeze's verdict over its reps under a pass rule: passed by majority. */
export const majorityBy = <R extends VerdictRun>(runs: R[], passed: (r: R) => boolean): Map<string, boolean> => {
  const by = new Map<string, number[]>();
  for (const r of runs) {
    const k = r.freezeId ?? '';
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(passed(r) ? 1 : 0);
  }
  return new Map([...by].map(([k, v]) => [k, v.reduce((s, x) => s + x, 0) * 2 > v.length]));
};

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

/**
 * Whether no graded rep says what it was weighed on: every one on both sides
 * carries a null model and a null judge model. Only a row that states both as
 * null counts (a run summary that leaves the judge out says nothing), so a
 * product that records its footing never reads as unfooted.
 */
export const unfootedReps = (reps: Array<Pick<VerdictRun, 'status' | 'model' | 'judgeModel'>>): boolean => {
  const graded = reps.filter((r) => r.status === 'pass' || r.status === 'fail');
  return graded.length > 0 && graded.every((r) => r.model === null && r.judgeModel === null);
};

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

export interface BatchVerdictOptions<R extends VerdictRun> {
  /** Weigh the batch against this one (check --against). */
  against?: string;
  /** How many of its cadence's earlier batches a cadence batch is pooled against (check --baseline-batches). */
  baselineBatches?: number;
  ruler?: RulerOf<R>;
}

/** The verdict functions bound to a product's policy: every one that reads whether a rep passed, or its ruler. */
export type VerdictKit<P extends VerdictRun = VerdictRun> = ReturnType<typeof makeVerdict<P>>;

/** Binds the verdict to a product's policy. Each function keeps its signature; a ruler left out is the policy's. */
export function makeVerdict<P extends VerdictRun = VerdictRun>(policy: VerdictPolicy<P>) {
  const passed = (r: P): boolean => policy.passed(r);
  const defaultRuler: RulerOf<P> = (r) => policy.ruler(r);

  /** Each freeze's verdict over its reps: passed by majority. */
  const majority = (runs: P[]): Map<string, boolean> => majorityBy(runs, passed);

  /** What a rep is weighed on: the model it answered on and the judge's ruler. */
  const footingOf = <R extends P>(r: R, ruler: RulerOf<R> = defaultRuler): Footing => footingWith(r, ruler);

  /**
   * The run set a check is weighed against: for each freeze, the reps of the
   * newest other batch that graded it on the current set's footing, the same
   * model and the same judge ruler. A later run of one freeze then never
   * hides the other freezes' sets; a batch whose reps on a freeze all
   * crashed graded nothing there; and a batch on another model, or judged by
   * another prompt or criterion, would read the model or the ruler as a prompt
   * change. The comparison falls back past each of those, and `skipped` names
   * the newer batches it passed over for a footing that differs. Newest means
   * the batch that began last (batchStarts), its name breaking a tie only: a
   * batch name need not be a time, and by name alone every named batch would
   * outrank every stamped one.
   */
  function previousRuns<R extends P>(history: R[], batch: string, ruler: RulerOf<R> = defaultRuler, starts: Map<string, string> = batchStarts(history)): { set: R[]; skipped: SkippedBatch[] } {
    const want = new Map<string, Footing>();
    for (const r of batchSet(history, batch)) if (r.status !== 'crash' && !want.has(r.freezeId ?? '')) want.set(r.freezeId ?? '', footingOf(r, ruler));
    // A bisect probe ran another commit, so it is no baseline for anything.
    const real = history.filter((r) => r.batch && r.batch !== batch && r.status !== 'dry' && r.status !== 'unscored' && r.cadence !== BISECT_CADENCE);
    // One graded rep per freeze and batch stands for the batch there: a model and a judge apply to a whole batch, and a rejudge to every rep of it.
    const graded = new Map<string, R>();
    for (const r of real) if (r.status !== 'crash' && !graded.has(`${r.freezeId}\x1f${r.batch}`)) graded.set(`${r.freezeId}\x1f${r.batch}`, r);
    const newest = new Map<string, string>();
    const skipped: SkippedBatch[] = [];
    const key = (r: R) => [starts.get(r.batch!) ?? '', r.batch!] as const;
    const newerFirst = (x: R, y: R) => {
      const [[xa, xb], [ya, yb]] = [key(x), key(y)];
      return xa !== ya ? (xa < ya ? 1 : -1) : xb === yb ? 0 : xb < yb ? 1 : -1;
    };
    for (const r of [...graded.values()].sort(newerFirst)) {
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
  const previousRunSet = <R extends P>(history: R[], batch: string, ruler?: RulerOf<R>): R[] => previousRuns(history, batch, ruler).set;

  /**
   * The baseline a cadence batch is weighed against: for each freeze, the reps
   * of the newest `n` other batches of the same cadence on the current set's
   * footing (previousRuns, taken n times over). Only runs stamped with the
   * cadence join it, so no other run's notes can move it. batchVerdict weighs
   * the set against it night by night per freeze (nightStrata), so one unlucky
   * night moves nothing: only a shift the earlier nights disagree with separates.
   */
  function pooledRuns<R extends P>(history: R[], batch: string, cadence: string, n: number, ruler: RulerOf<R> = defaultRuler): { set: R[]; skipped: SkippedBatch[]; batches: string[] } {
    let rest = history.filter((r) => r.batch === batch || r.cadence === cadence);
    // When each batch began, read once: taking a batch's reps on one freeze must not move its start for the others.
    const starts = batchStarts(history);
    const set: R[] = [];
    const skipped = new Map<string, SkippedBatch>();
    for (let i = 0; i < n; i++) {
      const prev = previousRuns(rest, batch, ruler, starts);
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
  function verdictFlips(current: P[], previous: P[]): VerdictFlip[] {
    const now = majority(current);
    const before = majority(previous);
    // The reps that agree with their side's verdict come first, so a page that
    // shows one rep per side (the flip's links, its prompt diff) shows the flip
    // itself, never the dissenting rep of a 2-to-1 majority.
    const ids = (runs: P[], freezeId: string, passes: boolean) => {
      const mine = runs.filter((r) => (r.freezeId ?? '') === freezeId);
      return [...mine.filter((r) => passed(r) === passes), ...mine.filter((r) => passed(r) !== passes)].map((r) => r.id);
    };
    return [...now].flatMap(([freezeId, passes]) => {
      if (!before.has(freezeId) || before.get(freezeId) === passes) return [];
      const rep = current.find((r) => (r.freezeId ?? '') === freezeId);
      return [{ freezeId, name: rep?.freezeName ?? freezeId, visibility: rep?.visibility ?? 'private', direction: passes ? 'fixed' : 'broke', before: ids(previous, freezeId, !passes), after: ids(current, freezeId, passes) } satisfies VerdictFlip];
    });
  }

  /** A batch's reps as BatchStats: what the strip and the verdict's first line show. Crashes count apart and graded nothing. */
  function batchStats<R extends P>(batch: string, set: R[], ruler: RulerOf<R> = defaultRuler): BatchStats {
    const current = set.filter((r) => r.status !== 'crash');
    const scores = current.map(scoreOrZero);
    const passedReps = current.filter((r) => r.status === 'pass').length;
    const live = current.filter((r) => (r.liveReads ?? 0) > 0);
    const first = current[0];
    const times = set.map(repAt).filter((t): t is string => !!t).sort();
    return {
      batch,
      reps: current.length,
      passed: passedReps,
      median: scores.length ? median(scores) : null,
      mean: scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : null,
      min: scores.length ? Math.min(...scores) : null,
      max: scores.length ? Math.max(...scores) : null,
      // What the set spent, its crashes included.
      costUsd: set.reduce((s, r) => s + r.costUsd, 0),
      batchAt: times[0] ?? batch,
      cadence: set.find((r) => r.cadence)?.cadence ?? null,
      passRate: current.length ? passedReps / current.length : null,
      crashes: set.length - current.length,
      judgeCostUsd: set.reduce((s, r) => s + (r.judgeCostUsd ?? 0), 0),
      liveReads: { reps: live.length, reads: live.reduce((t, r) => t + (r.liveReads ?? 0), 0) },
      dry: set.length > 0 && set.every((r) => r.status === 'dry'),
      unasked: unaskedSet(set),
      dirtyReps: set.filter((r) => r.dirty).length,
      freezes: new Set(set.map((r) => r.freezeId ?? '')).size,
      footing: first ? footingOf(first, ruler) : { model: null, ruler: null },
      gitHeads: [...new Set(set.map((r) => r.gitHead).filter((h): h is string => !!h))],
    };
  }

  /**
   * What batchVerdict weighs: the batch's set and the baseline it chose, both
   * cut to graded reps on the freezes the batch ran. `prev` is null for a dry
   * set, which is weighed against nothing.
   */
  function weighing<R extends P>(batch: string, history: R[], o: BatchVerdictOptions<R>) {
    const { against, baselineBatches = CADENCE_BASELINE_BATCHES, ruler = defaultRuler } = o;
    if (!against) history = upTo(history, batch);
    const set = batchSet(history, batch);
    const ran = new Set(set.map((r) => r.freezeId ?? ''));
    history = history.filter((r) => r.batch === batch || ran.has(r.freezeId ?? ''));
    const stats = batchStats(batch, set, ruler);
    const current = set.filter((r) => r.status !== 'crash');
    if (stats.dry) return { stats, current, prev: null, kind: null, previous: [] as R[] };
    let prev: { set: R[]; skipped: SkippedBatch[]; batches: string[] };
    let kind: NonNullable<BatchVerdict['baseline']>['kind'];
    if (against) [prev, kind] = [{ set: batchSet(history, against), skipped: [], batches: [against] }, 'against'];
    else if (stats.cadence && stats.cadence !== BISECT_CADENCE) [prev, kind] = [pooledRuns(history, batch, stats.cadence, baselineBatches, ruler), 'pooled'];
    else {
      const p = previousRuns(history, batch, ruler);
      [prev, kind] = [{ ...p, batches: [...new Set(p.set.map((r) => r.batch!))].sort() }, 'previous'];
    }
    const ranNow = new Set(current.map((r) => r.freezeId ?? ''));
    return { stats, current, prev, kind, previous: prev.set.filter((r) => ranNow.has(r.freezeId ?? '') && r.status !== 'crash') };
  }

  /** The freezes `batch` flipped against its baseline, as batchVerdict reports them, without weighing the separation: what a ledger marks per well. */
  function batchFlips<R extends P>(batch: string, history: R[], o: BatchVerdictOptions<R> = {}): VerdictFlip[] {
    const w = weighing(batch, history, o);
    return w.prev ? verdictFlips(w.current, w.previous) : [];
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
   * The default baselines look only at batches that began before this one
   * (upTo), and only at the freezes this batch ran: `check`, the wall and the
   * surface page then weigh a batch alike, whether a later batch has landed
   * since, overlapped it, or ran other freezes. A named `against` is kept
   * wherever it sits.
   *
   * Pass rate, mean, range and flips cover the set; the separation covers only
   * the freezes both sets ran, so a one-freeze run is never weighed against a
   * whole surface. A crash graded nothing (the model never answered, or the
   * agent left its world), so it is counted apart and weighed as neither a pass
   * nor a 0, on either side.
   */
  function batchVerdict<R extends P>(meta: VerdictSurface, batch: string, history: R[], o: BatchVerdictOptions<R> = {}): BatchVerdict {
    const { against, ruler = defaultRuler } = o;
    const w = weighing(batch, history, o);
    const stats = w.stats;
    const base = { surface: meta.id, batch, footing: stats.footing, set: stats };
    if (!w.prev) {
      return { ...base, models: [], dry: true, baseline: null, compared: { current: [], previous: [], previousFreezes: 0 }, separation: { kind: 'too-few' }, footingNotes: [], flips: [], gatesFailed: [], regression: false };
    }
    const { prev, kind, current, previous } = w;
    const ranNow = new Set(current.map((r) => r.freezeId ?? ''));
    const ranBefore = new Set(prev.set.map((r) => r.freezeId ?? ''));
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
      ...(unfootedReps([...current, ...previous]) ? { unfooted: true as const } : {}),
    };
  }

  return { policy, passed, majority, footingOf, previousRuns, previousRunSet, pooledRuns, verdictFlips, batchStats, batchFlips, batchVerdict };
}
