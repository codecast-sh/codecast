import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRowProblems, type RunRow } from '@codecast/shared/contracts/evalsApi';

import { guardCounts, indexedRuns, refreshRunIndex, resetRunIndexMemory, runIndexPath } from './runIndex';

const PUB_FREEZE = 'aaaaaaaa-1111-4111-8111-111111111111';
const PRIV_FREEZE = 'bbbbbbbb-2222-4222-8222-222222222222';
const HEAD_MAIN = 'a'.repeat(40);
const HEAD_ORPHAN = 'b'.repeat(40);
const HEAD_TWIN = 'c'.repeat(40);

let home: string;
let pubDir: string;
const prevHome = process.env.CODECAST_EVALS_HOME;

const json = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 2));
const stamp = (iso: string) => iso.replace(/[:.]/g, '-');

interface Rep {
  surface: string;
  freeze: string;
  seed: number;
  at: string;
  batch?: string;
  gitHead?: string;
  route?: 'call' | 'agent';
  score?: { pass: boolean; score: number; gates?: Array<{ id: string; pass: boolean }>; checks?: Array<{ id: string; score: number }>; judgeCostUsd?: number } | null;
  costUsd?: number;
  events?: string[];
  extraScores?: string[];
  noRunJson?: boolean;
}

function writeRep(r: Rep): string {
  const name = `${r.surface}-${r.freeze.slice(0, 8)}-seed${r.seed}-${stamp(r.at)}`;
  const dir = join(home, 'runs', name);
  mkdirSync(dir, { recursive: true });
  if (!r.noRunJson)
    json(join(dir, 'run.json'), {
      freezeId: r.freeze,
      model: 'claude-haiku-4-5-20251001',
      route: r.route ?? 'call',
      sourceHash: 'src1',
      promptSha: 'p1',
      judgeModel: 'claude-sonnet-5-5',
      gitHead: r.gitHead ?? HEAD_MAIN,
      dirty: true,
      batch: r.batch ?? null,
      cadence: 'nightly',
      liveReads: 0,
      title: `${r.surface} moment`,
    });
  if (r.score !== null) {
    json(join(dir, 'result.json'), { scenario: `${r.surface}-${r.freeze.slice(0, 8)}`, seed: r.seed, title: `${r.surface} moment`, startedAt: r.at, endedBecause: 'done', realElapsedMs: 1200, costUsd: r.costUsd ?? 0.01 });
    const s = r.score ?? { pass: true, score: 0.8 };
    json(join(dir, 'score.json'), {
      pass: s.pass,
      score: s.score,
      passMark: 0.7,
      gates: (s.gates ?? []).map((g) => ({ ...g, decidedBy: 'mechanical', evidence: { summary: '' } })),
      checks: (s.checks ?? [{ id: 'criteria', score: s.score }]).map((c) => ({ ...c, ask: '', weight: 1, reasoning: null, must: null })),
      missedFloors: [],
      judgeCostUsd: s.judgeCostUsd ?? 0.004,
      judgeModel: 'claude-sonnet-5-5',
      title: `${r.surface} moment`,
    });
  }
  if (r.events) writeFileSync(join(dir, 'events.jsonl'), r.events.join('\n'));
  for (const f of r.extraScores ?? []) json(join(dir, f), {});
  return name;
}

const castCall = (argv: string) => JSON.stringify({ seq: 1, virtualAt: '', realAt: '', kind: 'cast_call', payload: { argv } });

