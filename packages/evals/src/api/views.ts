import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  Attribution,
  BatchesResponse,
  BatchStats,
  BatchVerdict,
  CompareResponse,
  EpochResponse,
  FreezeInfo,
  FreezeResponse,
  LedgerCell,
  LedgerRow,
  MomentMessage,
  MovedEvent,
  OverviewResponse,
  RunResponse,
  RunRow,
  StalenessWord,
  SurfaceInfo,
  SurfaceOverview,
  SurfaceResponse,
} from '@codecast/shared/contracts/evalsApi';
import type { ConvoMessage, Freeze } from '@platform/evals';
import { diffRuns } from '@platform/evals/render';

import { sessionsDir } from '../../../web/store/__tests__/sim/history';
import { codecastFreezeStore } from '../adapters/freezes';
import { PASS_AT } from '../adapters/judge';
import { describeFreeze, freezeMeta, loadLabel, loadSnapshot, productionReplyOf, type LoadedSnapshot } from '../adapters/resolver';
import { batchSet, batchStats, batchVerdict, footingChange, footingOf, majority, scoreOrZero } from '../commands/verdict';
import { attribute } from '../history/attribution';
import { epochPromptDiffs, epochsOf, folderPromptReader, footingMarkers, promptPairs, timeline } from '../history/epochs';
import { flipExamples, flipsBetween, gradedSet } from '../history/flips';
import { labelPath } from '../labels';
import { surfaceMeta, surfaces } from '../registry';
import type { SurfaceMeta } from '../surface';
import { listBisects } from '../bisect/state';
import { agentsOf, callsOf, filesOf, guardOf, judgeOf, logTailOf, readJsonFile, replyOf, resultOf, runDir, runJsonOf, scoreOf, scoreVersionsOf, sendsOf } from './files';
import { commitsBetween, commitsTouching } from './git';
import { latestSimSession, simSessions } from './simHistory';

// The analysis endpoints (evals-ui.md sections 3.4 and 4): each builds its
// answer from the index's RunRows with the same verdict, flip, epoch and
// attribution code `./evals check` and `line` print from, so the pages and
// the CLI cannot disagree. Nothing here writes.

export class NotFound extends Error {}
export class BadRequest extends Error {}

/** Answers computed from the index alone, per rows array: handlers.ts hands the same array until the index changes, so a new version drops them all. */
const rowMemo = new WeakMap<RunRow[], Map<string, unknown>>();
/** The most answers one index version keeps; the oldest goes first. */
const ROW_MEMO_CAP = 64;

/**
 * `compute()` once per index version and key. A promise is kept as it is, so
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

export const metaOf = (id: string): SurfaceMeta => {
  const meta = surfaceMeta(id);
  if (!meta) throw new NotFound(`no surface ${id}`);
  return meta;
};

/** A surface's rows, newest first (the order onePerSeed and batchSet expect). */
const rowsOf = (rows: RunRow[], surface: string): RunRow[] => rows.filter((r) => r.surface === surface);

/** Does a batch's cadence pass the filter: `all`, `named` (no cadence: a check by hand), or one cadence by name. */
const cadenceMatches = (filter: string, cadence: string | null): boolean => filter === 'all' || (filter === 'named' ? cadence === null : cadence === filter);

// ── Freezes ────────────────────────────────────────────────────────────────

/**
 * A slow read kept in memory: the first call waits for it, and later calls
 * get the last answer at once while a read older than `maxAgeMs` runs in the
 * background (a failed one keeps the last answer). The api child runs at the
 * daemon's utility priority on a loaded machine, where a read that costs
 * 20 ms of CPU waits seconds for it, so a polled page must not wait on these.
 */
export function kept<T>(read: () => Promise<T>, maxAgeMs: number): () => Promise<T> {
  let last: { at: number; value: T } | null = null;
  let pending: Promise<T> | null = null;
  const start = (): Promise<T> =>
    (pending ??= read()
      .then((value) => {
        last = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        pending = null;
      }));
  return () => {
    if (!last) return start();
    if (Date.now() - last.at >= maxAgeMs) void start().catch(() => null);
    return Promise.resolve(last.value);
  };
}

