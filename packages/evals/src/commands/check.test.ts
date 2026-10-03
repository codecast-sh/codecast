import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunJson } from '../layout';
import { diskPaths } from '../provenance';
import { sourceHashes } from '../state';
import type { SurfaceMeta } from '../surface';
import { echoMeta } from '../testSurface';
import { freezeIdOf, runDirs, world, type World } from '../testWorld';
import { batchLock, BISECT_CADENCE, EXIT_INCOMPLETE, fitBudget } from './check';

// Each scratch-repo test spawns the CLI a few times; on a loaded machine one spawn can take seconds.
setDefaultTimeout(120_000);

describe('a stale run over its budget', () => {
  const plan = (id: string) => ({ meta: { id } as SurfaceMeta });
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(plan) as [ReturnType<typeof plan>, ReturnType<typeof plan>, ReturnType<typeof plan>, ReturnType<typeof plan>];
  const cost: Record<string, number> = { a: 4, b: 6, c: 3, d: 20 };
  const usd = (p: { meta: SurfaceMeta }) => cost[p.meta.id]!;

  test('runs the surfaces stale longest first while they fit, defers the rest, and refuses one over the budget alone', () => {
    // a never ran; c ran before b.
    const state = { b: { lastRunAt: '2026-10-02T10:00:00.000Z' }, c: { lastRunAt: '2026-10-01T10:00:00.000Z' }, d: { lastRunAt: '2026-09-30T10:00:00.000Z' } };
    const fit = fitBudget([b, c, a, d], usd, 10, 10, state);
    expect(fit.refused).toEqual([d]);
    expect(fit.run).toEqual([a, c]);
    expect(fit.deferred).toEqual([b]);
  });

  test('a deferred surface goes first at the next firing, being staler than what ran', () => {
    const state = { a: { lastRunAt: '2026-10-03T08:00:00.000Z' }, c: { lastRunAt: '2026-10-03T08:00:00.000Z' }, b: { lastRunAt: '2026-10-02T10:00:00.000Z' } };
    expect(fitBudget([a, b, c], usd, 10, 10, state).run).toEqual([b, a]);
  });

  test("what the day leaves can defer a surface the budget alone would run, without refusing it", () => {
    const fit = fitBudget([a, b], usd, 10, 5, {});
    expect(fit.run).toEqual([a]);
    expect(fit.deferred).toEqual([b]);
    expect(fit.refused).toEqual([]);
  });
});