function seedHome(): Record<string, string> {
  return {
    a: writeRep({ surface: 'call-summary', freeze: PUB_FREEZE, seed: 1, at: '2026-10-01T10:00:05.000Z', batch: 'b1', score: { pass: false, score: 0, gates: [{ id: 'parse', pass: false }, { id: 'ok', pass: true }], judgeCostUsd: 0.002 }, costUsd: 0.03 }),
    b: writeRep({ surface: 'call-summary', freeze: PUB_FREEZE, seed: 2, at: '2026-10-01T10:00:01.000Z', batch: 'b1', extraScores: ['score.before-rejudge.json', 'score.2026-10-02T00-00-00-000Z.json'] }),
    c: writeRep({ surface: 'role-wake', freeze: PRIV_FREEZE, seed: 1, at: '2026-10-02T09:00:00.000Z', batch: 'b2', route: 'agent', gitHead: HEAD_ORPHAN, events: [castCall('brief'), castCall('UNSERVED brief'), castCall('org --help'), castCall('HELP org --help'), castCall('SERVED sessions'), castCall('LIVE task ls'), castCall('REFUSED task done ct-1'), castCall('UNKNOWN frob'), JSON.stringify({ kind: 'run_finished', payload: {} })] }),
    d: writeRep({ surface: 'title', freeze: PRIV_FREEZE, seed: 1, at: '2026-10-03T08:00:00.000Z', gitHead: 'd'.repeat(40) }),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evals-index-'));
  pubDir = join(home, 'public-freezes');
  mkdirSync(pubDir, { recursive: true });
  mkdirSync(join(home, 'freezes'), { recursive: true });
  json(join(pubDir, `${PUB_FREEZE}.json`), { name: 'public one' });
  json(join(home, 'freezes', `${PRIV_FREEZE}.json`), { name: 'private one' });
  json(join(home, 'heads.json'), {
    updatedAt: '',
    mainLine: ['refs/heads/main'],
    heads: {
      [HEAD_MAIN]: { on: 'main', mainSha: HEAD_MAIN, how: 'self', pinned: true },
      [HEAD_ORPHAN]: { on: 'none', mainSha: HEAD_TWIN, how: 'patch-id', pinned: true },
    },
  });
  process.env.CODECAST_EVALS_HOME = home;
  resetRunIndexMemory();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));
afterAll(() => {
  if (prevHome === undefined) delete process.env.CODECAST_EVALS_HOME;
  else process.env.CODECAST_EVALS_HOME = prevHome;
});

const opts = () => ({ home, publicFreezes: pubDir });
const byId = (rows: RunRow[]) => new Map(rows.map((r) => [r.id, r]));