/** Both freeze homes, read again at most every 5 s: the home page counts them per surface on every poll. */
const allFreezes = kept(() => codecastFreezeStore().list(), 5000);

const freezeCounts = (all: Freeze[], surface: string) => {
  const mine = all.filter((f) => freezeMeta(f).surface === surface);
  const pub = mine.filter((f) => freezeMeta(f).visibility === 'public').length;
  return { public: pub, private: mine.length - pub };
};

// ── Staleness ──────────────────────────────────────────────────────────────

/** The words from the worker (staleWorker.ts), or every surface fresh when it cannot answer. */
function askWorker(): Promise<Map<string, StalenessWord>> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./staleWorker.ts', import.meta.url).href);
    } catch {
      resolve(new Map());
      return;
    }
    const done = (words: Record<string, StalenessWord> | null) => {
      void worker.terminate();
      resolve(new Map(Object.entries(words ?? {})));
    };
    worker.onmessage = (e: MessageEvent<Record<string, StalenessWord> | null>) => done(e.data);
    worker.onerror = () => done(null);
    worker.postMessage(null);
  });
}

/**
 * Each surface's staleness word, asked again at most every 30 s. Asked in a
 * worker, because staleness() reads git synchronously and takes seconds
 * under load: the first overview starts it before it loads the index and
 * awaits it last, and later ones take the last answer.
 */
export const stalenessWords = kept(askWorker, 30_000);

// ── Overview ───────────────────────────────────────────────────────────────

/** A batch's reps as the strip's faint dots. */
const dotsOf = (set: RunRow[], batch: string) => set.map((r) => ({ batch, at: r.stamp, score: r.score, status: r.status }));

/** How many of a surface's newest graded batches report their flips on the home wall. */
const FLIP_BATCHES = 4;
/** A batch is still landing when a rep in it is unscored and this recent. */
const LANDING_MS = 30 * 60_000;

/** A surface's wall row before the two facts read outside the index: its freeze counts and staleness word. */
type CoreRow = Omit<SurfaceOverview, 'freezes' | 'staleness'>;

