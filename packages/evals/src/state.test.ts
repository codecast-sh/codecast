import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addSpend, changedSince, checkCostUsd, checkMinutes, dirtySurfaces, readState, repCostsByModel, sourceHashes, spentToday, staleness, suggestedBudget, writeState } from './state';
import type { SurfaceMeta } from './surface';

const meta = (id: string, route: 'call' | 'agent', sources: string[]): SurfaceMeta => ({ id, title: id, route, model: 'm', sources, reps: { check: 5 }, maxUsdPerRep: 0.01 });

let repo = '';
const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

// A case that reads git spawns it 5 to 15 times. One spawn takes milliseconds
// on an idle machine and up to a second at a load of 1000 (2026-10-02, when
// these cases took 6 to 9s), so they get this long; the rest keep bun's 5s.
const GIT_MS = 30_000;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'evals-state-'));
  process.env.CODECAST_EVALS_HOME = join(repo, '.home');
});

/** The scratch checkout the git cases read: two sources in one commit. */
function initRepo() {
  mkdirSync(join(repo, 'a'), { recursive: true });
  writeFileSync(join(repo, 'a', 'x.ts'), '1');
  writeFileSync(join(repo, 'b.ts'), '1');
  writeFileSync(join(repo, '.gitignore'), '.home\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'one');
}
afterEach(() => {
  delete process.env.CODECAST_EVALS_HOME;
});

describe('source hashes at HEAD', () => {
  beforeEach(initRepo, GIT_MS);

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
  }, GIT_MS);

  test('an untracked file in a source dir makes it dirty', () => {
    writeFileSync(join(repo, 'a', 'new.ts'), '1');
    expect(dirtySurfaces([meta('one', 'call', ['a'])], repo)).toEqual(new Set(['one']));
  }, GIT_MS);
});

describe('changed since a base (the line routes on this)', () => {
  beforeEach(initRepo, GIT_MS);

  const names = (r: { changed: SurfaceMeta[] }) => r.changed.map((m) => m.id);
  const ms = () => [meta('a', 'call', ['a']), meta('b', 'call', ['b.ts']), meta('n', 'agent', ['later.ts'])];

  test('names only what the branch committed since it left the base', () => {
    git('branch', 'base');
    writeFileSync(join(repo, 'a', 'x.ts'), '2');
    git('commit', '-qam', 'branch edits a');
    const r = changedSince(ms(), 'base', repo);
    expect(names(r)).toEqual(['a']);
    expect(changedSince(ms(), 'HEAD', repo).changed).toEqual([]);
  }, GIT_MS);

  test('a dirty or untracked source counts; a file landing where the base had none counts', () => {
    git('branch', 'base');
    writeFileSync(join(repo, 'b.ts'), '2');
    expect(names(changedSince(ms(), 'base', repo))).toEqual(['b']);
    writeFileSync(join(repo, 'later.ts'), 'new');
    expect(names(changedSince(ms(), 'base', repo))).toEqual(['b', 'n']);
    git('add', '-A');
    git('commit', '-qm', 'land them');
    expect(names(changedSince(ms(), 'base', repo))).toEqual(['b', 'n']);
  }, GIT_MS);

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
  }, GIT_MS);
});

