import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRowProblems, type CommitRef, type RunRow } from '@codecast/shared/contracts/evalsApi';

import { batchVerdict, BISECT_CADENCE, upTo, verdictLinesOf } from '../commands/verdict';
import { separate } from '../stats';
import type { HeadsFile } from '../provenance';
import { attribute, type AttributionGit, type AttributionInput } from './attribution';
import { epochPromptDiffs, epochsOf, footingMarkers, type PromptReader } from './epochs';
import { flipsBetween } from './flips';

// The analysis library on synthetic records: the verdict `check` prints, the
// flips between batches, prompt epochs, and Tier 0 attribution. Nothing here
// reads EVALS_HOME: every rep carries its ruler, and git and the prompt files
// are fakes.

let home: string;
const prevHome = process.env.CODECAST_EVALS_HOME;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'evals-analysis-'));
  process.env.CODECAST_EVALS_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.CODECAST_EVALS_HOME;
  else process.env.CODECAST_EVALS_HOME = prevHome;
});

const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

// ── The verdict check prints ────────────────────────────────────────────────

const F = { a: 'aaaaaaaa-0000-4000-8000-000000000001', b: 'bbbbbbbb-0000-4000-8000-000000000002', c: 'cccccccc-0000-4000-8000-000000000003', d: 'dddddddd-0000-4000-8000-000000000004' };
type Status = 'pass' | 'fail' | 'crash' | 'dry' | 'unscored';
interface Rep { id: string; scenario: string; title: string; seed: number; startedAt: string; createdAt: string; status: Status; score: number | null; gatesFailed: string[]; missedFloors: string[]; sends: number; costUsd: number; realMs: number; virtualMs: number; freezeId: string; model: string; batch: string; cadence: string | null; liveReads: number; ruler: string | null }
const rep = (batch: string, freezeId: string, seed: number, o: Partial<Rep> = {}): Rep => {
  const status = o.status ?? ((o.score ?? 0.9) >= 0.7 ? 'pass' : 'fail');
  return { id: `demo-${freezeId.slice(0, 8)}-seed${seed}-${batch}`, scenario: `demo-${freezeId.slice(0, 8)}`, title: 'demo', seed, startedAt: batch, createdAt: batch, status, score: status === 'crash' ? null : 0.9, gatesFailed: [], missedFloors: [], sends: 1, costUsd: 0.01, realMs: 1, virtualMs: 1, freezeId, model: 'm1', batch, cadence: null, liveReads: 0, ruler: 'r1', ...o };
};
const seeds = (batch: string, freezeId: string, n: number, o: (i: number) => Partial<Rep> = () => ({})) => Array.from({ length: n }, (_, i) => rep(batch, freezeId, i + 1, o(i)));

/** Newest first, the way surfaceRuns lists them: every branch of the verdict lines. */
function verdictHistory(): Rep[] {
  const h: Rep[] = [
    // 01: the oldest plain batch, every freeze passing.
    ...seeds('2026-09-01T00:00:00.000Z', F.a, 5), ...seeds('2026-09-01T00:00:00.000Z', F.b, 5), ...seeds('2026-09-01T00:00:00.000Z', F.c, 5, () => ({ score: 0.8 })),
    // 02: a on another model, b judged on another ruler.
    ...seeds('2026-09-02T00:00:00.000Z', F.a, 5, () => ({ model: 'm2' })), ...seeds('2026-09-02T00:00:00.000Z', F.b, 5, () => ({ ruler: 'r2' })),
    // 03: a breaks, a crash and a failed gate on b, live reads on c, and d is new.
    ...seeds('2026-09-03T00:00:00.000Z', F.a, 5, () => ({ score: 0.2 })),
    ...seeds('2026-09-03T00:00:00.000Z', F.b, 5, (i) => (i === 0 ? { status: 'crash' } : i === 1 ? { score: 0, gatesFailed: ['no-leak'] } : {})),
    ...seeds('2026-09-03T00:00:00.000Z', F.c, 5, (i) => (i < 2 ? { liveReads: 3 } : {})),
    ...seeds('2026-09-03T00:00:00.000Z', F.d, 2),
    // A resumed seed: the newer rep stands for seed 1 of a.
    rep('2026-09-03T00:00:00.000Z', F.a, 1, { score: 0.1, id: 'demo-older-dup' }),
    // dry: canned output only.
    ...seeds('2026-09-04T00:00:00.000Z', F.a, 3, () => ({ status: 'dry', score: null })),
    // Nightly: four nights, the last against its pool.
    ...['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'].flatMap((d, n) => [...seeds(`${d}T00:00:00.000Z`, F.a, 3, () => ({ cadence: 'nightly', score: n === 3 ? 0.75 : 0.95 })), ...seeds(`${d}T00:00:00.000Z`, F.b, 3, () => ({ cadence: 'nightly' }))]),
    // A single rep on a new model, against 01 with a judge change on b.
    ...seeds('2026-09-09T00:00:00.000Z', F.a, 1, () => ({ model: 'm3' })), ...seeds('2026-09-09T00:00:00.000Z', F.b, 1, () => ({ ruler: 'r9' })),
  ];
  return h.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
}

