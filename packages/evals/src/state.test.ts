import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirtySurfaces, readState, sourceHashes, staleness, writeState } from './state';
import type { SurfaceMeta } from './surface';

const meta = (id: string, route: 'call' | 'agent', sources: string[]): SurfaceMeta => ({ id, title: id, route, model: 'm', sources, reps: { check: 5 }, maxUsdPerRep: 0.01 });

let repo = '';
const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'evals-state-'));
  process.env.CODECAST_EVALS_HOME = join(repo, '.home');
  mkdirSync(join(repo, 'a'), { recursive: true });
  writeFileSync(join(repo, 'a', 'x.ts'), '1');
  writeFileSync(join(repo, 'b.ts'), '1');
  writeFileSync(join(repo, '.gitignore'), '.home\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'one');
});
afterEach(() => {
  delete process.env.CODECAST_EVALS_HOME;
});

describe('source hashes at HEAD', () => {
  test('move with a commit, not with the disk', () => {
    const m = [meta('one', 'call', ['a', 'b.ts']), meta('two', 'call', ['missing.ts'])];
    const first = sourceHashes(m, repo);
    writeFileSync(join(repo, 'a', 'x.ts'), '2');
    expect(sourceHashes(m, repo)).toEqual(first);
    expect(dirtySurfaces(m, repo)).toEqual(new Set(['one']));
    git('commit', '-qam', 'two');
    const second = sourceHashes(m, repo);
    expect(second.get('one')).not.toBe(first.get('one'));
    expect(second.get('two')).toBe(first.get('two'));
    expect(dirtySurfaces(m, repo).size).toBe(0);
  });

  test('an untracked file in a source dir makes it dirty', () => {
    writeFileSync(join(repo, 'a', 'new.ts'), '1');
    expect(dirtySurfaces([meta('one', 'call', ['a'])], repo)).toEqual(new Set(['one']));
  });
});

describe('staleness', () => {
  test('call: stale until run on this hash; agent: also quiet once flagged; two crashes block', () => {
    const call = meta('c', 'call', ['b.ts']);
    const agent = meta('g', 'agent', ['b.ts']);
    const h = sourceHashes([call], repo).get('c')!;
    expect(staleness([call, agent], {}, repo).stale.map((s) => s.id)).toEqual(['c', 'g']);
    expect(staleness([call, agent], { c: { lastRunHash: h }, g: { lastNotifiedHash: h } }, repo).stale).toEqual([]);
    expect(staleness([call], { c: { lastNotifiedHash: h } }, repo).stale.map((s) => s.id)).toEqual(['c']);
    const blocked = staleness([call], { c: { crash: { hash: h, count: 2 } } }, repo);
    expect(blocked.stale).toEqual([]);
    expect(blocked.blocked.map((s) => s.id)).toEqual(['c']);
    expect(staleness([call], { c: { crash: { hash: h, count: 1 } } }, repo).stale.map((s) => s.id)).toEqual(['c']);
  });

  test('a stale call surface with dirty sources waits; a dirty agent surface is still due', () => {
    const call = meta('c', 'call', ['b.ts']);
    const agent = meta('g', 'agent', ['b.ts']);
    writeFileSync(join(repo, 'b.ts'), '2');
    const s = staleness([call, agent], {}, repo);
    expect(s.stale.map((m) => m.id)).toEqual(['c', 'g']);
    expect(s.waiting.map((m) => m.id)).toEqual(['c']);
    expect(s.due.map((m) => m.id)).toEqual(['g']);
    git('commit', '-qam', 'land it');
    expect(staleness([call, agent], {}, repo).due.map((m) => m.id)).toEqual(['c', 'g']);
  });

  test('state round-trips through EVALS_HOME', () => {
    writeState({ c: { lastRunHash: 'h', lastCostPerRep: 0.01 } });
    expect(readState()).toEqual({ c: { lastRunHash: 'h', lastCostPerRep: 0.01 } });
  });
});
