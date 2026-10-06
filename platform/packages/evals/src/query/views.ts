// The views every product's pages share, built from its rows with the same
// verdict, flip, epoch and attribution code its CLI prints from (codecast's
// `./evals check` and `line`). Pure: what a product reads (its index, its
// registry, its folders, its git) comes in as EvalsSources, so a server, a
// browser and a test run the same code. A source a product leaves out empties
// the parts of a view that read it; the routes that need it answer 404.

import { attribute, batchSet, epochPromptDiffs, epochsOf, flipsBetween, footingMarkers, gradedSet, makeVerdict, promptPairs, scoreOrZero, timeline, type VerdictKit, type VerdictRun } from '../analysis';
import {
  flipCounts,
  spendByDayOf,
  type Attribution,
  type BatchesResponse,
  type BatchStats,
  type BatchVerdict,
  type CompareResponse,
  type EpochResponse,
  type FreezeResponse,
  type LedgerRow,
  type MovedEvent,
  type OverviewResponse,
  type RunResponse,
  type RunRowCore,
  type SurfaceOverview,
  type SurfaceResponse,
} from '../contract';
import { BadRequest, NotFound, rowById } from './request';
import type { EvalsSources, HandlerPolicy, QuerySurface, RunDetail } from './sources';

const DAY = 86_400_000;
const MINUTE = 60_000;

/** The most answers one rows version keeps; the oldest goes first. */
const ROW_MEMO_CAP = 64;

/**
 * A cache of answers computed from the rows alone, per rows array: the
 * sources hand the same array until the rows change, so a new version drops
 * them all. `onRows` computes once per rows version and key. A promise is kept
 * as it is, so concurrent asks share one computation; one that rejects is
 * dropped, so a git call that failed under load is tried again on the next ask.
 * One per handler: two products' policies never share an answer.
 */
export function rowsMemo() {
  const byRows = new WeakMap<object, Map<string, unknown>>();
  return function onRows<T>(rows: object, key: string, compute: () => T): T {
    let memo = byRows.get(rows);
    if (!memo) byRows.set(rows, (memo = new Map()));
    const m = memo;
    if (m.has(key)) return m.get(key) as T;
    const value = compute();
    if (m.size >= ROW_MEMO_CAP) m.delete(m.keys().next().value!);
    m.set(key, value);
    if (value instanceof Promise) value.catch(() => m.get(key) === value && m.delete(key));
    return value;
  };
}

/** A surface's rows, newest first (the order onePerSeed and batchSet expect). */
const rowsOf = <R extends RunRowCore>(rows: R[], surface: string): R[] => rows.filter((r) => r.surface === surface);

/** Does a batch's cadence pass the filter: `all`, `named` (no cadence: a check by hand), or one cadence by name. */
const cadenceMatches = (filter: string, cadence: string | null): boolean => filter === 'all' || (filter === 'named' ? cadence === null : cadence === filter);

/** How finely the wall's strip can tell two scores apart: its plot is about 44 px tall, so a fortieth of the axis is about a pixel. */
const DOT_STEPS = 40;

/**
 * A batch's reps as the strip's faint dots, at the strip's own resolution:
 * reps of one status within a fortieth of the axis draw as one dot, so one is
 * sent. Unscored and dry reps draw nothing and are left out. The surface page
 * reads every rep from GET /surface.
 */