function surfaceOverview(meta: SurfaceMeta, rows: RunRow[], cadence: string, now: number): { row: CoreRow; moved: MovedEvent[] } {
  const mine = rowsOf(rows, meta.id);
  const line = timeline(mine);
  const graded = line.filter(({ batch }) => gradedSet(mine, batch).length);
  const kept = line.filter(({ at, reps }) => Date.parse(at) >= now - 30 * DAY && cadenceMatches(cadence, reps[0]!.cadence)).map(({ batch, at }) => ({ batch, at, set: batchSet(mine, batch) })).filter(({ set }) => set.length && !set.every((r) => r.status === 'dry'));
  const strip: BatchStats[] = kept.map(({ batch, set }) => batchStats(batch, set));
  const last = kept.at(-1);
  const epochs = epochsOf(mine, meta.id);
  const footing = footingMarkers(mine);
  const newest = line.at(-1);
  // Each batch weighed once: the latest batch is usually among the newest graded ones the flips read.
  const verdicts = new Map<string, BatchVerdict>();
  const verdictOf = (batch: string) => verdicts.get(batch) ?? verdicts.set(batch, batchVerdict(meta, batch, mine, { earlierOnly: true })).get(batch)!;
  const moved: MovedEvent[] = [
    ...epochs.slice(1).map((e): MovedEvent => ({ at: e.firstBatchAt, surface: meta.id, kind: 'epoch', epoch: e.n, batch: e.firstBatch, changedFreezes: e.changedFreezes.length })),
    ...footing.map((m): MovedEvent => ({ at: m.batchAt, surface: meta.id, kind: 'footing', batch: m.batch, change: m.kind, from: m.from, to: m.to })),
    ...graded.slice(-FLIP_BATCHES).flatMap(({ batch, at }): MovedEvent[] => {
      const flips = verdictOf(batch).flips;
      const broke = flips.filter((f) => f.direction === 'broke').length;
      return flips.length ? [{ at, surface: meta.id, kind: 'flips', batch, broke, fixed: flips.length - broke }] : [];
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
      spend7dUsd: mine.filter((r) => Date.parse(r.stamp) >= now - 7 * DAY).reduce((s, r) => s + r.costUsd + r.judgeCostUsd, 0),
      epochs,
      footing,
      landing: !!newest && newest.reps.some((r) => r.status === 'unscored' && now - Date.parse(r.stamp) < LANDING_MS),
    },
    moved,
  };
}

/** Everything the wall computes from the index alone. */
interface OverviewCore {
  surfaces: Array<{ row: CoreRow; moved: MovedEvent[] }>;
  spendByDay: OverviewResponse['spendByDay'];
}

const MINUTE = 60_000;

/** The overview's index-only part for one cadence, kept per index version and minute (the 30-day window and the landing pulse move with the clock). */
const overviewCore = (rows: RunRow[], cadence: string, now: number): OverviewCore => onRows(rows, `overview|${cadence}|${Math.floor(now / MINUTE)}`, () => buildOverviewCore(rows, cadence, now));

function buildOverviewCore(rows: RunRow[], cadence: string, now: number): OverviewCore {
  const spend = new Map<string, { usd: number; judgeUsd: number }>();
  for (const r of rows) {
    if (Date.parse(r.stamp) < now - 30 * DAY) continue;
    const day = r.stamp.slice(0, 10);
    const s = spend.get(day) ?? { usd: 0, judgeUsd: 0 };
    s.usd += r.costUsd;
    s.judgeUsd += r.judgeCostUsd;
    spend.set(day, s);
  }
  return {
    surfaces: surfaces().map((m) => surfaceOverview(m, rows, cadence, now)),
    spendByDay: [...spend].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, s]) => ({ day, ...s })),
  };
}

/** The newest failing sim run, as a "What moved" line. */
function simFailureEvent(sessions: ReturnType<typeof simSessions>): MovedEvent | null {
  for (const { session, runs } of sessions) {
    if (session.unsessioned) continue;
    const failed = runs.filter((r) => !r.passed && r.dir).at(-1);
    if (!failed) continue;
    const result = readJsonFile<{ invariant?: { id?: string } }>(join(sessionDirOf(session.id), failed.dir!, 'result.json'));
    return { at: session.startedAt, surface: null, kind: 'sim-failure', session: session.id, run: failed.dir!, scenario: failed.scenario, invariant: result?.invariant?.id ?? '' };
  }
  return null;
}
const sessionDirOf = (id: string): string => join(sessionsDir(), id);

export async function overview(rows: RunRow[], cadence = 'all', words = stalenessWords(), now = Date.now()): Promise<OverviewResponse> {
  const core = overviewCore(rows, cadence, now);
  const freezes = await allFreezes();
  const staleWords = await words;
  // Call surfaces first, then agent surfaces; within each, a latest batch that separated worse leads.
  const order = (s: CoreRow) => `${s.route === 'call' ? 0 : 1}${s.latest?.regression ? 0 : 1}`;
  const surfacesOut = core.surfaces
    .map(({ row }): SurfaceOverview => ({ ...row, freezes: freezeCounts(freezes, row.id), staleness: staleWords.get(row.id) ?? 'fresh' }))
    .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  const bisects = listBisects();
  const sims = simSessions();
  const sim = simFailureEvent(sims);
  const moved = [
    ...core.surfaces.flatMap((b) => b.moved),
    ...bisects.filter((b) => b.finishedAt).map((b): MovedEvent => ({ at: b.finishedAt!, surface: b.surface, kind: 'bisect', id: b.id, outcome: b.outcome })),
    ...(sim ? [sim] : []),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 12);
  return {
    cadence,
    surfaces: surfacesOut,
    moved,
    spendByDay: core.spendByDay,
    bisects,
    sim: latestSimSession(sims),
  };
}

// ── One surface over time ──────────────────────────────────────────────────