// Captured from the verdict lines `check` printed before batchVerdict existed; the real-history replay of the same check found every one of 515 recorded batches byte-identical.
// The nightly cases since read night by night per freeze (separateNights): two freezes over at most three nights cannot separate, so they print too-few.
const VERDICT_SNAPSHOT: Array<{ batch: string; against?: string; baselineBatches?: number; lines: string[]; regression: boolean }> = [
  {
    batch: '2026-09-01T00:00:00.000Z',
    lines: [
      'demo  pass 15/15 (100%)  mean 0.87  0.80-0.90  flips 0  $0.150  m1',
      '  not separated: medians 0.90 vs 0.90, ranges 0.80-0.90 vs 0.75-0.90',
      '  passed over 2026-09-09T00:00:00.000Z: another model on the same freezes',
      "  passed over 2026-09-09T00:00:00.000Z: graded on another ruler (judge or write guard); ./evals rescore --batch <it> --rejudge brings it onto today's (a guard alone needs no --rejudge)",
    ],
    regression: false,
  },
  {
    batch: '2026-09-03T00:00:00.000Z',
    lines: [
      'demo  pass 10/16 (63%)  mean 0.63  0.00-0.90  flips 1  $0.170  m1',
      '  not separated: medians 0.90 vs 0.80, ranges 0.00-0.90 vs 0.75-0.90 (over the 3 freeze(s) the previous set ran)',
      '  passed over 2026-09-09T00:00:00.000Z: another model on the same freezes',
      "  passed over 2026-09-09T00:00:00.000Z: graded on another ruler (judge or write guard); ./evals rescore --batch <it> --rejudge brings it onto today's (a guard alone needs no --rejudge)",
      '  gates failed: no-leak',
      '  live reads: 2/16 reps read the live workspace (6 reads; ./evals runs show <run> lists them)',
      '  1 crashed, left out of the numbers above: ./evals runs list --scenario demo- --status crash; ./evals check demo --batch 2026-09-03T00:00:00.000Z with the same --reps and --freeze runs them again',
    ],
    regression: false,
  },
  { batch: '2026-09-04T00:00:00.000Z', lines: ['demo  dry: 3 rep(s) ran through the wiring on canned output; nothing is graded or compared'], regression: false },
  {
    batch: '2026-09-05T00:00:00.000Z',
    lines: ['demo  pass 6/6 (100%)  mean 0.92  0.90-0.95  flips 0  $0.060  m1', '  against the last 3 nightly batches night by night (2026-09-06T00:00:00.000Z to 2026-09-08T00:00:00.000Z, 18 reps): too few nights and freezes to separate (each freeze counts once a night; one freeze alone needs 19 earlier nights)'],
    regression: false,
  },
  {
    batch: '2026-09-06T00:00:00.000Z',
    lines: ['demo  pass 6/6 (100%)  mean 0.92  0.90-0.95  flips 0  $0.060  m1', '  against the last 3 nightly batches night by night (2026-09-05T00:00:00.000Z to 2026-09-08T00:00:00.000Z, 18 reps): too few nights and freezes to separate (each freeze counts once a night; one freeze alone needs 19 earlier nights)'],
    regression: false,
  },
  {
    batch: '2026-09-08T00:00:00.000Z',
    lines: ['demo  pass 6/6 (100%)  mean 0.83  0.75-0.90  flips 0  $0.060  m1', '  against the last 3 nightly batches night by night (2026-09-05T00:00:00.000Z to 2026-09-07T00:00:00.000Z, 18 reps): too few nights and freezes to separate (each freeze counts once a night; one freeze alone needs 19 earlier nights)'],
    regression: false,
  },
  {
    batch: '2026-09-08T00:00:00.000Z',
    baselineBatches: 1,
    lines: ['demo  pass 6/6 (100%)  mean 0.83  0.75-0.90  flips 0  $0.060  m1', '  against the last nightly batch (2026-09-07T00:00:00.000Z, 6 reps): too few nights and freezes to separate (each freeze counts once a night; one freeze alone needs 19 earlier nights)'],
    regression: false,
  },
  {
    batch: '2026-09-09T00:00:00.000Z',
    against: '2026-09-01T00:00:00.000Z',
    lines: [
      'demo  pass 2/2 (100%)  mean 0.90  0.90-0.90  flips 0  $0.020  m3,m1',
      '  against 2026-09-01T00:00:00.000Z: too few samples to separate (need 5+ per side)',
      '  another model: aaaaaaaa (m1 then, m3 now): the comparison weighs the model as well as the prompt',
      "  another judge: bbbbbbbb graded on a different judge prompt, criterion or write guard: ./evals rescore --batch 2026-09-01T00:00:00.000Z --rejudge puts the baseline on today's (a guard alone needs no --rejudge)",
    ],
    regression: false,
  },
  {
    batch: '2026-09-03T00:00:00.000Z',
    against: '2026-09-02T00:00:00.000Z',
    lines: [
      'demo  pass 10/16 (63%)  mean 0.63  0.00-0.90  flips 1  $0.170  m1',
      '  against 2026-09-02T00:00:00.000Z: separated: worse (p=0.0031) (over the 2 freeze(s) the previous set ran)',
      '  another model: aaaaaaaa (m2 then, m1 now): the comparison weighs the model as well as the prompt',
      "  another judge: bbbbbbbb graded on a different judge prompt, criterion or write guard: ./evals rescore --batch 2026-09-02T00:00:00.000Z --rejudge puts the baseline on today's (a guard alone needs no --rejudge)",
      '  gates failed: no-leak',
      '  live reads: 2/16 reps read the live workspace (6 reads; ./evals runs show <run> lists them)',
      '  1 crashed, left out of the numbers above: ./evals runs list --scenario demo- --status crash; ./evals check demo --batch 2026-09-03T00:00:00.000Z with the same --reps and --freeze runs them again',
    ],
    regression: true,
  },
  { batch: '2026-09-30T00:00:00.000Z', lines: ['demo  pass 0/0 (0%)  mean 0.00  -  flips -  $0.00  ', '  no previous run set to compare with'], regression: false },
];

