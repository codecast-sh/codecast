import {
  EVALS_BATCH_TOKEN_RE,
  EVALS_SHA_RE,
  flipCounts,
  matchEvalsRoute,
  resolveEvalsBatchRef,
  spendByDayOf,
  type Attribution,
  type BatchesResponse,
  type BatchStats,
  type BatchVerdict,
  type BisectListResponse,
  type BisectResponse,
  type BisectSummary,
  type ChangesResponse,
  type CommitRef,
  type CommitResponse,
  type CompareResponse,
  type EpochResponse,
  type EvalFlip,
  type EvalRoute,
  type EvalsBridgeRequest,
  type EvalsBridgeResponse,
  type EvalsErrorBody,
  type EvalsResponse,
  type EvalsRouteKey,
  type EvalsRoutes,
  type FreezeResponse,
  type HealthResponse,
  type LedgerRow,
  type MovedEvent,
  type OverviewResponse,
  type RunResponse,
  type RunRow,
  type SimJob,
  type SimSessionSummary,
  type StalenessWord,
  type SurfaceInfo,
  type SurfaceOverview,
  type SurfaceResponse,
} from '@codecast/shared/contracts/evalsApi';

import { attribute, type AttributionGit, type AttributionMeta } from './attribution';
import { epochPromptDiffs, epochsOf, footingMarkers, promptPairs, timeline, type PromptReader } from './epochs';
import { flipsBetween } from './flips';
import { batchSet, gradedSet, makeVerdict, scoreOrZero, type VerdictKit, type VerdictPolicy, type VerdictRun } from './verdict';

// The neutral half of the evals api (evals-converge.md section 2, ./query):
// every view the pages share, built from a product's rows with the same
// verdict, flip, epoch and attribution code `./evals check` and `line` print
// from, and the dispatch of the routes that answer them. Pure: what a product
// reads (its index, its registry, its folders, its git) comes in as
// EvalsSources, so the api child, a browser and a test run the same code.
// A route this table does not hold answers 404, so a host answers its own
// routes first and hands the rest here. Nothing here writes. Typed against
// codecast's RunRow and contract, with every source required, until P3
// retypes it against RunRowCore and makes the sources a product may lack
// optional (evals-converge.md section 3).

export class NotFound extends Error {}
export class BadRequest extends Error {}

// ── What a product supplies ─────────────────────────────────────────────────

/** What the views read from a surface's registry entry. */
export interface QuerySurface {
  id: string;
  title: string;
  route: EvalRoute;
  model: string;
  criteria?: string | null;
  sources: string[];
  reps: { check: number; smoke?: number };
  maxUsdPerRep: number;
}

/** A run's detail as the product reads it from its folder; the query adds the row and its neighbours. */
export type RunDetail = Omit<RunResponse, 'row' | 'siblings' | 'adjacent'>;

/** Everything the views read that the rows alone cannot say. */
export interface EvalsSources {
  /** The product's own facts about this process and its index. */
  health(): HealthResponse;
  /** Every rep, newest first. The same array until the rows change: answers are kept per array (onRows). */
  rows(): Promise<RunRow[]>;
  /** Every surface, in the order the wall lists them before it sorts. */
  surfaces(): readonly QuerySurface[];
  /** The prompt files each rep wrote: epochs, footing and prompt diffs read them. */
  prompts: PromptReader;
  /** Each surface's freezes, counted by visibility. */
  freezeCounts(): Promise<(surface: string) => SurfaceInfo['freezes']>;
  /** One freeze's page without its epochs (the query adds them); NotFound when no home holds it. */
  freeze(id: string, rows: RunRow[]): Promise<Omit<FreezeResponse, 'epochs'>>;
  /** Each surface's staleness word; a surface it leaves out reads `fresh`. */
  staleness(): Promise<Map<string, StalenessWord>>;
  /** One rep's folder. */
  run(row: RunRow): Promise<RunDetail>;
  /** Two reps' scores weighed and their replies. */
  pair(a: string, b: string): Pick<CompareResponse, 'diff' | 'replies'>;
  /** The reply text behind flips, for the before and after cards. */
  flipExamples(surface: string, freezeIds: string[], a: string, b: string): Promise<EvalFlip[]>;
  git: {
    /** Throws BadRequest when `sha` names no commit here. */
    verify(sha: string): void;
    touching(surface: string, from: string | null, to: string | null): CommitRef[];
    between(surface: string, a: string, b: string): CommitRef[];
    commit(sha: string, surface: string | null, whole: boolean): CommitResponse;
    readonly attribution: AttributionGit;
    meta: AttributionMeta;
  };
  bisects: {
    /** As they stand: the wall reads them without settling. */
    summaries(): BisectSummary[];
    /** Marks a bisect whose planner died as failed. */
    settle(): void;
    running(): string | null;
    get(id: string, since: number): BisectResponse | null;
  };
  /** The product's simulation home: its newest failure as a "What moved" line, and its newest session. */
  sim(): { failure: MovedEvent | null; latest: SimSessionSummary | null };
  /** Long jobs the product runs beside the reps (sim sweeps and shrinks). */
  jobs(): SimJob[];
}

