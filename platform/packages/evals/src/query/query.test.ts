/**
 * The shared handler over two products: a minimal one with rows and
 * surfaces alone (union's shape: no git, prompts, freezes, bisects or change
 * feed) and a full one (codecast's shape, with every source and its own
 * extras). Every view answers from the rows with the product's own verdict
 * policy; a source left out turns its capability off and its routes 404.
 */
import { describe, expect, it } from 'bun:test';
import { makeVerdict, statusPassRule, type PromptReader } from '../analysis';
import { runRowCoreProblems, type BisectSummary, type EvalsBridgeRequest, type RunRowCore } from '../contract';
import { BadRequest, capabilitiesOf, createEvalsHandler, type EvalsSources, type HandlerPolicy, type QuerySurface } from '.';

const passed = statusPassRule(0.7);
const policy: HandlerPolicy = { passed, ruler: (r) => r.ruler ?? null };

const NIGHT = (n: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + n * 86_400_000).toISOString();

/** One rep, the core fields only. */
function rep(surface: string, freeze: string, night: number, seed: number, score: number | null, extra: Partial<RunRowCore> = {}): RunRowCore {
  const batch = NIGHT(night);
  return {
    id: `${surface}-${freeze}-seed${seed}-${batch}`,
    surface,
    freezeId: freeze,
    freezeName: `moment ${freeze}`,
    visibility: 'private',
    seed,
    stamp: batch,
    batch,
    batchAt: batch,
    cadence: 'nightly',
    status: score === null ? 'unscored' : score >= 0.7 ? 'pass' : 'fail',
    score,
    passMark: 0.7,
    gatesFailed: [],
    checks: {},
    missedFloors: [],
    model: 'm1',
    judgeModel: 'j1',
    ruler: 'j1#r',
    gitHead: null,
    mainSha: null,
    dirty: false,
    offBranch: false,
    treePatch: null,
    sourceHashDisk: null,
    promptSha: 'p1',
    freezeSha: null,
    liveReads: 0,
    costUsd: 0.01,
    judgeCostUsd: 0.001,
    realMs: 1000,
    ...extra,
  };
}

/** A surface whose two freezes pass for three nights, then `fb02` breaks on the fourth. Newest first, as a product hands rows. */
function rowsFor(surface: string, extra: Partial<RunRowCore> = {}): RunRowCore[] {
  const out: RunRowCore[] = [];
  for (let night = 0; night < 4; night++)
    for (const f of ['fa01', 'fb02'])
      for (let seed = 1; seed <= 3; seed++) out.push(rep(surface, f, night, seed, f === 'fb02' && night === 3 ? 0.2 : 0.9, extra));
  return out.reverse();
}

const SURFACES: QuerySurface[] = [{ id: 'outreach', title: 'Outreach', route: null, model: null, gate: { rule: 'jeffreys', status: 'red', detail: 'fb02 under its floor' } }];

const req = (method: string, path: string, query: Record<string, string> = {}): EvalsBridgeRequest => ({ method, path, query });