describe('batchVerdict: the verdict check prints, as one value', () => {
  const meta = { id: 'demo', model: 'm1' };
  const history = verdictHistory();

  test('prints exactly the lines check printed before the split, case by case', () => {
    for (const c of VERDICT_SNAPSHOT) {
      const v = batchVerdict(meta, c.batch, history, { against: c.against, baselineBatches: c.baselineBatches });
      expect({ batch: c.batch, against: c.against, lines: plain(verdictLinesOf(v)), regression: v.regression }).toEqual({ batch: c.batch, against: c.against, lines: c.lines, regression: c.regression });
    }
  });

  test('carries the flips by run id, the baseline it chose, and the set the strip shows', () => {
    const v = batchVerdict(meta, '2026-09-03T00:00:00.000Z', history, { against: '2026-09-01T00:00:00.000Z' });
    expect(v.flips).toEqual([{ freezeId: F.a, name: F.a, visibility: 'private', direction: 'broke', before: [1, 2, 3, 4, 5].map((s) => `demo-aaaaaaaa-seed${s}-2026-09-01T00:00:00.000Z`), after: [1, 2, 3, 4, 5].map((s) => `demo-aaaaaaaa-seed${s}-2026-09-03T00:00:00.000Z`) }]);
    expect(v.baseline).toEqual({ kind: 'against', batches: ['2026-09-01T00:00:00.000Z'], reps: 15, cadence: null, skipped: [] });
    expect(v.set).toMatchObject({ reps: 16, passed: 10, crashes: 1, freezes: 4, min: 0, max: 0.9, liveReads: { reps: 2, reads: 6 }, footing: { model: 'm1', ruler: 'r1' } });
    expect(v.set.passRate).toBeCloseTo(10 / 16);
    expect(batchVerdict(meta, '2026-09-08T00:00:00.000Z', history).baseline).toMatchObject({ kind: 'pooled', cadence: 'nightly', batches: ['2026-09-05T00:00:00.000Z', '2026-09-06T00:00:00.000Z', '2026-09-07T00:00:00.000Z'], reps: 18 });
    expect(batchVerdict(meta, '2026-09-04T00:00:00.000Z', history)).toMatchObject({ dry: true, baseline: null, flips: [] });
  });

  test('earlierOnly weighs an old batch only against batches before it', () => {
    expect(upTo(history, '2026-09-05T00:00:00.000Z').every((r) => r.batch <= '2026-09-05T00:00:00.000Z')).toBe(true);
    const v = batchVerdict(meta, '2026-09-05T00:00:00.000Z', history, { earlierOnly: true });
    expect(v.baseline).toMatchObject({ kind: 'pooled', batches: [], reps: 0 });
    expect(plain(verdictLinesOf(v))[1]).toBe('  nightly: building its baseline: no previous run set to compare with');
  });
});