/** Every readFileSync the index makes while `fn` runs, from any module (the platform's summary included). */
async function readsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const spy = spyOn(fs, 'readFileSync');
  try {
    await fn();
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

describe('run index', () => {
  test('one contract-valid row per run folder, with every field read from the folder', async () => {
    const ids = seedHome();
    mkdirSync(join(home, 'runs', 'not-a-run'), { recursive: true });
    const rows = await indexedRuns(opts());
    expect(rows.map((r) => r.id)).toEqual([ids.d!, ids.c!, ids.a!, ids.b!]);
    for (const r of rows) expect(runRowProblems(r)).toEqual([]);
    const m = byId(rows);

    const a = m.get(ids.a!)!;
    expect(a.surface).toBe('call-summary');
    expect(a.freezeId).toBe(PUB_FREEZE);
    expect(a.freezeName).toBe('call-summary moment');
    expect(a.visibility).toBe('public');
    expect(a.status).toBe('fail');
    expect(a.gatesFailed).toEqual(['parse']);
    expect(a.checks).toEqual({ criteria: 0 });
    expect(a.passMark).toBe(0.7);
    expect(a.costUsd).toBe(0.03);
    expect(a.judgeCostUsd).toBe(0.002);
    expect(a.realMs).toBe(1200);
    expect(a.stamp).toBe('2026-10-01T10:00:05.000Z');
    expect(a.cadence).toBe('nightly');
    expect(a.dirty).toBe(true);
    expect(a.scoreVersions).toBe(1);
    expect(a.guard).toEqual({ served: 0, unserved: 0, live: 0, refused: 0, unknown: 0, help: 0 });

    // batchAt is the batch's earliest stamp, not the batch name or this rep's stamp.
    expect(a.batchAt).toBe('2026-10-01T10:00:01.000Z');
    expect(m.get(ids.b!)!.scoreVersions).toBe(3);

    const c = m.get(ids.c!)!;
    expect(c.visibility).toBe('private');
    expect(c.guard).toEqual({ served: 1, unserved: 1, live: 1, refused: 1, unknown: 1, help: 1 });
    expect(c.offBranch).toBe(true);
    expect(c.mainSha).toBe(HEAD_TWIN);
    expect(a.offBranch).toBe(false);
    expect(a.mainSha).toBe(HEAD_MAIN);

    // A head heads.json does not name has no twin yet, and the refresh says so.
    expect(m.get(ids.d!)!.mainSha).toBeNull();
    resetRunIndexMemory();
    expect((await refreshRunIndex(opts())).unmappedHeads).toEqual(['d'.repeat(40)]);
  });

  test('the file holds one RunRow per line, each with its rebuild key', async () => {
    seedHome();
    await refreshRunIndex(opts());
    const lines = fs.readFileSync(runIndexPath(home), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      const { key, ...row } = JSON.parse(l) as RunRow & { key: string };
      expect(key).toMatch(/^1\|/);
      expect(runRowProblems(row)).toEqual([]);
    }
  });

  test('a second refresh, in a fresh process, reads only the index and heads.json', async () => {
    seedHome();
    expect((await refreshRunIndex(opts())).rebuilt).toBe(4);
    resetRunIndexMemory();
    let r: Awaited<ReturnType<typeof refreshRunIndex>> | undefined;
    const reads = await readsDuring(async () => {
      r = await refreshRunIndex(opts());
    });
    expect(r!.rebuilt).toBe(0);
    expect(r!.wrote).toBe(false);
    expect(reads.sort()).toEqual([join(home, 'heads.json'), runIndexPath(home)].sort());
  });

  test('touching one score.json reads only that folder again', async () => {
    const ids = seedHome();
    await refreshRunIndex(opts());
    const scorePath = join(home, 'runs', ids.b!, 'score.json');
    json(scorePath, { ...JSON.parse(fs.readFileSync(scorePath, 'utf8')), score: 0.1, pass: false });
    const later = new Date(Date.now() + 5000);
    utimesSync(scorePath, later, later);
    let r: Awaited<ReturnType<typeof refreshRunIndex>> | undefined;
    const reads = await readsDuring(async () => {
      r = await refreshRunIndex(opts());
    });
    expect(r!.rebuilt).toBe(1);
    expect(r!.wrote).toBe(true);
    const outside = reads.filter((p) => !p.startsWith(join(home, 'runs', ids.b!)) && p !== join(home, 'heads.json'));
    expect(outside).toEqual([]);
    const row = byId(await indexedRuns({ ...opts(), maxAgeMs: 60_000 })).get(ids.b!)!;
    expect(row.score).toBe(0.1);
    expect(row.status).toBe('fail');
  });

  test('a remapped head moves rows nobody read again', async () => {
    const ids = seedHome();
    await refreshRunIndex(opts());
    const heads = JSON.parse(fs.readFileSync(join(home, 'heads.json'), 'utf8'));
    heads.heads['d'.repeat(40)] = { on: 'none', mainSha: null, how: null, reason: 'never landed', pinned: true };
    json(join(home, 'heads.json'), heads);
    const r = await refreshRunIndex(opts());
    expect(r.rebuilt).toBe(0);
    expect(r.wrote).toBe(true);
    expect(r.unmappedHeads).toEqual([]);
    const d = byId(await indexedRuns({ ...opts(), maxAgeMs: 60_000 })).get(ids.d!)!;
    expect(d.offBranch).toBe(true);
    expect(d.mainSha).toBeNull();
  });

  test('a deleted folder drops its row; a torn line is read again', async () => {
    const ids = seedHome();
    await refreshRunIndex(opts());
    rmSync(join(home, 'runs', ids.a!), { recursive: true });
    const r = await refreshRunIndex(opts());
    expect(r.removed).toBe(1);
    expect(r.rows).toBe(3);

    fs.appendFileSync(runIndexPath(home), '{"id": "torn');
    const lines = fs.readFileSync(runIndexPath(home), 'utf8').split('\n');
    fs.writeFileSync(runIndexPath(home), lines.map((l) => (l.includes(ids.c!) ? l.replace('"surface":"role-wake"', '"surface":7') : l)).join('\n'));
    resetRunIndexMemory();
    const again = await refreshRunIndex(opts());
    expect(again.rebuilt).toBe(1);
    expect(again.rows).toBe(3);
  });

  test('a surface refresh checks only that surface, and a hyphenated id is not a prefix match', async () => {
    seedHome();
    writeRep({ surface: 'changes-story', freeze: PRIV_FREEZE, seed: 1, at: '2026-10-02T00:00:00.000Z' });
    const r = await refreshRunIndex({ ...opts(), surface: 'call-summary' });
    expect(r.scanned).toBe(2);
    expect(r.rebuilt).toBe(2);
    const rows = await indexedRuns({ ...opts(), surface: 'changes-story' });
    expect(rows.map((x) => x.surface)).toEqual(['changes-story']);
  });

  test('a rep still being written reads as unscored and is read again until it lands; an abandoned one is a crash', async () => {
    const live = writeRep({ surface: 'title', freeze: PRIV_FREEZE, seed: 2, at: '2026-10-03T09:00:00.000Z', score: null });
    const dead = writeRep({ surface: 'title', freeze: PRIV_FREEZE, seed: 3, at: '2026-10-03T07:00:00.000Z', score: null, noRunJson: true });
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(join(home, 'runs', dead), old, old);
    const m = byId(await indexedRuns(opts()));
    expect(m.get(live)!.status).toBe('unscored');
    expect(m.get(dead)!.status).toBe('crash');
    // No run.json: the freeze id comes from the folder name, matched to a freeze home.
    expect(m.get(dead)!.freezeId).toBe(PRIV_FREEZE);
    const r = await refreshRunIndex(opts());
    expect(r.rebuilt).toBe(1);
  });

  test('maxAgeMs skips a refresh younger than it', async () => {
    seedHome();
    await refreshRunIndex(opts());
    writeRep({ surface: 'title', freeze: PRIV_FREEZE, seed: 9, at: '2026-10-03T10:00:00.000Z' });
    expect((await refreshRunIndex({ ...opts(), maxAgeMs: 60_000 })).cached).toBe(true);
    expect((await refreshRunIndex(opts())).rebuilt).toBe(1);
  });

  test('concurrent refreshes share one pass', async () => {
    seedHome();
    const [x, y] = await Promise.all([refreshRunIndex(opts()), refreshRunIndex(opts())]);
    expect(x.rebuilt + y.rebuilt).toBe(4);
  });
});

describe('surfaceRuns through the index', () => {
  test('every rep of the surface, newest first, with what it ran on and the platform summary costs', async () => {
    const ids = seedHome();
    const { surfaceRuns } = await import('../adapters/runs');
    const runs = await surfaceRuns('call-summary');
    expect(runs.map((r) => r.id)).toEqual([ids.a!, ids.b!]);
    const a = runs[0]!;
    expect(a.scenario).toBe(`call-summary-${PUB_FREEZE.slice(0, 8)}`);
    expect(a.costUsd).toBeCloseTo(0.032, 10);
    expect(a.batch).toBe('b1');
    expect(a.gitHead).toBe(HEAD_MAIN);
    expect(a.promptSha).toBe('p1');
    expect(a.judgeModel).toBe('claude-sonnet-5-5');
    expect(await surfaceRuns('call-summary', { limit: 1 })).toHaveLength(1);
    expect(await surfaceRuns('role-wake', { freezeId: PRIV_FREEZE.slice(0, 8) })).toHaveLength(1);
  });
});

test('guardCounts reads only marked cast_call lines', () => {
  expect(guardCounts([castCall('UNSERVED brief'), castCall('UNSERVEDX'), castCall('LIVE'), JSON.stringify({ kind: 'send_captured', payload: { argv: 'SERVED x' } }), 'garbage "cast_call"'].join('\n'))).toEqual({ served: 0, unserved: 1, live: 1, refused: 0, unknown: 0, help: 0 });
});