describe('a product with rows and surfaces alone', () => {
  // Union's shape: no model or judge on record, so its verdicts are unfooted.
  const rows = rowsFor('outreach', { model: null, judgeModel: null, ruler: null, promptSha: null });
  const src: EvalsSources = { rows: async () => rows, surfaces: async () => SURFACES };
  const handle = createEvalsHandler(src, { ...policy, stallAfterMs: 5 * 60_000 });

  it('every fixture row is a valid core row', () => {
    expect(rows.flatMap(runRowCoreProblems)).toEqual([]);
  });

  it('reports what it can fill, and /health counts its rows', async () => {
    expect(capabilitiesOf(src)).toEqual({ trends: true, freezes: false, epochs: false, attribution: false, commits: false, bisect: false, changes: false, liveness: false, models: true, compare: false, marks: true });
    // A product says so when its rows name no model or judge, and no pair to weigh means no comparison.
    expect(capabilitiesOf({ ...src, models: false })).toMatchObject({ models: false, compare: false });
    // A product that records no pass mark says so, and then no view draws one.
    expect(capabilitiesOf({ ...src, marks: false })).toMatchObject({ marks: false });
    expect((await handle(req('GET', '/compare', { a: rows[0]!.id, b: rows[1]!.id }))).status).toBe(404);
    const h = await handle(req('GET', '/health'));
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ runsIndexed: 24, index: { state: 'warm', done: 24, total: 24 }, capabilities: { trends: true, liveness: true, changes: false } });
  });

  it('draws the wall from the rows: strip, latest verdict and flips, with no freezes, staleness or bisects', async () => {
    const { status, body } = await handle(req('GET', '/overview'));
    expect(status).toBe(200);
    const o = body as { surfaces: Array<Record<string, any>>; moved: Array<Record<string, any>>; bisects: unknown[] };
    const s = o.surfaces[0]!;
    expect(s.freezes).toEqual({ public: 0, private: 0 });
    expect('staleness' in s).toBe(false);
    expect(s.strip.map((b: { batch: string }) => b.batch)).toEqual([NIGHT(0), NIGHT(1), NIGHT(2), NIGHT(3)]);
    expect(s.epochs).toEqual([]);
    expect(s.latest.batch).toBe(NIGHT(3));
    expect(s.latest.unfooted).toBe(true);
    expect(s.latest.flips.map((f: { freezeId: string; direction: string }) => [f.freezeId, f.direction])).toEqual([['fb02', 'broke']]);
    expect(o.moved).toEqual([{ at: NIGHT(3), surface: 'outreach', kind: 'flips', batch: NIGHT(3), broke: 1, fixed: 0, noise: 0 }]);
    expect(o.bisects).toEqual([]);
  });

  it('weighs a batch with the product policy, the same verdict the analysis gives directly', async () => {
    const { body } = await handle(req('GET', '/batches', { surface: 'outreach', a: NIGHT(2), b: NIGHT(3) }));
    const direct = makeVerdict(policy).batchVerdict({ id: 'outreach', model: '' }, NIGHT(3), rows, { against: NIGHT(2) });
    expect((body as { verdict: unknown }).verdict).toEqual(direct);
    expect(body).toMatchObject({ examples: [], promptDiffs: [], flips: { ok: true } });
  });

  it('the surface page carries the gate as data and no product fields it lacks', async () => {
    const { body } = await handle(req('GET', '/surface/outreach'));
    const b = body as Record<string, any>;
    expect(b.surface).toEqual({ id: 'outreach', title: 'Outreach', route: null, model: null, gate: SURFACES[0]!.gate });
    expect(b.ledger.map((l: { freezeId: string; flips: number }) => [l.freezeId, l.flips])).toEqual([['fb02', 1], ['fa01', 0]]);
    expect([b.epochs, b.commits]).toEqual([[], []]);
  });

  it('a run page holds the row and its neighbours, and no detail the product cannot read', async () => {
    const id = rows.find((r) => r.freezeId === 'fb02' && r.seed === 2 && r.batch === NIGHT(2))!.id;
    const { body } = await handle(req('GET', `/run/${encodeURIComponent(id)}`));
    const b = body as Record<string, any>;
    expect(b.row.id).toBe(id);
    expect([b.result, b.score, b.sends, b.judge]).toEqual([null, null, [], null]);
    expect(b.siblings.map((r: RunRowCore) => r.seed)).toEqual([3, 1]);
    expect(b.adjacent).toEqual({ previous: id.replace(NIGHT(2), NIGHT(1)), next: id.replace(NIGHT(2), NIGHT(3)) });
    expect('extra' in b).toBe(false);
  });

  it('routes whose source is missing answer 404, and the epoch route finds none', async () => {
    for (const [path, query] of [['/freeze/abcd1234', {}], ['/attribution', { surface: 'outreach' }], ['/commit/abcdef1', {}], ['/changes', {}], ['/bisects', {}], ['/bisect/x', {}]] as const) {
      const r = await handle(req('GET', path, query));
      expect([path, r.status, (r.body as { reason?: string }).reason]).toEqual([path, 404, 'not-found']);
    }
    expect((await handle(req('GET', '/epoch', { surface: 'outreach', n: '1' }))).body).toEqual({ error: 'outreach has no epoch 1 (it has 0)', reason: 'not-found' });
  });
});