describe('batchVerdict: a cadence batch night by night, and bisect probes never a baseline', () => {
  const meta = { id: 'demo', model: 'm1' };
  const nightOf = (n: number) => `2026-09-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`;
  const newestFirst = (h: Rep[]) => h.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  const night = (n: number, scores: Partial<Record<keyof typeof F, number>>, reps = 5) => Object.entries(scores).flatMap(([f, score]) => seeds(nightOf(n), F[f as keyof typeof F], reps, () => ({ cadence: 'nightly', score })));

  test('a change in which freezes ran is no drift when no freeze moved', () => {
    // a scores 0.9 every night; b scores 0.6 every time it runs, but joined the cadence only on the last pooled night. Tonight repeats both.
    const history = newestFirst([...[0, 1, 2, 3, 4, 5].flatMap((n) => night(n, { a: 0.9 })), ...night(6, { a: 0.9, b: 0.6 }), ...night(7, { a: 0.9, b: 0.6 })]);
    const v = batchVerdict(meta, nightOf(7), history);
    expect(v.baseline).toMatchObject({ kind: 'pooled', reps: 40 });
    // Every rep pooled flat weighs a seven times over b, and reads the mix as a fall.
    expect(separate(v.compared.current, v.compared.previous).kind).toBe('worse');
    expect(v.separation.kind).not.toBe('worse');
    expect(v.regression).toBe(false);
  });

  test('a fall several freezes show tonight separates, however many reps each ran', () => {
    const steady = { a: 0.9, b: 0.8, c: 0.95, d: 0.85 };
    const history = newestFirst([...[0, 1, 2, 3, 4, 5, 6].flatMap((n) => night(n, steady, n % 2 ? 3 : 5)), ...night(7, { a: 0.5, b: 0.4, c: 0.6, d: 0.5 }, 3)]);
    const v = batchVerdict(meta, nightOf(7), history);
    expect(v.separation).toMatchObject({ kind: 'worse' });
    expect(v.regression).toBe(true);
    expect(plain(verdictLinesOf(v))[1]).toMatch(/^ {2}against the last 7 nightly batches night by night \(.+\): separated: worse \(p=0\.0002\)$/);
  });

  test('a bisect probe is never the baseline a later check is weighed against, and a probe is weighed against real runs only', () => {
    const plainBatch = (batch: string, score: number) => [...seeds(batch, F.a, 5, () => ({ score })), ...seeds(batch, F.b, 5, () => ({ score }))];
    const probe = (batch: string, score: number) => [...seeds(batch, F.a, 5, () => ({ score, cadence: BISECT_CADENCE })), ...seeds(batch, F.b, 5, () => ({ score, cadence: BISECT_CADENCE }))];
    const history = newestFirst([...plainBatch('2026-09-20T00:00:00.000Z', 0.9), ...probe('2026-09-21T00:00:00.000Z', 0.2), ...probe('2026-09-22T00:00:00.000Z', 0.3), ...plainBatch('2026-09-23T00:00:00.000Z', 0.9)]);
    const v = batchVerdict(meta, '2026-09-23T00:00:00.000Z', history);
    expect(v.baseline).toMatchObject({ kind: 'previous', batches: ['2026-09-20T00:00:00.000Z'] });
    expect(v.regression).toBe(false);
    // A probe, weighed as the history views weigh an older batch: against the real batch before it, never the other probe.
    const p = batchVerdict(meta, '2026-09-22T00:00:00.000Z', history, { earlierOnly: true });
    expect(p.baseline).toMatchObject({ kind: 'previous', batches: ['2026-09-20T00:00:00.000Z'], cadence: null });
  });
});

// ── Index rows, for flips, epochs and attribution ──────────────────────────