// ── Kept answers ────────────────────────────────────────────────────────────

/** Answers computed from the rows alone, per rows array: the sources hand the same array until the rows change, so a new version drops them all. */
const rowMemo = new WeakMap<RunRow[], Map<string, unknown>>();
/** The most answers one rows version keeps; the oldest goes first. */
const ROW_MEMO_CAP = 64;

/**
 * `compute()` once per rows version and key. A promise is kept as it is, so
 * concurrent asks share one computation; one that rejects is dropped, so a
 * git call that failed under load is tried again on the next ask.
 */
export function onRows<T>(rows: RunRow[], key: string, compute: () => T): T {
  let byKey = rowMemo.get(rows);
  if (!byKey) rowMemo.set(rows, (byKey = new Map()));
  const memo = byKey;
  if (memo.has(key)) return memo.get(key) as T;
  const value = compute();
  if (memo.size >= ROW_MEMO_CAP) memo.delete(memo.keys().next().value!);
  memo.set(key, value);
  if (value instanceof Promise) value.catch(() => memo.get(key) === value && memo.delete(key));
  return value;
}

const DAY = 86_400_000;
const MINUTE = 60_000;

/** A surface's rows, newest first (the order onePerSeed and batchSet expect). */
const rowsOf = (rows: RunRow[], surface: string): RunRow[] => rows.filter((r) => r.surface === surface);

/** Does a batch's cadence pass the filter: `all`, `named` (no cadence: a check by hand), or one cadence by name. */
const cadenceMatches = (filter: string, cadence: string | null): boolean => filter === 'all' || (filter === 'named' ? cadence === null : cadence === filter);

export const rowById = (rows: RunRow[], id: string): RunRow => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new NotFound(`no run ${id}`);
  return row;
};

// ── Request checks (the product's own routes take them too) ────────────────