describe('a product with every source', () => {
  // A new prompt on the fourth night: a second epoch.
  let rows = rowsFor('title', { model: 'm1' }).map((r) => (r.batch === NIGHT(3) ? { ...r, promptSha: 'p2' } : r));
  const settled: number[] = [];
  const reader: PromptReader = {
    files: () => ['prompt.md'],
    text: (runId) => (runId.includes(NIGHT(3)) ? 'v2' : 'v1'),
    size: () => 2,
  };
  const bisect: BisectSummary = { id: 'title-20261004-000000', surface: 'title', status: 'done', good: NIGHT(2), bad: NIGHT(3), startedAt: NIGHT(3), updatedAt: NIGHT(3), finishedAt: NIGHT(3), outcome: 'culprit', culprit: 'abcdef1', spentUsd: 1, budgetUsd: 5 };
  type SimLine = { at: string; surface: null; kind: 'sim-failure'; session: string };
  const src: EvalsSources<RunRowCore, QuerySurface & { sources: string[] }, SimLine> = {
    rows: async () => rows,
    surfaces: () => [{ id: 'title', title: 'Title', route: 'call', model: 'm1', sources: ['a.ts'] }],
    health: () => ({ root: '/repo', evalsHome: '/home', gitHead: 'abc', runsIndexed: 7, index: { state: 'warm', done: 7, total: 7 }, pid: 1, startedAt: NIGHT(0) }),
    info: (s) => ({ sources: s.sources, criteria: null }),
    prompts: reader,
    freezes: {
      counts: async () => (surface) => (surface === 'title' ? { public: 1, private: 1 } : { public: 0, private: 0 }),
      get: async (id, all) => (id.startsWith('fa01') ? ({ freeze: { id: 'fa01', surface: 'title' }, runs: all.filter((r) => r.freezeId === 'fa01') } as never) : null),
    },
    staleness: async () => (surface) => (surface === 'title' ? 'stale' : null),
    run: async () => ({ result: null, score: null, scoreVersions: [], rubric: null, sends: [], judge: null, logTail: 'tail', calls: [], extra: { mine: 1 } }) as never,
    pair: () => ({ diff: [], replies: { a: 'x', b: 'y' } }),
    flipExamples: async (_s, freezeIds) => freezeIds.map((freezeId) => ({ freezeId }) as never),
    git: {
      verify: (sha) => {
        if (sha !== 'abcdef1') throw new BadRequest(`no commit ${sha}`);
      },
      touching: () => [],
      between: () => [],
      commit: (sha) => ({ commit: { sha } }) as never,
      attribution: { resolve: () => null, isAncestor: () => false, path: () => [], changed: () => [], show: () => null },
      meta: { declaredPaths: () => [], surfaceInfo: () => ({ model: 'm1', route: 'call', sources: [] }), readHeads: () => null, freezeSnapshotPath: () => null },
    },
    bisects: { summaries: () => [bisect], settle: () => void settled.push(1), running: () => null, get: (id) => (id === bisect.id ? ({ state: {}, steps: [] } as never) : null) },
    changes: { sig: (r) => String(r.checks.k ?? ''), extra: (since) => ({ jobs: since > 0 ? [{ id: 'job' }] : [] }) },
    overview: () => ({ moved: [{ at: NIGHT(9), surface: null, kind: 'sim-failure', session: 's1' }], fields: { sim: { id: 's1' } } }),
  };
  const handle = createEvalsHandler(src, policy);

  it('fills every capability but liveness, and /health keeps the product facts beside them', async () => {
    expect(capabilitiesOf(src, policy)).toEqual({ trends: true, freezes: true, epochs: true, attribution: true, commits: true, bisect: true, changes: true, liveness: false, models: true, compare: true, marks: true });
    const { body } = await handle(req('GET', '/health'));
    expect(body).toMatchObject({ root: '/repo', runsIndexed: 7, capabilities: { bisect: true, liveness: false } });
  });

  it('the wall carries freezes, staleness, epochs, the bisect and the product own lines and fields', async () => {
    const { body } = await handle(req('GET', '/overview'));
    const o = body as Record<string, any>;
    expect(o.sim).toEqual({ id: 's1' });
    expect(o.surfaces[0]).toMatchObject({ freezes: { public: 1, private: 1 }, staleness: 'stale', route: 'call' });
    expect(o.surfaces[0].epochs.map((e: { n: number }) => e.n)).toEqual([1, 2]);
    expect(o.moved.map((m: { kind: string }) => m.kind)).toEqual(['sim-failure', 'epoch', 'flips', 'bisect']);
  });

  it('the surface header adds the product fields and freeze counts', async () => {
    const { body } = await handle(req('GET', '/surface/title'));
    expect((body as Record<string, unknown>).surface).toEqual({ id: 'title', title: 'Title', route: 'call', model: 'm1', freezes: { public: 1, private: 1 }, sources: ['a.ts'], criteria: null });
  });

  it('a run keeps the product detail and its extra', async () => {
    const { body } = await handle(req('GET', `/run/${encodeURIComponent(rows[0]!.id)}`));
    expect(body).toMatchObject({ logTail: 'tail', calls: [], extra: { mine: 1 } });
    expect(Object.keys(body as object).at(-1)).toBe('extra');
  });

  it('freezes add their epochs; an unknown one is 404 and a malformed id 400', async () => {
    expect(((await handle(req('GET', '/freeze/fa01'))).body as { epochs: unknown[] }).epochs).toHaveLength(2);
    expect((await handle(req('GET', '/freeze/0000aaaa'))).status).toBe(404);
    expect((await handle(req('GET', '/freeze/..%2Fetc'))).body).toEqual({ error: 'a freeze id is hex with dashes', reason: 'bad-request' });
  });

  it('attribution checks its endpoints through the product git', async () => {
    expect((await handle(req('GET', '/attribution', { surface: 'title', bad: 'abcdef9' }))).body).toEqual({ error: 'no commit abcdef9', reason: 'bad-request' });
    expect((await handle(req('GET', '/attribution', { surface: 'title', good: 'not a ref' }))).status).toBe(400);
  });

  it('/changes primes, then hands over the rows that changed, by the core signature or the product own, with its extras', async () => {
    settled.length = 0;
    const first = (await handle(req('GET', '/changes', { since: '0' }))).body as { cursor: number; runs: RunRowCore[]; jobs: unknown[] };
    expect(first.runs).toEqual([]);
    const [a, b] = [rows[0]!.id, rows[1]!.id];
    rows = rows.map((r) => (r.id === a ? { ...r, score: 0.1, status: 'fail' as const } : r.id === b ? { ...r, checks: { k: 1 } } : r));
    await new Promise((r) => setTimeout(r, 2));
    const next = (await handle(req('GET', '/changes', { since: String(first.cursor) }))).body as typeof first;
    expect(next.runs.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(next.jobs).toEqual([{ id: 'job' }]);
    expect(settled).toHaveLength(2);
  });

  it('checks requests and echoes a line protocol id', async () => {
    expect(await handle({ id: 7, method: 'GET', path: '/compare', query: { a: 'x' } })).toEqual({ id: 7, status: 400, body: { error: 'b is required', reason: 'bad-request' } });
    expect(await handle(req('GET', '/surface/nope'))).toEqual({ status: 404, body: { error: 'no surface nope', reason: 'not-found' } });
    expect((await handle(req('GET', '/surface/title', { from: 'yesterday' }))).body).toEqual({ error: 'from and to take ISO times', reason: 'bad-request' });
    expect(await handle({ id: 8, method: 'GET', path: '/sim/catalog', query: {} })).toEqual({ id: 8, status: 404, body: { error: 'no route GET /sim/catalog', reason: 'not-found' } });
    expect((await handle(req('POST', '/overview'))).status).toBe(404);
  });

  it('a handler keeps its own answers: two products over one rows array never share one', async () => {
    const strict = createEvalsHandler(src, { passed: () => false, ruler: () => null });
    // The latest verdict's flips read the policy: a policy that passes nothing sees nothing flip.
    const flipsOf = async (h: typeof handle) => ((await h(req('GET', '/overview'))).body as { surfaces: Array<{ latest: { flips: unknown[] } }> }).surfaces[0]!.latest.flips.length;
    expect([await flipsOf(handle), await flipsOf(strict), await flipsOf(handle)]).toEqual([1, 0, 1]);
  });
});