const C = (i: number): string => String(i).repeat(40);
const ORPHAN = 'e'.repeat(40);
const A = 'a1a1a1a1-0000-4000-8000-00000000000a';
const B = 'b2b2b2b2-0000-4000-8000-00000000000b';
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T00:00:00.000Z`;

/** One index row: passing on m1 under ruler r1 at commit C(0), unless told otherwise. */
function row(batch: string, at: string, freezeId: string, seed: number, o: Partial<RunRow> = {}): RunRow {
  const score = o.score === undefined ? 0.9 : o.score;
  return {
    id: `demo-${freezeId.slice(0, 8)}-seed${seed}-${batch}`, surface: 'demo', freezeId, freezeName: `demo ${freezeId.slice(0, 4)}`, visibility: 'private', seed, stamp: at, batch, batchAt: at, cadence: null,
    status: score !== null && score >= 0.7 ? 'pass' : 'fail', score, passMark: 0.7, gatesFailed: [], checks: {}, missedFloors: [], model: 'm1', judgeModel: 'j1', ruler: 'r1',
    gitHead: C(0), mainSha: C(0), dirty: false, offBranch: false, treePatch: null, sourceHash: null, sourceHashDisk: null, promptSha: 'p1', freezeSha: null, liveReads: 0,
    costUsd: 0.01, judgeCostUsd: 0.001, realMs: 1, guard: { served: 0, unserved: 0, live: 0, refused: 0, unknown: 0, help: 0 }, scoreVersions: 1, ...o,
  };
}

/** A batch: `reps` seeds on each freeze, with per-freeze overrides. */
const batchOf = (batch: string, at: string, by: Record<string, Partial<RunRow>>, reps = 3): RunRow[] => Object.entries(by).flatMap(([f, o]) => Array.from({ length: reps }, (_, i) => row(batch, at, f, i + 1, o)));

describe('flipsBetween', () => {
  test('lists the freezes whose majority moved, by run id', () => {
    const rows = [...batchOf('g', day(1), { [A]: {}, [B]: {} }), ...batchOf('b', day(2), { [A]: { score: 0.1 }, [B]: {} })];
    const r = flipsBetween(rows, 'g', 'b');
    expect(r.ok && r.flips.map((f) => [f.freezeId, f.name, f.direction, f.after.length])).toEqual([[A, 'demo a1a1', 'broke', 3]]);
  });

  test("leads each side with a rep that agrees with its side's verdict", () => {
    // Real title jx7btyt:100 on 2026-10-04: two of three reps failed, and seed 1 (listed first) passed.
    const good = batchOf('g', day(1), { [A]: {} }).map((r) => (r.seed === 1 ? { ...r, score: 0.2, status: 'fail' as const } : r));
    const bad = batchOf('b', day(2), { [A]: { score: 0.1, status: 'fail' } }).map((r) => (r.seed === 1 ? { ...r, score: 0.7, status: 'pass' as const } : r));
    const r = flipsBetween([...good, ...bad], 'g', 'b');
    if (!r.ok) throw new Error(r.reason);
    const [f] = r.flips;
    expect(f.direction).toBe('broke');
    expect(f.after).toHaveLength(3);
    expect(f.before).toHaveLength(3);
    expect(bad.find((x) => x.id === f.after[0])!.status).toBe('fail');
    expect(good.find((x) => x.id === f.before[0])!.status).toBe('pass');
  });

  test('refuses across a model or a judge ruler, and on a batch that graded nothing', () => {
    const g = batchOf('g', day(1), { [A]: {} });
    expect(flipsBetween([...g, ...batchOf('b', day(2), { [A]: { model: 'm2', score: 0.1 } })], 'g', 'b')).toEqual({ ok: false, reason: 'another model: m1 in g, m2 in b', a: { model: 'm1', ruler: 'r1' }, b: { model: 'm2', ruler: 'r1' } });
    expect(flipsBetween([...g, ...batchOf('b', day(2), { [A]: { ruler: 'r2' } })], 'g', 'b')).toMatchObject({ ok: false, reason: 'another judge ruler: r1 in g, r2 in b' });
    expect(flipsBetween([...g, ...batchOf('b', day(2), { [A]: { status: 'dry', score: null } })], 'g', 'b')).toMatchObject({ ok: false, reason: 'b graded nothing (every rep was dry, crashed or unscored)' });
  });
});

// ── Epochs ──────────────────────────────────────────────────────────────────

/** Prompt files by run id. */
const fakeReader = (files: Record<string, Record<string, string>>): PromptReader => ({
  files: (id) => Object.keys(files[id] ?? {}).sort(),
  text: (id, f) => files[id]?.[f] ?? null,
  size: (id, f) => files[id]?.[f]?.length ?? null,
});

describe('epochs', () => {
  test('a new epoch begins where any freeze renders differently from its previous appearance; bisect probes are left out', () => {
    const rows = [
      ...batchOf('b1', day(1), { [A]: { promptSha: 'a1' }, [B]: { promptSha: 'b1' } }),
      ...batchOf('b2', day(2), { [A]: { promptSha: 'a1', gitHead: C(2) } }),
      ...batchOf('b3', day(3), { [B]: { promptSha: 'b2', gitHead: C(3) } }),
      ...batchOf('probe~33333333', day(4), { [A]: { promptSha: 'a0', cadence: 'bisect' } }),
      ...batchOf('b4', day(5), { [A]: { promptSha: 'a1' }, [B]: { promptSha: 'b2' } }),
      ...batchOf('b5', day(6), { [A]: { promptSha: 'a2', gitHead: C(5), status: 'dry', score: null } }),
    ];
    const e = epochsOf(rows, 'demo', fakeReader({}));
    expect(e.map((x) => [x.n, x.firstBatch, x.lastBatch, x.gitHead, x.changedFreezes, x.scope])).toEqual([
      [1, 'b1', 'b2', C(0), [A, B], 'rendered'],
      [2, 'b3', 'b4', C(3), [B], 'rendered'],
      [3, 'b5', 'b5', C(5), [A], 'rendered'],
    ]);
  });

  test('a freeze whose later call quotes an earlier reply keys on the prompt files that held still', () => {
    const files: Record<string, Record<string, string>> = {};
    const rows = (['b1', 'b2', 'b3'] as const).flatMap((batch, n) =>
      [1, 2, 3].map((seed) => {
        const r = row(batch, day(n + 1), A, seed, { promptSha: `${batch}-${seed}` });
        files[r.id] = { 'call1/system.md': n === 2 ? 'SYSTEM v2' : 'SYSTEM v1', 'call1/prompt.md': 'moment', 'call2/prompt.md': `excerpts chosen by reply ${seed}${batch}` };
        return r;
      }),
    );
    const reader = fakeReader(files);
    expect(epochsOf(rows, 'demo', reader).map((e) => e.firstBatch)).toEqual(['b1', 'b3']);
    const diff = epochPromptDiffs(rows, 'demo', 2, reader);
    expect(diff.map((p) => [p.file, p.a.runId, p.a.text, p.b.text])).toEqual([
      ['call1/system.md', 'demo-a1a1a1a1-seed3-b2', 'SYSTEM v1', 'SYSTEM v2'],
      ['call2/prompt.md', 'demo-a1a1a1a1-seed3-b2', 'excerpts chosen by reply 3b2', 'excerpts chosen by reply 1b3'],
    ]);
    expect(epochPromptDiffs(rows, 'demo', 1, reader)).toEqual([]);
  });

  test("org-review's promptSha covers its analyzer prompt only: it keys on each batch's most common sha", () => {
    const rows = [
      ...batchOf('b1', day(1), { [A]: { promptSha: 'x' } }).map((r) => ({ ...r, surface: 'org-review' })),
      ...[row('b2', day(2), A, 1, { promptSha: 'y' }), row('b2', day(2), A, 2, { promptSha: 'y' }), row('b2', day(2), A, 3, { promptSha: 'x' })].map((r) => ({ ...r, surface: 'org-review' })),
    ];
    const e = epochsOf(rows, 'org-review', fakeReader({}));
    expect(e.map((x) => [x.firstBatch, x.scope])).toEqual([['b1', 'analyzer-only'], ['b2', 'analyzer-only']]);
  });

  test('footing markers name where the model or the ruler moved', () => {
    const rows = [...batchOf('b1', day(1), { [A]: {} }), ...batchOf('b2', day(2), { [A]: { model: 'm2' } }), ...batchOf('b3', day(3), { [A]: { model: 'm2', ruler: 'r2' } })];
    expect(footingMarkers(rows)).toEqual([
      { batch: 'b2', batchAt: day(2), kind: 'model', from: 'm1', to: 'm2' },
      { batch: 'b3', batchAt: day(3), kind: 'judge', from: 'r1', to: 'r2' },
    ]);
  });
});

// ── Attribution (Tier 0) ────────────────────────────────────────────────────

/** A linear main line C(0)..C(6); the declared sources move at `touching`. */
function fakeGit(touching = [2, 4, 5], o: { changed?: string[] } = {}): AttributionGit {
  const line = [0, 1, 2, 3, 4, 5, 6].map(C);
  const ref = (sha: string): CommitRef => ({ sha, subject: `commit ${sha[0]}`, author: 'dev', at: day(1), session: sha === C(5) ? 'jx7abcd' : null, mainSha: sha, onMain: true });
  const at = (sha: string) => line.indexOf(sha);
  return {
    resolve: (name) => [...line, ORPHAN].find((s) => s.startsWith(name)) ?? null,
    isAncestor: (a, b) => at(a) >= 0 && at(a) <= at(b),
    path: (g, b, paths) => line.slice(at(g) + 1, at(b) + 1).filter((s) => paths === null || touching.includes(at(s))).map(ref),
    changed: () => o.changed ?? [],
    show: () => null,
  };
}

/**
 * The world: freeze A passes at good (C0) and fails at bad (C6); B passes
 * throughout. Recorded batches sit inside the range: r1 at C3 good, r3 at C4
 * good, r2 at C5 bad.
 */
function world(o: { bad?: Partial<RunRow>; good?: Partial<RunRow>; recorded?: boolean; extra?: RunRow[] } = {}): RunRow[] {
  return [
    ...batchOf('good', day(1), { [A]: { ...o.good }, [B]: { ...o.good } }),
    ...(o.recorded === false
      ? []
      : [
          ...batchOf('r1', day(2), { [A]: { gitHead: C(3), mainSha: C(3) } }),
          ...batchOf('r3', day(3), { [A]: { gitHead: C(4), mainSha: C(4) } }),
          ...batchOf('r2', day(4), { [A]: { gitHead: C(5), mainSha: C(5), score: 0.2 } }),
        ]),
    ...batchOf('bad', day(5), { [A]: { gitHead: C(6), mainSha: C(6), score: 0.2, ...o.bad }, [B]: { gitHead: C(6), mainSha: C(6), ...o.bad, score: 0.9 } }),
    ...(o.extra ?? []),
  ];
}

const run = (rows: RunRow[], o: Partial<AttributionInput> = {}) => attribute({ surface: 'demo', rows, good: 'good', bad: 'bad', git: fakeGit(), heads: null, reader: fakeReader({}), ...o });
const commits = (a: ReturnType<typeof attribute>) => (a.answer.kind === 'source' ? a.answer.candidates.map((c) => (c.kind === 'commit' ? c.commit.sha[0] : `patch:${c.treePatch}`)) : null);

describe('attribution: the first class that differs is the answer', () => {
  test('every fixture row is a valid index row', () => {
    for (const r of world()) expect(runRowProblems(r)).toEqual([]);
  });

  test('footing: the model moved', () => {
    const a = run(world({ bad: { model: 'm2' } }));
    expect(a.answer).toEqual({ kind: 'footing', change: 'model', from: 'm1', to: 'm2' });
    expect(a.checklist.map((c) => [c.class, c.differs])).toEqual([['footing', true], ['freeze', false], ['live-reads', false], ['source', true], ['noise', false]]);
    expect(a.flipped.map((f) => f.freezeId)).toEqual([A]);
  });

  test("footing: the judge's ruler moved", () => {
    expect(run(world({ bad: { ruler: 'r2' } })).answer).toEqual({ kind: 'footing', change: 'judge', from: 'r1', to: 'r2' });
  });

  test('freeze: the frozen moment changed (freezeSha), or a legacy public freeze changed in git', () => {
    expect(run(world({ good: { freezeSha: 'f1' }, bad: { freezeSha: 'f2' } })).answer).toEqual({ kind: 'freeze', freezeIds: [A] });
    expect(run(world({ good: { visibility: 'public' }, bad: { visibility: 'public' } }), { git: fakeGit([2, 4, 5], { changed: [`packages/evals/freezes/${A}.json`] }) }).answer).toEqual({ kind: 'freeze', freezeIds: [A] });
    expect(run(world()).checklist[1]!.detail).toBe('the frozen moments match (1 private freeze(s) predate freezeSha and are taken as unchanged)');
  });

  test('live reads on the bad side: not reproducible', () => {
    expect(run(world({ bad: { liveReads: 2 } })).answer).toEqual({ kind: 'live-reads', reps: 3, reads: 6 });
  });

  test('source, narrowed for free by the recorded batches and pinned to one commit', () => {
    const a = run(world());
    expect(a.answer).toMatchObject({ kind: 'source', confidence: 'pinned', noDeclaredSourceMoved: false, reason: null });
    expect(commits(a)).toEqual(['5']);
    expect(a.answer.kind === 'source' && a.answer.narrowedBy).toEqual([
      { batch: 'r1', sha: C(3), verdict: 'good', reps: 3 },
      { batch: 'r3', sha: C(4), verdict: 'good', reps: 3 },
      { batch: 'r2', sha: C(5), verdict: 'bad', reps: 3 },
    ]);
    expect(a.answer.kind === 'source' && a.answer.candidates[0]).toMatchObject({ kind: 'commit', commit: { sha: C(5), session: 'jx7abcd' } });
  });

  test('source, narrowed to the commits no recorded batch rules out', () => {
    expect(commits(run(world().filter((r) => r.batch !== 'r3')))).toEqual(['4', '5']);
    expect(run(world({ recorded: false })).answer).toMatchObject({ kind: 'source', confidence: 'narrowed', narrowedBy: [] });
    expect(commits(run(world({ recorded: false })))).toEqual(['2', '4', '5']);
  });

  test('the patch candidate: a dirty bad batch with a tree patch, pinned when its head reads good', () => {
    const bad = { dirty: true, treePatch: 'p9' };
    expect(commits(run(world({ bad })))).toEqual(['5']);
    const atHead = batchOf('r6', day(4), { [A]: { gitHead: C(6), mainSha: C(6) } });
    const a = run(world({ bad, recorded: false, extra: atHead }));
    expect(a.answer).toMatchObject({ kind: 'source', confidence: 'pinned' });
    expect(commits(a)).toEqual(['patch:p9']);
    expect(a.answer.kind === 'source' && a.answer.candidates[0]).toEqual({ kind: 'patch', base: C(6), treePatch: 'p9', renderClass: null });
  });

  test("an orphan head is searched through its main-line twin, and one with no twin is unattributable with heads.json's reason", () => {
    const twin = run(world({ bad: { gitHead: ORPHAN, mainSha: C(6), offBranch: true } }));
    expect(twin.bad).toMatchObject({ sha: ORPHAN, mainSha: C(6) });
    expect(commits(twin)).toEqual(['5']);
    const heads: HeadsFile = { updatedAt: day(9), mainLine: ['main'], heads: { [ORPHAN]: { on: 'none', mainSha: null, how: null, reason: 'no main-line commit carries its patch', near: C(5), pinned: true } } };
    const lost = run(world({ bad: { gitHead: ORPHAN, mainSha: null, offBranch: true } }), { heads });
    expect(lost.answer).toMatchObject({ kind: 'source', confidence: 'unattributable', reason: `bad's head eeeeeeeee is on no branch and has no main-line twin (no main-line commit carries its patch); nearest on main: 555555555` });
  });

  test('a sha endpoint stands for the clean batch that ran on it, or for an orphan through heads.json', () => {
    expect(run(world(), { good: C(0).slice(0, 9) }).good.batch).toBe('good');
    const heads: HeadsFile = { updatedAt: day(9), mainLine: ['main'], heads: { [ORPHAN]: { on: 'none', mainSha: C(6), how: 'patch-id', pinned: true } } };
    const a = run(world(), { bad: ORPHAN.slice(0, 12), heads });
    expect(a.bad).toMatchObject({ batch: null, sha: ORPHAN, mainSha: C(6) });
    expect(a.answer.kind).toBe('source');
  });

  test('no declared source moved, and --all-commits widens the search to every commit', () => {
    const a = run(world({ recorded: false }), { git: fakeGit([]) });
    expect(a.answer).toMatchObject({ kind: 'source', confidence: 'empty', noDeclaredSourceMoved: true, candidates: [], rangeCommits: 6 });
    const wide = run(world({ recorded: false }), { git: fakeGit([]), allCommits: true });
    expect(commits(wide)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(wide.answer).toMatchObject({ confidence: 'narrowed', noDeclaredSourceMoved: false, rangeCommits: 6 });
  });

  test('unattributable: the bad side ran on uncommitted edits nothing recorded can replay', () => {
    const a = run(world({ bad: { dirty: true } }));
    expect(a.answer).toMatchObject({ kind: 'source', confidence: 'unattributable', narrowedBy: [], reason: `bad bad ran on uncommitted edits to 666666666 that nothing recorded can replay` });
  });

  test('noise: same commit, same prompt, same footing', () => {
    const rows = [...batchOf('good', day(1), { [A]: {} }, 5), ...batchOf('bad', day(2), { [A]: { score: 0.2 } }, 5)];
    const a = run(rows);
    expect(a.answer).toEqual({ kind: 'noise', separation: { kind: 'worse', p: expect.any(Number) } });
    expect(a.checklist.map((c) => c.differs)).toEqual([false, false, false, false, true]);
  });

  test('score mode: no freeze flipped, so the largest median drops stand in', () => {
    const rows = [...batchOf('good', day(1), { [A]: { score: 0.95 }, [B]: { score: 0.9 } }, 5), ...batchOf('bad', day(2), { [A]: { score: 0.75, gitHead: C(6), mainSha: C(6) }, [B]: { score: 0.9, gitHead: C(6), mainSha: C(6) } }, 5)];
    const a = run(rows);
    expect(a.mode).toBe('score');
    expect(a.flipped).toEqual([]);
    expect(commits(a)).toEqual(['2', '4', '5']);
  });

  test('endpoints found from the records: the newest red batch, and the newest earlier one that passed its broken freezes', () => {
    const a = run(world(), { good: undefined, bad: undefined });
    expect([a.bad.batch, a.good.batch]).toEqual(['bad', 'r3']);
    expect(commits(a)).toEqual(['5']);
  });

  test('the prompt change rides along whatever the answer', () => {
    const rows = world({ good: { promptSha: 'p1' }, bad: { promptSha: 'p2' } });
    const id = (batch: string, seed: number) => `demo-a1a1a1a1-seed${seed}-${batch}`;
    const a = run(rows, { reader: fakeReader({ [id('good', 3)]: { 'call1/prompt.md': 'old' }, [id('bad', 1)]: { 'call1/prompt.md': 'new' } }) });
    expect(a.promptDiffs).toEqual([{ freezeId: A, file: 'call1/prompt.md', a: { runId: id('good', 3), text: 'old' }, b: { runId: id('bad', 1), text: 'new' } }]);
    expect(a.checklist[3]!.detail).toBe('the rendered prompt changed on a1a1a1a1; the commit moved: 000000000 to 666666666');
  });

  test('a prompt that held still still rides along, so a page can say so', () => {
    const id = (batch: string, seed: number) => `demo-a1a1a1a1-seed${seed}-${batch}`;
    const a = run(world(), { reader: fakeReader({ [id('good', 3)]: { 'call1/prompt.md': 'same' }, [id('bad', 1)]: { 'call1/prompt.md': 'same' } }) });
    expect(a.promptDiffs).toEqual([{ freezeId: A, file: 'call1/prompt.md', a: { runId: id('good', 3), text: 'same' }, b: { runId: id('bad', 1), text: 'same' } }]);
  });
});