export const need = (q: Record<string, string>, k: string): string => {
  const v = q[k];
  if (!v) throw new BadRequest(`${k} is required`);
  return v;
};
export const flag = (v: string | undefined): boolean => v === '1' || v === 'true';
export const posInt = (v: unknown, what: string, max = 100): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new BadRequest(`${what} takes a whole number from 1 to ${max}`);
  return n;
};
export const posNum = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${what} takes a positive number`);
  return n;
};

/** A batch of the surface (by name or by its address hash) or a commit `verify` accepts (EVALS_SHA_RE first): what an attribution or bisect endpoint may be. */
export function endpointRef(all: RunRow[], surface: string, ref: unknown, what: string, verify: (sha: string) => void): string {
  if (typeof ref !== 'string' || !ref) throw new BadRequest(`${what} is required`);
  if (all.some((r) => r.surface === surface && r.batch === ref)) return ref;
  // A page address names a labelled batch by its hash (evalsBatchRef); the batch is the one that hashes to it.
  if (EVALS_BATCH_TOKEN_RE.test(ref)) {
    const named = resolveEvalsBatchRef(ref, new Set(all.flatMap((r) => (r.surface === surface && r.batch ? [r.batch] : []))));
    if (!named) throw new BadRequest(`${what} ${ref} names no ${surface} batch`);
    return named;
  }
  if (!EVALS_SHA_RE.test(ref)) throw new BadRequest(`${what} ${ref} is neither a ${surface} batch nor a sha`);
  verify(ref);
  return ref;
}

/**
 * Freezes a request names, as ids or id prefixes of 8 or more characters,
 * each one the surface has run: the plan, the bisect and the free answer take
 * the same refs, so the launcher's two asks cannot read different freezes.
 */
export function ranFreezes(all: RunRow[], surface: string, refs: unknown[]): string[] {
  if (refs.some((f) => typeof f !== 'string' || !/^[0-9a-f-]{8,36}$/.test(f))) throw new BadRequest('freezes are freeze ids, or id prefixes of 8 or more characters');
  const ran = new Set(all.filter((r) => r.surface === surface).map((r) => r.freezeId));
  const unknown = (refs as string[]).filter((f) => ![...ran].some((id) => id.startsWith(f)));
  if (unknown.length) throw new BadRequest(`${surface} never ran freeze ${unknown.join(', ')}`);
  return refs as string[];
}

// ── The views ───────────────────────────────────────────────────────────────

/** How finely the wall's strip can tell two scores apart: its plot is about 44 px tall, so a fortieth of the axis is about a pixel. */
const DOT_STEPS = 40;

/**
 * A batch's reps as the strip's faint dots, at the strip's own resolution:
 * reps of one status within a fortieth of the axis draw as one dot, so one is
 * sent. Unscored and dry reps draw nothing and are left out. The surface page
 * reads every rep from GET /surface.
 */
function dotsOf(set: RunRow[], batch: string): SurfaceOverview['dots'] {
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

/**
 * How often each freeze flipped across a window's graded batches (bisect
 * probes left out, as the ledger leaves them), and in how many it ran: the
 * same flips the surface's ledger counts, so the wall can say a flip is a
 * freeze that flaps.
 */
function flipHistory(v: VerdictKit, batches: string[], mine: RunRow[]): Map<string, { flips: number; batches: number }> {
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
function withFlipHistory(v: BatchVerdict, history: Map<string, { flips: number; batches: number }>, mine: RunRow[]): BatchVerdict {
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
 * surface's whole history), so the plate, `./evals check` and the wall mark
 * the same flips: no bisect probe or batch on another footing is ever the
 * well a flip is weighed against.
 */
export function ledgerOf(v: VerdictKit, rows: RunRow[], batches: string[], history: RunRow[]): LedgerRow[] {
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
function adjacentOf(rows: RunRow[], row: RunRow): RunResponse['adjacent'] {
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

const batchOf = (mine: RunRow[], surface: string, batch: string): string => {
  if (!mine.some((r) => r.batch === batch)) throw new NotFound(`no ${surface} batch ${batch}`);
  return batch;
};

/** The views over one product's sources and verdict policy. */
export function evalsViews(src: EvalsSources, policy: VerdictPolicy<VerdictRun>) {
  const v = makeVerdict<VerdictRun>(policy);
  const ruler = policy.ruler;

  const metaOf = (id: string): QuerySurface => {
    const meta = src.surfaces().find((s) => s.id === id);
    if (!meta) throw new NotFound(`no surface ${id}`);
    return meta;
  };
  const known = (id: string): boolean => src.surfaces().some((s) => s.id === id);

  function surfaceOverview(meta: QuerySurface, rows: RunRow[], cadence: string, now: number): { row: CoreRow; moved: MovedEvent[] } {
    const mine = rowsOf(rows, meta.id);
    const line = timeline(mine);
    const graded = line.filter(({ batch }) => gradedSet(mine, batch).length);
    const kept = line.filter(({ at, reps }) => Date.parse(at) >= now - 30 * DAY && cadenceMatches(cadence, reps[0]!.cadence)).map(({ batch, at }) => ({ batch, at, set: batchSet(mine, batch) })).filter(({ set }) => set.length && !set.every((r) => r.status === 'dry'));
    const strip: BatchStats[] = kept.map(({ batch, set }) => v.batchStats(batch, set));
    const last = kept.at(-1);
    const epochs = epochsOf(mine, meta.id, src.prompts);
    // Footing moves between the batches the strip draws: a by-hand batch on another ruler between two nightlies is not on a nightly strip.
    const footing = footingMarkers(kept.flatMap((k) => k.set), ruler);
    const newest = line.at(-1);
    // Each batch weighed once: the latest batch is usually among the newest graded ones the flips read.
    const verdicts = new Map<string, BatchVerdict>();
    const flapping = flipHistory(v, kept.map((k) => k.batch), mine);
    const verdictOf = (batch: string) => verdicts.get(batch) ?? verdicts.set(batch, withFlipHistory(v.batchVerdict(meta, batch, mine), flapping, mine)).get(batch)!;
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
  const overviewCore = (rows: RunRow[], cadence: string, now: number): OverviewCore =>
    onRows(rows, `overview|${cadence}|${Math.floor(now / MINUTE)}`, () => ({ surfaces: src.surfaces().map((m) => surfaceOverview(m, rows, cadence, now)), spendByDay: spendByDayOf(rows, now - 30 * DAY) }));

  async function overview(rows: RunRow[], cadence: string, words: Promise<Map<string, StalenessWord>>, now = Date.now()): Promise<OverviewResponse> {
    const core = overviewCore(rows, cadence, now);
    const countsOf = await src.freezeCounts();
    const staleWords = await words;
    // Call surfaces first, then agent surfaces; within each, a latest batch that separated worse leads.
    const order = (s: CoreRow) => `${s.route === 'call' ? 0 : 1}${s.latest?.regression ? 0 : 1}`;
    const surfacesOut = core.surfaces
      .map(({ row }): SurfaceOverview => ({ ...row, freezes: countsOf(row.id), staleness: staleWords.get(row.id) ?? 'fresh' }))
      .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    const bisects = src.bisects.summaries();
    const sim = src.sim();
    const moved = [
      ...core.surfaces.flatMap((b) => b.moved),
      // A bisect that ended with no answer and nothing spent ran nothing: it moved nothing either.
      ...bisects.filter((b) => b.finishedAt && (b.outcome !== null || b.spentUsd > 0)).map((b): MovedEvent => ({ at: b.finishedAt!, surface: b.surface, kind: 'bisect', id: b.id, outcome: b.outcome })),
      ...(sim.failure ? [sim.failure] : []),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, 12);
    return { cadence, surfaces: surfacesOut, moved, spendByDay: core.spendByDay, bisects, sim: sim.latest };
  }

  async function surfaceView(rows: RunRow[], id: string, f: SurfaceFilter): Promise<SurfaceResponse> {
    const meta = metaOf(id);
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
    const countsOf = await src.freezeCounts();
    const first = batches[0]?.batchAt ?? null;
    const last = batches.at(-1)?.batchAt ?? null;
    // The newest graded batch, weighed as the wall weighs a row's latest: against batches that began before it.
    const newest = [...names].reverse().find((b) => shown.some((r) => r.batch === b && r.cadence !== 'bisect') && gradedSet(shown, b).length);
    const info: SurfaceInfo = { id, title: meta.title, route: meta.route, model: meta.model, criteria: meta.criteria ?? null, freezes: countsOf(id), sources: meta.sources, reps: meta.reps, maxUsdPerRep: meta.maxUsdPerRep };
    return {
      surface: info,
      runs: shown,
      batches,
      epochs: epochsOf(mine, id, src.prompts),
      footing: footingMarkers(shown, ruler),
      ledger: ledgerOf(v, shown, names, mine),
      commits: first ? src.git.touching(id, new Date(Date.parse(first) - DAY).toISOString(), last) : [],
      latest: newest ? withFlipHistory(v.batchVerdict(meta, newest, mine), flipHistory(v, names, mine), mine) : null,
    };
  }

  async function freezeView(rows: RunRow[], id: string): Promise<FreezeResponse> {
    const page = await src.freeze(id, rows);
    const surface = page.freeze.surface;
    return { ...page, epochs: surface && known(surface) ? epochsOf(rowsOf(rows, surface), surface, src.prompts) : [] };
  }

  async function runView(rows: RunRow[], id: string): Promise<RunResponse> {
    const row = rowById(rows, id);
    const { extra, ...detail } = await src.run(row);
    // The contract's key order: the folder's answers, then the neighbours, then the surface's extra.
    return { row, ...detail, siblings: rows.filter((r) => r.batch !== null && r.batch === row.batch && r.freezeId === row.freezeId && r.id !== row.id), adjacent: adjacentOf(rows, row), extra };
  }

  function compareView(rows: RunRow[], a: string, b: string): CompareResponse {
    const ra = rowById(rows, a);
    const rb = rowById(rows, b);
    return { a: ra, b: rb, ...src.pair(a, b), prompts: promptPairs(src.prompts, rb.freezeId, a, b, false) };
  }

  /** Two batches weighed, kept per rows version: the flip examples read every flipped rep's folder. */
  const batchesView = (rows: RunRow[], surface: string, a: string, b: string): Promise<BatchesResponse> => onRows(rows, `batches|${surface}|${a}|${b}`, () => buildBatches(rows, surface, a, b));

  async function buildBatches(rows: RunRow[], surface: string, a: string, b: string): Promise<BatchesResponse> {
    const meta = metaOf(surface);
    const mine = rowsOf(rows, surface);
    batchOf(mine, surface, a);
    batchOf(mine, surface, b);
    const flips = flipsBetween(v, mine, a, b);
    const [sa, sb] = [gradedSet(mine, a), gradedSet(mine, b)];
    const gates = [...new Set([...sa, ...sb].flatMap((r) => r.gatesFailed))].sort();
    const first = flips.ok ? flips.flips[0] : undefined;
    return {
      verdict: v.batchVerdict(meta, b, mine, { against: a }),
      flips,
      gateDeltas: gates.map((id) => ({ id, a: sa.filter((r) => r.gatesFailed.includes(id)).length, b: sb.filter((r) => r.gatesFailed.includes(id)).length })),
      examples: flips.ok ? await src.flipExamples(surface, flips.flips.map((f) => f.freezeId), a, b).catch(() => []) : [],
      promptDiffs: first && first.before[0] && first.after[0] ? promptPairs(src.prompts, first.freezeId, first.before[0], first.after[0]) : [],
    };
  }

  function epochView(rows: RunRow[], surface: string, n: number): EpochResponse {
    metaOf(surface);
    const mine = rowsOf(rows, surface);
    const epochs = epochsOf(mine, surface, src.prompts);
    const epoch = epochs.find((e) => e.n === n);
    if (!epoch) throw new NotFound(`${surface} has no epoch ${n} (it has ${epochs.length})`);
    const previous = epochs.find((e) => e.n === n - 1) ?? null;
    const heads = (e: typeof epoch) => mine.find((r) => r.gitHead === e.gitHead)?.mainSha ?? e.gitHead;
    let commits = previous?.gitHead && epoch.gitHead ? src.git.between(surface, heads(previous)!, heads(epoch)!) : [];
    if (previous && !commits.length) commits = src.git.touching(surface, previous.firstBatchAt, epoch.firstBatchAt);
    return { epoch, previous, diffs: epochPromptDiffs(mine, surface, n, src.prompts), commits };
  }

  /** Tier 0 attribution, kept per rows version: it reads only records, and its flip examples read every flipped rep's folder. */
  const attributionView = (rows: RunRow[], surface: string, good: string | undefined, bad: string | undefined, allCommits = false, freeze?: string): Promise<Attribution> =>
    onRows(rows, `attribution|${surface}|${good ?? ''}|${bad ?? ''}|${allCommits ? 'all' : 'declared'}|${freeze ?? ''}`, () => buildAttribution(rows, surface, good, bad, allCommits, freeze));

  async function buildAttribution(rows: RunRow[], surface: string, good: string | undefined, bad: string | undefined, allCommits: boolean, freeze: string | undefined): Promise<Attribution> {
    metaOf(surface);
    let a: Attribution;
    try {
      a = attribute({ surface, rows: rowsOf(rows, surface), good: good || undefined, bad: bad || undefined, allCommits, ...(freeze ? { freezes: [freeze] } : {}), git: src.git.attribution, reader: src.prompts }, src.git.meta, v);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const examples = a.good.batch && a.bad.batch && a.flipped.length ? await src.flipExamples(surface, a.flipped.map((f) => f.freezeId), a.good.batch, a.bad.batch).catch(() => []) : [];
    return { ...a, examples };
  }

  return { verdict: v, metaOf, known, overview, surfaceView, freezeView, runView, compareView, batchesView, epochView, attributionView };
}

// ── The routes ──────────────────────────────────────────────────────────────

/** The routes every product shares (evals-converge.md section 3, EvalsViewRoutes); the rest are a product's own. */
export const EVALS_VIEW_ROUTE_KEYS = [
  'GET /health',
  'GET /overview',
  'GET /surface/:id',
  'GET /freeze/:id',
  'GET /run/:id',
  'GET /compare',
  'GET /batches',
  'GET /epoch',
  'GET /attribution',
  'GET /commit/:sha',
  'GET /changes',
  'GET /bisects',
  'GET /bisect/:id',
] as const satisfies readonly EvalsRouteKey[];

export type EvalsViewRouteKey = (typeof EVALS_VIEW_ROUTE_KEYS)[number];
const VIEW_KEYS = new Set<string>(EVALS_VIEW_ROUTE_KEYS);
export const isViewRoute = (key: EvalsRouteKey): key is EvalsViewRouteKey => VIEW_KEYS.has(key);

/** What a route's handler is called with: its decoded params, the query and the body. */
export type RouteArgs<K extends EvalsRouteKey> = { params: EvalsRoutes[K]['params'] extends Record<string, never> ? Record<string, string> : EvalsRoutes[K]['params']; query: Record<string, string>; body: unknown };
export type RouteHandler<K extends EvalsRouteKey> = (a: RouteArgs<K>) => Promise<EvalsResponse<K>> | EvalsResponse<K>;
/** A route's handler once its key is chosen at run time: matchEvalsRoute decoded exactly the params that key's pattern names. */
export type AnyRouteHandler = (a: { params: Record<string, string>; query: Record<string, string>; body: unknown }) => unknown;

const errorBody = (status: number, error: string, reason?: EvalsErrorBody['reason']): { status: number; body: EvalsErrorBody } => ({ status, body: { error, ...(reason ? { reason } : {}) } });

/** The 404 a request no table holds answers with. */
export const noRoute = (req: EvalsBridgeRequest): EvalsBridgeResponse => ({ id: req.id, ...errorBody(404, `no route ${req.method} ${req.path}`, 'not-found') });

/**
 * One request answered by `handler`: its value with 200, or an error body
 * with its status (NotFound 404, BadRequest or what `badRequest` names 400,
 * anything else 500). Never throws.
 */
export async function answer(req: EvalsBridgeRequest, route: { params: Record<string, string> }, handler: AnyRouteHandler, badRequest: (e: unknown) => boolean = () => false): Promise<EvalsBridgeResponse> {
  const reply = (r: { status: number; body: unknown }): EvalsBridgeResponse => ({ id: req.id, ...r });
  try {
    const body = await handler({ params: route.params, query: req.query ?? {}, body: req.body });
    return reply({ status: 200, body });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof NotFound) return reply(errorBody(404, msg, 'not-found'));
    if (e instanceof BadRequest || badRequest(e)) return reply(errorBody(400, msg, 'bad-request'));
    return reply(errorBody(500, msg));
  }
}

/** When each row last changed: what /changes reads its cursor against. */
const sigOf = (r: RunRow): string => `${r.status}|${r.score}|${r.scoreVersions}|${r.gatesFailed.join(',')}|${r.costUsd}|${r.judgeCostUsd}`;

/**
 * The shared routes over one product's sources and verdict policy. A request
 * for any other route answers 404, so a product answers its own routes first.
 */
export function createEvalsHandler(src: EvalsSources, policy: VerdictPolicy<VerdictRun>): (req: EvalsBridgeRequest) => Promise<EvalsBridgeResponse> {
  const views = evalsViews(src, policy);

  // /changes: when each row last changed, as this handler saw it; rows present at the first look count as old (0).
  const seen = new Map<string, { sig: string; at: number }>();
  let primed = false;

  /**
   * Everything that moved since a cursor (a time in ms the last answer gave):
   * reps that landed or were rescored, bisects whose state moved, and jobs. A
   * cursor from before this handler started is fine: rows it never saw change
   * count as old, so a restart does not replay the whole index.
   */
  async function changes(since: number): Promise<ChangesResponse> {
    const now = Date.now();
    const all = await src.rows();
    for (const r of all) {
      const sig = sigOf(r);
      const hit = seen.get(r.id);
      if (!hit) seen.set(r.id, { sig, at: primed ? now : 0 });
      else if (hit.sig !== sig) seen.set(r.id, { sig, at: now });
    }
    primed = true;
    src.bisects.settle();
    return {
      cursor: now,
      runs: all.filter((r) => (seen.get(r.id)?.at ?? 0) > since),
      bisects: src.bisects.summaries().filter((b) => Date.parse(b.updatedAt) > since),
      jobs: src.jobs().filter((j) => Date.parse(j.updatedAt) > since),
    };
  }

  const routes: { [K in EvalsViewRouteKey]: RouteHandler<K> } = {
    'GET /health': () => src.health(),
    'GET /overview': async ({ query }) => {
      // Staleness is asked first: the product may read it while the rows load.
      const words = src.staleness();
      return views.overview(await src.rows(), query.cadence || 'all', words);
    },
    'GET /surface/:id': async ({ params, query }) => views.surfaceView(await src.rows(), params.id, { from: query.from, to: query.to, model: query.model, cadence: query.cadence, dry: flag(query.dry), bisect: flag(query.bisect) }),
    'GET /freeze/:id': async ({ params }) => {
      if (!/^[0-9a-f-]{4,36}$/.test(params.id)) throw new BadRequest('a freeze id is hex with dashes');
      return views.freezeView(await src.rows(), params.id);
    },
    'GET /run/:id': async ({ params }) => views.runView(await src.rows(), params.id),
    'GET /compare': async ({ query }) => views.compareView(await src.rows(), need(query, 'a'), need(query, 'b')),
    'GET /batches': async ({ query }) => views.batchesView(await src.rows(), need(query, 'surface'), need(query, 'a'), need(query, 'b')),
    'GET /epoch': async ({ query }) => {
      const n = posInt(need(query, 'n'), 'n', 10_000)!;
      return views.epochView(await src.rows(), need(query, 'surface'), n);
    },
    'GET /attribution': async ({ query }) => {
      const surface = need(query, 'surface');
      const all = await src.rows();
      const ref = (k: 'good' | 'bad') => (query[k] ? endpointRef(all, surface, query[k], k, src.git.verify) : undefined);
      const freeze = query.freeze ? ranFreezes(all, surface, [query.freeze])[0] : undefined;
      return views.attributionView(all, surface, ref('good'), ref('bad'), flag(query.allCommits), freeze);
    },
    'GET /commit/:sha': ({ params, query }) => {
      if (query.surface && !views.known(query.surface)) throw new NotFound(`no surface ${query.surface}`);
      return src.git.commit(params.sha, query.surface || null, flag(query.whole));
    },
    'GET /changes': ({ query }) => changes(Number(query.since) || 0),
    'GET /bisects': (): BisectListResponse => {
      src.bisects.settle();
      return { bisects: src.bisects.summaries(), running: src.bisects.running() };
    },
    'GET /bisect/:id': ({ params, query }) => {
      const b = src.bisects.get(params.id, Number(query.since) || 0);
      if (!b) throw new NotFound(`no bisect ${params.id}`);
      return b;
    },
  };

  return (req) => {
    const route = matchEvalsRoute(req.method, req.path);
    if (!route || !isViewRoute(route.key)) return Promise.resolve(noRoute(req));
    return answer(req, route, routes[route.key] as AnyRouteHandler);
  };
}