describe('staleness', () => {
  test('call: stale until run on this hash; agent: also quiet once flagged; two crashes block', () => {
    initRepo();
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
    // A bigger budget than the one that refused tries the same sources again; the same or a smaller one does not.
    const h2 = sourceHashes([call], repo).get('c')!;
    const refused = { c: { lastRefusedHash: h2, lastRefusedBudget: 8 } };
    expect(staleness([call], refused, repo).stale).toEqual([]);
    expect(staleness([call], refused, repo, 8).stale).toEqual([]);
    expect(staleness([call], refused, repo, 14).stale.map((s) => s.id)).toEqual(['c']);
  }, GIT_MS);

  test("the day's spend adds up within a UTC day, line by line, and starts over on the next", () => {
    const path = join(repo, '.home', 'spend.jsonl');
    expect(spentToday(path)).toBe(0);
    addSpend(1.25, path);
    addSpend(0.5, path);
    addSpend(0, path);
    expect(spentToday(path)).toBe(1.75);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    // The one-number ledger it replaced still counts for its own day; another day's lines count for nothing.
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(join(repo, '.home', 'spend.json'), JSON.stringify({ day, usd: 3 }));
    expect(spentToday(path)).toBe(4.75);
    writeFileSync(join(repo, '.home', 'spend.json'), JSON.stringify({ day: '2000-01-01', usd: 99 }));
    writeFileSync(path, `${JSON.stringify({ day: '2000-01-01', usd: 99 })}\n{torn`);
    expect(spentToday(path)).toBe(0);
  });

  test('a stale call surface with dirty sources waits; a dirty agent surface is still due', () => {
    initRepo();
    const call = meta('c', 'call', ['b.ts']);
    const agent = meta('g', 'agent', ['b.ts']);
    writeFileSync(join(repo, 'b.ts'), '2');
    const s = staleness([call, agent], {}, repo);
    expect(s.stale.map((m) => m.id)).toEqual(['c', 'g']);
    expect(s.waiting.map((m) => m.id)).toEqual(['c']);
    expect(s.due.map((m) => m.id)).toEqual(['g']);
    git('commit', '-qam', 'land it');
    expect(staleness([call, agent], {}, repo).due.map((m) => m.id)).toEqual(['c', 'g']);
  }, GIT_MS);

  test('state round-trips through EVALS_HOME', () => {
    writeState({ c: { lastRunHash: 'h', perRep: { m: { usd: 0.01, seconds: 3 } } } });
    expect(readState()).toEqual({ c: { lastRunHash: 'h', perRep: { m: { usd: 0.01, seconds: 3 } } } });
  });
});

describe('check cost and the budget status suggests', () => {
  test('the estimate uses the last measured cost per rep on the model the reps run on, else the declared ceiling', () => {
    const m = meta('c', 'call', []);
    expect(checkCostUsd(m, 12, {})).toBeCloseTo(5 * 12 * 0.01);
    const state = { c: { perRep: { [m.model]: { usd: 0.05, seconds: 1 }, other: { usd: 0.5, seconds: 1 } } } };
    expect(checkCostUsd(m, 12, state, 3)).toBeCloseTo(3 * 12 * 0.05);
    expect(checkCostUsd(m, 12, state, 3, 'other')).toBeCloseTo(3 * 12 * 0.5);
    // A pin moved to a model with no history: the ceiling, never the old model's price.
    expect(checkCostUsd(m, 12, state, 3, 'new-pin')).toBeCloseTo(3 * 12 * m.maxUsdPerRep);
  });

  test('a run set records each model it ran on separately', () => {
    const costs = repCostsByModel([{ model: 'a', costUsd: 1, realMs: 1000 }, { model: 'a', costUsd: 3, realMs: 3000 }, { model: null, costUsd: 7, realMs: 7000 }], 'pin');
    expect(costs).toEqual({ a: { usd: 2, seconds: 2 }, pin: { usd: 7, seconds: 7 } });
  });

  test('the time estimate spreads each surface\'s recorded seconds per rep over the slots, and waits for a record', () => {
    const a = meta('a', 'call', []);
    const b = meta('b', 'call', []);
    const state = { a: { perRep: { [a.model]: { usd: 0, seconds: 30 } } }, b: { perRep: { [b.model]: { usd: 0, seconds: 90 } } } };
    expect(checkMinutes([{ meta: a, reps: 60 }, { meta: b, reps: 20 }], state, 4)).toBeCloseTo((60 * 30 + 20 * 90) / 4 / 60);
    expect(checkMinutes([{ meta: a, reps: 10 }, { meta: meta('new', 'call', []), reps: 1 }], state, 4)).toBeNull();
    expect(checkMinutes([{ meta: a, reps: 10, model: 'unseen' }], state, 4)).toBeNull();
  });

  test('a suggested budget is never under the estimate check refuses on', () => {
    // The 2026-10-01 sizing: all stale at 3 and 5 reps, and ask alone at 5.
    for (const estimate of [0, 0.004, 1, 3.47, 3.56, 5.94, 40]) expect(suggestedBudget(estimate)).toBeGreaterThanOrEqual(Math.max(1, estimate));
    expect(suggestedBudget(3.56)).toBeGreaterThan(3);
  });
});