export interface SurfaceFilter {
  from?: string;
  to?: string;
  model?: string;
  cadence?: string;
  dry?: boolean;
  bisect?: boolean;
}

/**
 * The freeze ledger: one row per freeze, one well per batch. A well's flip
 * compares its majority with the same freeze's previous well on the same
 * footing, so a model or judge change never reads as a flip.
 */
export function ledgerOf(rows: RunRow[], batches: string[]): LedgerRow[] {
  const byFreeze = new Map<string, LedgerRow>();
  const prev = new Map<string, { majority: boolean; footing: ReturnType<typeof footingOf> }>();
  for (const batch of batches) {
    const set = gradedSet(rows, batch);
    const m = majority(set);
    for (const freezeId of new Set(set.map((r) => r.freezeId))) {
      const reps = set.filter((r) => r.freezeId === freezeId);
      const first = reps[0]!;
      let row = byFreeze.get(freezeId);
      if (!row) {
        row = { freezeId, name: first.freezeName, visibility: first.visibility, flips: 0, cells: {} };
        byFreeze.set(freezeId, row);
      }
      const now = m.get(freezeId) ?? null;
      const footing = footingOf(first);
      const before = prev.get(freezeId);
      const flip = now !== null && before && !footingChange(before.footing, footing) && before.majority !== now ? (now ? 'fixed' : 'broke') : null;
      if (flip) row.flips += 1;
      const cell: LedgerCell = { reps: reps.length, passed: reps.filter((r) => r.status === 'pass').length, mean: reps.reduce((s, r) => s + scoreOrZero(r), 0) / reps.length, majority: now, flip };
      row.cells[batch] = cell;
      if (now !== null) prev.set(freezeId, { majority: now, footing });
    }
  }
  return [...byFreeze.values()].sort((a, b) => b.flips - a.flips || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function surfaceView(rows: RunRow[], id: string, f: SurfaceFilter): Promise<SurfaceResponse> {
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
  const batches = names.map((b) => batchStats(b, batchSet(shown, b))).filter((s) => s.reps + s.crashes > 0);
  const all = await allFreezes();
  const first = batches[0]?.batchAt ?? null;
  const last = batches.at(-1)?.batchAt ?? null;
  const info: SurfaceInfo = { id, title: meta.title, route: meta.route, model: meta.model, criteria: meta.criteria ?? null, freezes: freezeCounts(all, id), sources: meta.sources, reps: meta.reps, maxUsdPerRep: meta.maxUsdPerRep };
  return {
    surface: info,
    runs: shown,
    batches,
    epochs: epochsOf(mine, id),
    footing: footingMarkers(mine),
    ledger: ledgerOf(shown, names),
    commits: first ? commitsTouching(id, new Date(Date.parse(first) - DAY).toISOString(), last) : [],
  };
}

// ── One freeze ─────────────────────────────────────────────────────────────

const momentOf = (m: ConvoMessage): MomentMessage => ({ n: m.n, id: m.id, at: m.at, channel: m.channel, room: m.room ?? null, isGroup: m.isGroup, direction: m.direction, from: m.from, to: m.to ?? null, text: m.text, status: (m as { status?: string | null }).status ?? null, ...(m.meta ? { meta: m.meta as Record<string, unknown> } : {}) });

/** A freeze by full id or a prefix the store resolves; NotFound when neither home holds it. */
export async function freezeById(id: string): Promise<Freeze> {
  let f: Freeze | null;
  try {
    f = await codecastFreezeStore().get(id);
  } catch (e) {
    throw new BadRequest(e instanceof Error ? e.message : String(e));
  }
  if (!f) throw new NotFound(`no freeze ${id}`);
  return f;
}

export async function freezeView(rows: RunRow[], id: string): Promise<FreezeResponse> {
  const f = await freezeById(id);
  const m = freezeMeta(f);
  const surface = String(m.surface ?? '');
  const reps = rows.filter((r) => r.freezeId === f.id);
  let loaded: LoadedSnapshot | undefined;
  try {
    loaded = loadSnapshot(f);
  } catch {
    loaded = undefined;
  }
  const label = loaded ? loadLabel(f, loaded) : existsSync(labelPath(surface, f.id)) ? loadLabel(f) : undefined;
  const labelSource: FreezeResponse['labelSource'] = loaded?.fixture?.label !== undefined ? 'inline' : label !== undefined ? 'labels' : null;
  // The moment the surface's own describe() renders; with no snapshot on this machine, the judge prompt a rep kept stands in.
  let moment = ((await describeFreeze(f).catch(() => null)) ?? []).map(momentOf);
  if (!moment.length) {
    const judged = reps.find((r) => existsSync(join(runDir(r.id), 'judge', 'prompt.md')));
    const prompt = judged ? judgeOf(runDir(judged.id))?.prompt : null;
    if (prompt) moment = [{ n: 1, id: 'judge-prompt', at: f.asOf, channel: 'judge', isGroup: false, direction: 'system', from: 'judge/prompt.md', text: prompt }];
  }
  const production = await productionReplyOf(f).catch(() => null);
  const info: FreezeInfo = {
    id: f.id,
    name: f.name,
    surface,
    visibility: m.visibility === 'public' ? 'public' : 'private',
    createdAt: f.createdAt,
    asOf: f.asOf,
    anchor: f.anchor,
    subject: { kind: String(f.subject.kind), id: f.subject.id, title: f.subject.title, subtitle: (f.subject as { subtitle?: string | null }).subtitle ?? null },
    trigger: f.trigger ?? null,
    notes: f.notes ?? null,
    judge: f.judge ?? null,
    tags: f.tags ?? [],
    freezeSha: reps.find((r) => r.freezeSha)?.freezeSha ?? null,
  };
  return {
    freeze: info,
    label: label ?? null,
    labelSource,
    moment,
    cutAt: moment.filter((x) => x.at <= f.asOf).length,
    production: production ? { messages: production.messages.map(momentOf), verdict: production.verdict ? { score: production.verdict.score, pass: production.verdict.pass, reasoning: production.verdict.reasoning ?? null } : null } : null,
    runs: reps,
    epochs: surface && surfaceMeta(surface) ? epochsOf(rowsOf(rows, surface), surface) : [],
  };
}

// ── One run ────────────────────────────────────────────────────────────────

export const rowById = (rows: RunRow[], id: string): RunRow => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new NotFound(`no run ${id}`);
  return row;
};

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

export async function runView(rows: RunRow[], id: string): Promise<RunResponse> {
  const row = rowById(rows, id);
  const dir = runDir(id);
  const meta = surfaceMeta(row.surface);
  const run = runJsonOf(dir, row, meta?.route ?? 'call');
  const score = scoreOf(dir);
  let criteria: string | null = meta?.criteria ?? null;
  if (!score) criteria = (await freezeById(row.freezeId).catch(() => null))?.judge ?? criteria;
  return {
    row,
    run,
    result: resultOf(dir),
    score,
    scoreVersions: scoreVersionsOf(dir),
    rubric: score ? null : { criteria, passMark: PASS_AT },
    sends: sendsOf(dir),
    calls: callsOf(dir),
    agents: agentsOf(dir, run.model || row.model),
    judge: judgeOf(dir),
    guard: guardOf(dir),
    files: filesOf(dir),
    logTail: logTailOf(dir),
    siblings: rows.filter((r) => r.batch !== null && r.batch === row.batch && r.freezeId === row.freezeId && r.id !== row.id),
    adjacent: adjacentOf(rows, row),
    extra: row.surface === 'org-review' ? { gradeAuto: readJsonFile(join(dir, 'grade-auto.json')) ?? undefined, hashes: readJsonFile(join(dir, 'hashes.json')) ?? undefined } : null,
  };
}

export function compareView(rows: RunRow[], a: string, b: string): CompareResponse {
  const ra = rowById(rows, a);
  const rb = rowById(rows, b);
  return {
    a: ra,
    b: rb,
    diff: diffRuns({ verdict: scoreOf(runDir(a)) }, { verdict: scoreOf(runDir(b)) }),
    replies: { a: replyOf(runDir(a)), b: replyOf(runDir(b)) },
    prompts: promptPairs(folderPromptReader(), rb.freezeId, a, b, false),
  };
}

// ── Two batches, an epoch, attribution ─────────────────────────────────────

const batchOf = (mine: RunRow[], surface: string, batch: string): string => {
  if (!mine.some((r) => r.batch === batch)) throw new NotFound(`no ${surface} batch ${batch}`);
  return batch;
};

/** Two batches weighed, kept per index version: the flip examples read every flipped rep's folder. */
export const batchesView = (rows: RunRow[], surface: string, a: string, b: string): Promise<BatchesResponse> => onRows(rows, `batches|${surface}|${a}|${b}`, () => buildBatches(rows, surface, a, b));

async function buildBatches(rows: RunRow[], surface: string, a: string, b: string): Promise<BatchesResponse> {
  const meta = metaOf(surface);
  const mine = rowsOf(rows, surface);
  batchOf(mine, surface, a);
  batchOf(mine, surface, b);
  const flips = flipsBetween(mine, a, b);
  const [sa, sb] = [gradedSet(mine, a), gradedSet(mine, b)];
  const gates = [...new Set([...sa, ...sb].flatMap((r) => r.gatesFailed))].sort();
  const first = flips.ok ? flips.flips[0] : undefined;
  return {
    verdict: batchVerdict(meta, b, mine, { against: a }),
    flips,
    gateDeltas: gates.map((id) => ({ id, a: sa.filter((r) => r.gatesFailed.includes(id)).length, b: sb.filter((r) => r.gatesFailed.includes(id)).length })),
    examples: flips.ok ? await flipExamples(surface, flips.flips.map((f) => f.freezeId), a, b).catch(() => []) : [],
    promptDiffs: first && first.before[0] && first.after[0] ? promptPairs(folderPromptReader(), first.freezeId, first.before[0], first.after[0]) : [],
  };
}

export function epochView(rows: RunRow[], surface: string, n: number): EpochResponse {
  metaOf(surface);
  const mine = rowsOf(rows, surface);
  const epochs = epochsOf(mine, surface);
  const epoch = epochs.find((e) => e.n === n);
  if (!epoch) throw new NotFound(`${surface} has no epoch ${n} (it has ${epochs.length})`);
  const previous = epochs.find((e) => e.n === n - 1) ?? null;
  const heads = (e: typeof epoch) => mine.find((r) => r.gitHead === e.gitHead)?.mainSha ?? e.gitHead;
  let commits = previous?.gitHead && epoch.gitHead ? commitsBetween(surface, heads(previous)!, heads(epoch)!) : [];
  if (previous && !commits.length) commits = commitsTouching(surface, previous.firstBatchAt, epoch.firstBatchAt);
  return { epoch, previous, diffs: epochPromptDiffs(mine, surface, n), commits };
}

/** Tier 0 attribution, kept per index version: it reads only records, and its flip examples read every flipped rep's folder. */
export const attributionView = (rows: RunRow[], surface: string, good: string | undefined, bad: string | undefined): Promise<Attribution> => onRows(rows, `attribution|${surface}|${good ?? ''}|${bad ?? ''}`, () => buildAttribution(rows, surface, good, bad));

async function buildAttribution(rows: RunRow[], surface: string, good: string | undefined, bad: string | undefined): Promise<Attribution> {
  metaOf(surface);
  let a: Attribution;
  try {
    a = attribute({ surface, rows: rowsOf(rows, surface), good: good || undefined, bad: bad || undefined });
  } catch (e) {
    throw new BadRequest(e instanceof Error ? e.message : String(e));
  }
  const examples = a.good.batch && a.bad.batch && a.flipped.length ? await flipExamples(surface, a.flipped.map((f) => f.freezeId), a.good.batch, a.bad.batch).catch(() => []) : [];
  return { ...a, examples };
}