describe('what a rep ran, on a scratch repo', () => {
  const runJson = (w: World, batch: string) => {
    const dir = runDirs(w).find((d) => JSON.parse(readFileSync(join(w.home, 'runs', d, 'run.json'), 'utf8')).batch === batch)!;
    return JSON.parse(readFileSync(join(w.home, 'runs', dir, 'run.json'), 'utf8')) as RunJson;
  };
  const surfaceFile = (w: World) => join(w.pkg, 'src', 'testSurface.ts');
  const commitFreeze = (w: World) => {
    const id = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:a', '--json').out);
    w.git('add', '-A');
    w.git('commit', '-qm', 'freeze');
    return id;
  };

  test("a dirty rep records the disk it ran beside HEAD's hash, and its patch rebuilds that disk on gitHead", () => {
    const w = world();
    commitFreeze(w);
    expect(w.run('check', 'echo', '--dry', '--reps', '1', '--batch', 'clean').code).toBe(0);
    const clean = runJson(w, 'clean');
    // A clean disk hashes as HEAD does over the same paths, and needs no patch.
    expect(clean.sourceHashDisk).toBe(sourceHashes([{ ...echoMeta, sources: diskPaths(echoMeta) }], w.repo, 'HEAD').get('echo')!);
    expect(clean.treePatch).toBeNull();
    expect(clean.dirty).toBe(false);

    writeFileSync(surfaceFile(w), '// edited on disk, never committed\n', { flag: 'a' });
    writeFileSync(join(w.pkg, 'fixtures', 'echo', 'untracked.json'), '{"asOf":"2026-01-01T00:00:00.000Z","snapshot":{"text":"new"}}\n');
    expect(w.run('check', 'echo', '--dry', '--reps', '1', '--batch', 'dirty').code).toBe(0);
    const dirty = runJson(w, 'dirty');
    expect(dirty.dirty).toBe(true);
    expect(dirty.gitHead).toBe(clean.gitHead);
    // sourceHash still names HEAD, which is not what ran; sourceHashDisk names the disk.
    expect(dirty.sourceHash).toBe(clean.sourceHash);
    expect(dirty.sourceHashDisk).toMatch(/^[0-9a-f]{64}$/);
    expect(dirty.sourceHashDisk).not.toBe(clean.sourceHashDisk);
    expect(dirty.sourceHashDisk).not.toBe(dirty.sourceHash);

    const patch = join(w.home, 'trees', `${dirty.treePatch}.patch`);
    expect(createHash('sha256').update(readFileSync(patch)).digest('hex')).toBe(dirty.treePatch!);
    const clone = mkdtempSync(join(tmpdir(), 'evals-patch-'));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: clone });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
      return r.stdout.toString();
    };
    git('clone', '-q', w.repo, '.');
    git('checkout', '-q', '--detach', dirty.gitHead);
    git('apply', '--check', patch);
    git('apply', patch);
    expect(readFileSync(join(clone, 'packages/evals/src/testSurface.ts'), 'utf8')).toBe(readFileSync(surfaceFile(w), 'utf8'));
    expect(existsSync(join(clone, 'packages/evals/fixtures/echo/untracked.json'))).toBe(true);
    // The head the reps name is pinned, so no rebase or gc can take it.
    expect(git('-C', w.repo, 'for-each-ref', '--format=%(objectname)', 'refs/evals/heads/').trim()).toBe(dirty.gitHead);
  });

  test("freezeSha holds while the freeze and its snapshot do, and moves when the snapshot changes", () => {
    const w = world();
    commitFreeze(w);
    w.run('check', 'echo', '--dry', '--reps', '1', '--batch', 'b1');
    w.run('check', 'echo', '--dry', '--reps', '1', '--batch', 'b2');
    const b1 = runJson(w, 'b1').freezeSha;
    expect(b1).toMatch(/^[0-9a-f]{64}$/);
    expect(runJson(w, 'b2').freezeSha).toBe(b1);
    const fixture = join(w.pkg, 'fixtures', 'echo', 'a.json');
    writeFileSync(fixture, readFileSync(fixture, 'utf8').replace('say this back', 'say this back, changed'));
    w.run('check', 'echo', '--dry', '--reps', '1', '--batch', 'b3');
    expect(runJson(w, 'b3').freezeSha).not.toBe(b1);
  });

  test('--stop-file stops before the next rep like a budget stop, and changes nothing while the file is absent', () => {
    const w = world();
    commitFreeze(w);
    const stop = join(w.home, 'stop');
    const plain = w.run('check', 'echo', '--dry', '--reps', '2', '--batch', 'plain');
    const watched = w.run('check', 'echo', '--dry', '--reps', '2', '--batch', 'watched', '--stop-file', stop);
    expect(watched.code).toBe(plain.code);
    // The same output but for the batch's own name and stamps.
    const same = (out: string) => out.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T').replace(/plain|watched/g, 'B');
    expect(same(watched.out)).toBe(same(plain.out));
    expect(runDirs(w)).toHaveLength(4);

    writeFileSync(stop, '');
    const r = w.run('check', 'echo', '--dry', '--reps', '2', '--batch', 'stopped', '--stop-file', stop);
    expect(r.code).toBe(EXIT_INCOMPLETE);
    expect(r.out).toContain(`stopped: ${stop} exists (endedBecause: budget)`);
    const stopped = runDirs(w).filter((d) => JSON.parse(readFileSync(join(w.home, 'runs', d, 'run.json'), 'utf8')).batch === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(w.home, 'runs', stopped[0]!, 'result.json'), 'utf8')).endedBecause).toBe('budget');
  });

  test('a named batch another live check holds is refused, and a dead holder\'s lock is reclaimed', () => {
    const w = world();
    commitFreeze(w);
    mkdirSync(join(w.home, 'locks'), { recursive: true });
    const lockAt = join(w.home, 'locks', batchLock('held').name!);
    writeFileSync(lockAt, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
    const refused = w.run('check', 'echo', '--dry', '--reps', '1', '--batch', 'held');
    expect(refused.code).toBe(EXIT_INCOMPLETE);
    expect(refused.out).toContain(`refused: batch held is being run by pid ${process.pid}`);
    expect(runDirs(w)).toHaveLength(0);
    // The holder died without releasing: the next check takes the batch over and lets it go when done.
    writeFileSync(lockAt, JSON.stringify({ pid: Bun.spawnSync(['true']).pid, acquired_at: new Date().toISOString() }));
    expect(w.run('check', 'echo', '--dry', '--reps', '1', '--batch', 'held').code).toBe(0);
    expect(runDirs(w)).toHaveLength(1);
    expect(existsSync(lockAt)).toBe(false);
  });

  test("--cadence bisect stamps its probes and leaves the cadence state alone", () => {
    const w = world();
    const boom = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:boom', '--json').out);
    const r = w.run('check', 'echo', '--dry', '--reps', '1', '--freeze', boom.slice(0, 8), '--cadence', BISECT_CADENCE);
    expect(r.out).toContain('1 crashed');
    const [dir] = runDirs(w);
    expect(JSON.parse(readFileSync(join(w.home, 'runs', dir!, 'run.json'), 'utf8')).cadence).toBe(BISECT_CADENCE);
    // A crash under any other cadence counts toward the block; a probe's never does.
    expect(existsSync(join(w.home, 'state.json')) ? JSON.parse(readFileSync(join(w.home, 'state.json'), 'utf8')).echo : undefined).toBeUndefined();
  });
});