function dotsOf(set: RunRowCore[], batch: string): SurfaceOverview['dots'] {
  const seen = new Set<string>();
  return set.flatMap((r) => {
    if (r.score === null || r.status === 'dry') return [];
    const key = `${r.status}:${Math.round(r.score * DOT_STEPS)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ batch, at: r.stamp, score: r.score, status: r.status }];
  });
}

/** How many of a surface's newest graded batches report their flips on the home wall. */
const FLIP_BATCHES = 4;
/** A batch is still landing when a rep in it is unscored and this recent. */
const LANDING_MS = 30 * 60_000;

/** A surface's wall row before the two facts read outside the rows: its freeze counts and staleness word. */
type CoreRow = Omit<SurfaceOverview, 'freezes' | 'staleness'>;

/** Everything the wall computes from the rows alone. */
interface OverviewCore {
  surfaces: Array<{ row: CoreRow; moved: MovedEvent[] }>;
  spendByDay: OverviewResponse['spendByDay'];
}

/** The surface a verdict is weighed for: its id, and the model a rep that names none answered on. */
const verdictSurface = (s: QuerySurface) => ({ id: s.id, model: s.model ?? '' });

/**
 * How often each freeze flipped across a window's graded batches (bisect
 * probes left out, as the ledger leaves them), and in how many it ran: the
 * same flips the surface's ledger counts, so the wall can say a flip is a
 * freeze that flaps.
 */
function flipHistory(v: VerdictKit, batches: string[], mine: RunRowCore[]): Map<string, { flips: number; batches: number }> {
  const out = new Map<string, { flips: number; batches: number }>();
  const at = (id: string) => out.get(id) ?? out.set(id, { flips: 0, batches: 0 }).get(id)!;
  for (const batch of batches) {
    const set = gradedSet(mine, batch);
    if (!set.length || set.every((r) => r.cadence === 'bisect')) continue;
    for (const id of new Set(set.map((r) => r.freezeId))) at(id).batches += 1;
    for (const f of v.batchFlips(batch, mine)) at(f.freezeId).flips += 1;
  }
  return out;
}

/** A verdict's flips with each freeze's flip history and whether both sides rendered one prompt. */
function withFlipHistory(v: BatchVerdict, history: Map<string, { flips: number; batches: number }>, mine: RunRowCore[]): BatchVerdict {
  if (!v.flips.length) return v;
  const sha = new Map(mine.map((r) => [r.id, r.promptSha]));
  const prompts = (ids: string[]) => new Set(ids.map((id) => sha.get(id) ?? null));
  return {
    ...v,
    flips: v.flips.map((f) => {
      const both = new Set([...prompts(f.before), ...prompts(f.after)]);
      return { ...f, history: history.get(f.freezeId) ?? { flips: 0, batches: 0 }, samePrompt: f.before.length > 0 && f.after.length > 0 && both.size === 1 && !both.has(null) };
    }),
  };
}

/**
 * The freeze ledger: one row per freeze, one well per batch. A well's flip is
 * the flip its batch's verdict reports for that freeze (batchFlips over the
 * surface's whole history), so the plate, the product's CLI check and the
 * wall mark the same flips: no bisect probe or batch on another footing is
 * ever the well a flip is weighed against.
 */
export function ledgerOf(v: VerdictKit, rows: RunRowCore[], batches: string[], history: RunRowCore[]): LedgerRow[] {
  const byFreeze = new Map<string, LedgerRow>();
  for (const batch of batches) {
    const set = gradedSet(rows, batch);
    const m = v.majority(set);
    const flips = new Map(v.batchFlips(batch, history).map((f) => [f.freezeId, f.direction]));
    for (const freezeId of new Set(set.map((r) => r.freezeId))) {
      const reps = set.filter((r) => r.freezeId === freezeId);
      const first = reps[0]!;
      let row = byFreeze.get(freezeId);
      if (!row) {
        row = { freezeId, name: first.freezeName, visibility: first.visibility, flips: 0, cells: {} };
        byFreeze.set(freezeId, row);
      }
      const flip = flips.get(freezeId) ?? null;
      if (flip) row.flips += 1;
      row.cells[batch] = { reps: reps.length, passed: reps.filter((r) => r.status === 'pass').length, mean: reps.reduce((s, r) => s + scoreOrZero(r), 0) / reps.length, majority: m.get(freezeId) ?? null, flip };
    }
  }
  return [...byFreeze.values()].sort((a, b) => b.flips - a.flips || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The filters GET /surface takes. */
export interface SurfaceFilter {
  from?: string;
  to?: string;
  model?: string;
  cadence?: string;
  dry?: boolean;
  bisect?: boolean;
}

/** The same freeze in the batch before and after this rep's, the same seed when that batch ran it. */
function adjacentOf(rows: RunRowCore[], row: RunRowCore): RunResponse['adjacent'] {
  const line = timeline(rowsOf(rows, row.surface));
  const i = line.findIndex((b) => b.batch === row.batch);
  const pick = (step: number): string | null => {
    for (let j = i + step; i >= 0 && j >= 0 && j < line.length; j += step) {
      const same = line[j]!.reps.filter((r) => r.freezeId === row.freezeId);
      if (same.length) return (same.find((r) => r.seed === row.seed) ?? same[0]!).id;
    }
    return null;
  };
  return { previous: pick(-1), next: pick(1) };
}

const batchOf = (mine: RunRowCore[], surface: string, batch: string): string => {
  if (!mine.some((r) => r.batch === batch)) throw new NotFound(`no ${surface} batch ${batch}`);
  return batch;
};

/** A run's detail when the product reads none: the row and its neighbours alone. Fresh per answer, since a local transport hands the object itself to the page. */
const noDetail = (): RunDetail => ({ result: null, score: null, scoreVersions: [], rubric: null, sends: [], judge: null, logTail: null });


/** The views over one product's sources and verdict policy. */
export function evalsViews<R extends RunRowCore, S extends QuerySurface, M extends { at: string }>(src: EvalsSources<R, S, M>, policy: HandlerPolicy, onRows = rowsMemo()) {
  const v = makeVerdict<VerdictRun>(policy);
  const ruler = policy.ruler;
  /** Epochs need the prompt files; a product without them has one unbroken run of batches and no strip of epochs. The reader is read per use: a product may build it from its environment each time (codecast). */
  const epochsFor = (mine: R[], surface: string) => {
    const reader = src.prompts;
    return reader ? epochsOf(mine, surface, reader) : [];
  };

  const metaOf = (all: readonly S[], id: string): S => {
    const meta = all.find((s) => s.id === id);
    if (!meta) throw new NotFound(`no surface ${id}`);
    return meta;
  };

  function surfaceOverview(meta: S, rows: R[], cadence: string, now: number): { row: CoreRow; moved: MovedEvent[] } {
    const mine = rowsOf(rows, meta.id);
    const line = timeline(mine);
    const graded = line.filter(({ batch }) => gradedSet(mine, batch).length);
    const kept = line.filter(({ at, reps }) => Date.parse(at) >= now - 30 * DAY && cadenceMatches(cadence, reps[0]!.cadence)).map(({ batch, at }) => ({ batch, at, set: batchSet(mine, batch) })).filter(({ set }) => set.length && !set.every((r) => r.status === 'dry'));
    const strip: BatchStats[] = kept.map(({ batch, set }) => v.batchStats(batch, set));
    const last = kept.at(-1);
    const epochs = epochsFor(mine, meta.id);
    // Footing moves between the batches the strip draws: a by-hand batch on another ruler between two nightlies is not on a nightly strip.
    const footing = footingMarkers(kept.flatMap((k) => k.set), ruler);
    const newest = line.at(-1);
    // Each batch weighed once: the latest batch is usually among the newest graded ones the flips read.
    const verdicts = new Map<string, BatchVerdict>();
    const flapping = flipHistory(v, kept.map((k) => k.batch), mine);
    const verdictOf = (batch: string) => verdicts.get(batch) ?? verdicts.set(batch, withFlipHistory(v.batchVerdict(verdictSurface(meta), batch, mine), flapping, mine)).get(batch)!;
    const moved: MovedEvent[] = [
      ...epochs.slice(1).map((e): MovedEvent => ({ at: e.firstBatchAt, surface: meta.id, kind: 'epoch', epoch: e.n, batch: e.firstBatch, changedFreezes: e.changedFreezes.length })),
      ...footing.map((m): MovedEvent => ({ at: m.batchAt, surface: meta.id, kind: 'footing', batch: m.batch, change: m.kind, from: m.from, to: m.to })),
      ...graded.slice(-FLIP_BATCHES).flatMap(({ batch, at }): MovedEvent[] => {
        const flips = verdictOf(batch).flips;
        const { broke, fixed, noise } = flipCounts(flips);
        return flips.length ? [{ at, surface: meta.id, kind: 'flips', batch, broke, fixed, noise: noise.length }] : [];
      }),
    ];
    return {
      row: {
        id: meta.id,
        title: meta.title,
        route: meta.route,
        model: meta.model,
        strip,
        dots: kept.flatMap(({ batch, set }) => dotsOf(set, batch)),
        latest: last ? verdictOf(last.batch) : null,
        spendByDay: spendByDayOf(mine, now - 30 * DAY),
        epochs,
        footing,
        landing: !!newest && newest.reps.some((r) => r.status === 'unscored' && now - Date.parse(r.stamp) < LANDING_MS),
      },
      moved,
    };
  }

  /** The overview's rows-only part for one cadence, kept per rows version and minute (the 30-day window and the landing pulse move with the clock). */
  const overviewCore = (rows: R[], surfaces: readonly S[], cadence: string, now: number): OverviewCore =>
    onRows(rows, `overview|${cadence}|${Math.floor(now / MINUTE)}`, () => ({ surfaces: surfaces.map((m) => surfaceOverview(m, rows, cadence, now)), spendByDay: spendByDayOf(rows, now - 30 * DAY) }));

  async function overview(rows: R[], surfaces: readonly S[], cadence: string, words: Promise<((surface: string) => string | null) | null>, now = Date.now()): Promise<OverviewResponse<M> & object> {
    const core = overviewCore(rows, surfaces, cadence, now);
    const countsOf = src.freezes ? await src.freezes.counts() : () => ({ public: 0, private: 0 });
    const wordOf = await words;
    // Call surfaces first, then agent surfaces; within each, a latest batch that separated worse leads.
    const order = (s: CoreRow) => `${s.route === 'call' ? 0 : 1}${s.latest?.regression ? 0 : 1}`;
    const surfacesOut = core.surfaces
      .map(({ row }): SurfaceOverview => ({ ...row, freezes: countsOf(row.id), ...(wordOf ? { staleness: wordOf(row.id) } : {}) }))
      .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    const bisects = src.bisects?.summaries() ?? [];
    const own = src.overview?.() ?? {};
    const moved: Array<MovedEvent | M> = [
      ...core.surfaces.flatMap((b) => b.moved),
      // A bisect that ended with no answer and nothing spent ran nothing: it moved nothing either.
      ...bisects.filter((b) => b.finishedAt && (b.outcome !== null || b.spentUsd > 0)).map((b): MovedEvent => ({ at: b.finishedAt!, surface: b.surface, kind: 'bisect', id: b.id, outcome: b.outcome })),
      ...(own.moved ?? []),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, 12);
    return { cadence, surfaces: surfacesOut, moved, spendByDay: core.spendByDay, bisects, ...own.fields };
  }

  async function surfaceView(rows: R[], surfaces: readonly S[], id: string, f: SurfaceFilter): Promise<SurfaceResponse<R>> {
    const meta = metaOf(surfaces, id);
    const mine = rowsOf(rows, id);
    const from = f.from ? Date.parse(f.from) : -Infinity;
    const to = f.to ? Date.parse(f.to) : Infinity;
    if (Number.isNaN(from) || Number.isNaN(to)) throw new BadRequest('from and to take ISO times');
    const cadence = f.cadence ?? 'all';
    const shown = mine.filter((r) => {
      if (!r.batch) return false;
      if (r.cadence === 'bisect' && !f.bisect) return false;
      if (r.status === 'dry' && !f.dry) return false;
      if (f.model && r.model !== f.model) return false;
      if (r.cadence !== 'bisect' && !cadenceMatches(cadence, r.cadence)) return false;
      const at = Date.parse(r.batchAt ?? r.stamp);
      return at >= from && at <= to;
    });
    const starts = new Map<string, string>();
    for (const r of shown) starts.set(r.batch!, r.batchAt ?? r.stamp);
    const names = [...starts].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1)).map(([b]) => b);
    const batches = names.map((b) => v.batchStats(b, batchSet(shown, b))).filter((s) => s.reps + s.crashes > 0);
    const countsOf = src.freezes ? await src.freezes.counts() : null;
    const first = batches[0]?.batchAt ?? null;
    const last = batches.at(-1)?.batchAt ?? null;
    // The newest graded batch, weighed as the wall weighs a row's latest: against batches that began before it.
    const newest = [...names].reverse().find((b) => shown.some((r) => r.batch === b && r.cadence !== 'bisect') && gradedSet(shown, b).length);
    const info = {
      id,
      title: meta.title,
      route: meta.route,
      model: meta.model,
      ...(meta.passMark !== undefined ? { passMark: meta.passMark } : {}),
      ...(meta.gate !== undefined ? { gate: meta.gate } : {}),
      ...(countsOf ? { freezes: countsOf(id) } : {}),
      ...src.info?.(meta),
    };
    return {
      surface: info,
      runs: shown,
      batches,
      epochs: epochsFor(mine, id),
      footing: footingMarkers(shown, ruler),
      ledger: ledgerOf(v, shown, names, mine),
      commits: first && src.git ? src.git.touching(id, new Date(Date.parse(first) - DAY).toISOString(), last) : [],
      latest: newest ? withFlipHistory(v.batchVerdict(verdictSurface(meta), newest, mine), flipHistory(v, names, mine), mine) : null,
    };
  }

  async function freezeView(rows: R[], surfaces: readonly S[], id: string): Promise<FreezeResponse<R>> {
    if (!src.freezes) throw new NotFound('this product keeps no freezes');
    const page = await src.freezes.get(id, rows);
    if (!page) throw new NotFound(`no freeze ${id}`);
    const surface = page.freeze.surface;
    return { ...page, epochs: surface && surfaces.some((s) => s.id === surface) ? epochsFor(rowsOf(rows, surface), surface) : [] };
  }

  async function runView(rows: R[], id: string): Promise<RunResponse<R>> {
    const row = rowById(rows, id);
    const detail: RunDetail<R> & { extra?: unknown } = src.run ? await src.run(row) : noDetail();
    // The contract's key order: the product's detail, then the neighbours, then a product's `extra` (codecast's surface extras).
    const { extra, ...rest } = detail;
    return { row, ...rest, siblings: rows.filter((r) => r.batch !== null && r.batch === row.batch && r.freezeId === row.freezeId && r.id !== row.id), adjacent: adjacentOf(rows, row), ...('extra' in detail ? { extra } : {}) };
  }

  function compareView(rows: R[], a: string, b: string): CompareResponse<R> {
    const ra = rowById(rows, a);
    const rb = rowById(rows, b);
    const reader = src.prompts;
    return { a: ra, b: rb, ...(src.pair?.(a, b) ?? { diff: [], replies: { a: null, b: null } }), prompts: reader ? promptPairs(reader, rb.freezeId, a, b, false) : [] };
  }

  /** Two batches weighed, kept per rows version: the flip examples read every flipped rep's folder. */
  const batchesView = (rows: R[], surfaces: readonly S[], surface: string, a: string, b: string): Promise<BatchesResponse> => onRows(rows, `batches|${surface}|${a}|${b}`, () => buildBatches(rows, surfaces, surface, a, b));

  const examplesOf = (surface: string, freezeIds: string[], a: string, b: string) => (src.flipExamples ? src.flipExamples(surface, freezeIds, a, b).catch(() => []) : Promise.resolve([]));

  async function buildBatches(rows: R[], surfaces: readonly S[], surface: string, a: string, b: string): Promise<BatchesResponse> {
    const meta = metaOf(surfaces, surface);
    const mine = rowsOf(rows, surface);
    batchOf(mine, surface, a);
    batchOf(mine, surface, b);
    const flips = flipsBetween(v, mine, a, b);
    const [sa, sb] = [gradedSet(mine, a), gradedSet(mine, b)];
    const gates = [...new Set([...sa, ...sb].flatMap((r) => r.gatesFailed))].sort();
    const first = flips.ok ? flips.flips[0] : undefined;
    const reader = src.prompts;
    return {
      verdict: v.batchVerdict(verdictSurface(meta), b, mine, { against: a }),
      flips,
      gateDeltas: gates.map((id) => ({ id, a: sa.filter((r) => r.gatesFailed.includes(id)).length, b: sb.filter((r) => r.gatesFailed.includes(id)).length })),
      examples: flips.ok ? await examplesOf(surface, flips.flips.map((f) => f.freezeId), a, b) : [],
      promptDiffs: reader && first && first.before[0] && first.after[0] ? promptPairs(reader, first.freezeId, first.before[0], first.after[0]) : [],
    };
  }

  function epochView(rows: R[], surfaces: readonly S[], surface: string, n: number): EpochResponse {
    metaOf(surfaces, surface);
    const mine = rowsOf(rows, surface);
    const epochs = epochsFor(mine, surface);
    const epoch = epochs.find((e) => e.n === n);
    if (!epoch) throw new NotFound(`${surface} has no epoch ${n} (it has ${epochs.length})`);
    const previous = epochs.find((e) => e.n === n - 1) ?? null;
    const heads = (e: typeof epoch) => mine.find((r) => r.gitHead === e.gitHead)?.mainSha ?? e.gitHead;
    const git = src.git;
    const reader = src.prompts;
    let commits = git && previous?.gitHead && epoch.gitHead ? git.between(surface, heads(previous)!, heads(epoch)!) : [];
    if (git && previous && !commits.length) commits = git.touching(surface, previous.firstBatchAt, epoch.firstBatchAt);
    return { epoch, previous, diffs: reader ? epochPromptDiffs(mine, surface, n, reader) : [], commits };
  }

  /** Tier 0 attribution, kept per rows version: it reads only records, and its flip examples read every flipped rep's folder. */
  const attributionView = (rows: R[], surfaces: readonly S[], surface: string, good: string | undefined, bad: string | undefined, allCommits = false, freeze?: string): Promise<Attribution> =>
    onRows(rows, `attribution|${surface}|${good ?? ''}|${bad ?? ''}|${allCommits ? 'all' : 'declared'}|${freeze ?? ''}`, () => buildAttribution(rows, surfaces, surface, good, bad, allCommits, freeze));

  async function buildAttribution(rows: R[], surfaces: readonly S[], surface: string, good: string | undefined, bad: string | undefined, allCommits: boolean, freeze: string | undefined): Promise<Attribution> {
    metaOf(surfaces, surface);
    const reader = src.prompts;
    if (!src.git || !reader) throw new NotFound('attribution reads a product\'s git and prompt files, and this product hands over neither');
    let a: Attribution;
    try {
      a = attribute({ surface, rows: rowsOf(rows, surface), good: good || undefined, bad: bad || undefined, allCommits, ...(freeze ? { freezes: [freeze] } : {}), git: src.git.attribution, reader }, src.git.meta, v);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const examples = a.good.batch && a.bad.batch && a.flipped.length ? await examplesOf(surface, a.flipped.map((f) => f.freezeId), a.good.batch, a.bad.batch) : [];
    return { ...a, examples };
  }

  return { verdict: v, overview, surfaceView, freezeView, runView, compareView, batchesView, epochView, attributionView };
}
