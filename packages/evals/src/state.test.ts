import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addSpend, changedSince, checkCostUsd, dirtySurfaces, readState, sourceHashes, spentToday, staleness, suggestedBudget, writeState } from './state';
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

describe('changed since a base (the line routes on this)', () => {
  const names = (r: { changed: SurfaceMeta[] }) => r.changed.map((m) => m.id);
  const ms = () => [meta('a', 'call', ['a']), meta('b', 'call', ['b.ts']), meta('n', 'agent', ['later.ts'])];

  test('names only what the branch committed since it left the base', () => {
    git('branch', 'base');
    writeFileSync(join(repo, 'a', 'x.ts'), '2');
    git('commit', '-qam', 'branch edits a');
    const r = changedSince(ms(), 'base', repo);
    expect(names(r)).toEqual(['a']);
    expect(changedSince(ms(), 'HEAD', repo).changed).toEqual([]);
  });

  test('a dirty or untracked source counts; a file landing where the base had none counts', () => {
    git('branch', 'base');
    writeFileSync(join(repo, 'b.ts'), '2');
    expect(names(changedSince(ms(), 'base', repo))).toEqual(['b']);
    writeFileSync(join(repo, 'later.ts'), 'new');
    expect(names(changedSince(ms(), 'base', repo))).toEqual(['b', 'n']);
    git('add', '-A');
    git('commit', '-qm', 'land them');
    expect(names(changedSince(ms(), 'base', repo))).toEqual(['b', 'n']);
  });

  test('a base that moved on after the branch left it is not the branch\'s change', () => {
    git('branch', 'base');
    git('checkout', '-qb', 'feature');
    writeFileSync(join(repo, 'a', 'x.ts'), 'feature');
    git('commit', '-qam', 'feature edits a');
    git('checkout', '-q', 'base');
    writeFileSync(join(repo, 'b.ts'), 'main moved');
    git('commit', '-qam', 'base edits b');
    git('checkout', '-q', 'feature');
    const r = changedSince(ms(), 'base', repo);
    expect(names(r)).toEqual(['a']);
    expect(sourceHashes(ms(), repo, r.base).get('b')).not.toBe(sourceHashes(ms(), repo, 'base').get('b'));
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
    // A budget refusal is named once per source change: the refused hash is seen.
    expect(staleness([call], { c: { lastRefusedHash: h } }, repo).stale).toEqual([]);
    writeFileSync(join(repo, 'b.ts'), '2');
    git('commit', '-qam', 'two');
    expect(staleness([call], { c: { lastRefusedHash: h } }, repo).stale.map((s) => s.id)).toEqual(['c']);
  });

  test("the day's spend adds up within a UTC day and starts over on the next", () => {
    const path = join(repo, '.home', 'spend.json');
    expect(spentToday(path)).toBe(0);
    addSpend(1.25, path);
    addSpend(0.5, path);
    addSpend(0, path);
    expect(spentToday(path)).toBe(1.75);
    writeFileSync(path, JSON.stringify({ day: '2000-01-01', usd: 99 }));
    expect(spentToday(path)).toBe(0);
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

describe('check cost and the budget status suggests', () => {
  test('the estimate uses the last measured cost per rep, else the declared ceiling', () => {
    const m = meta('c', 'call', []);
    expect(checkCostUsd(m, 12, {})).toBeCloseTo(5 * 12 * 0.01);
    expect(checkCostUsd(m, 12, { c: { lastCostPerRep: 0.05 } }, 3)).toBeCloseTo(3 * 12 * 0.05);
  });

  test('a suggested budget is never under the estimate check refuses on', () => {
    // The 2026-10-01 sizing: all stale at 3 and 5 reps, and ask alone at 5.
    for (const estimate of [0, 0.004, 1, 3.47, 3.56, 5.94, 40]) expect(suggestedBudget(estimate)).toBeGreaterThanOrEqual(Math.max(1, estimate));
    expect(suggestedBudget(3.56)).toBeGreaterThan(3);
  });
});
