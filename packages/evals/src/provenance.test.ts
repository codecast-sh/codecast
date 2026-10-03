import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PIN_REF_PREFIX } from './paths';
import { backfillPins, pinnedHeads, readHeads, writeCheckoutPointer } from './provenance';

// A scratch repo with every place a run head can end up: on main, rebased
// onto main and dropped (a patch-id twin), amended when it landed (no twin),
// on a side branch only, and gone before anything pinned it.

let repo: string;
let home: string;
const shas: Record<string, string> = {};

const run = (args: string[], env: Record<string, string> = {}): string => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const commit = (file: string, body: string, subject: string, date?: string): string => {
  writeFileSync(join(repo, file), body);
  run(['add', file]);
  run(['commit', '-q', '-m', subject], date ? { GIT_AUTHOR_DATE: date } : {});
  return run(['rev-parse', 'HEAD']);
};

const runFolder = (name: string, gitHead: string) => {
  mkdirSync(join(home, 'runs', name), { recursive: true });
  writeFileSync(join(home, 'runs', name, 'run.json'), JSON.stringify({ gitHead }));
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'evals-prov-'));
  home = join(repo, '.home');
  run(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, '.gitignore'), '.home/\n');
  shas.base = commit('a.txt', 'a\n', 'base');

  // feat: one commit, later rebased onto main and the branch deleted.
  run(['checkout', '-q', '-b', 'feat']);
  shas.rebased = commit('f.txt', 'f\n', 'add f', '2026-10-01T10:00:00Z');
  run(['checkout', '-q', 'main']);
  shas.main2 = commit('b.txt', 'b\n', 'main moves on');
  run(['cherry-pick', shas.rebased!]);
  shas.twin = run(['rev-parse', 'HEAD']);
  run(['branch', '-q', '-D', 'feat']);

  // amend: same author, date and subject on both sides, different content.
  run(['checkout', '-q', '--detach']);
  shas.amended = commit('g.txt', 'g one\n', 'add g', '2026-10-01T11:00:00Z');
  run(['checkout', '-q', 'main']);
  shas.landed = commit('g.txt', 'g two\n', 'add g', '2026-10-01T11:00:00Z');

  // a side branch that never landed.
  run(['checkout', '-q', '-b', 'side']);
  shas.side = commit('s.txt', 's\n', 'side work');
  run(['checkout', '-q', 'main']);

  runFolder('title-aaaaaaaa-seed1-a', shas.twin!);
  runFolder('title-aaaaaaaa-seed2-a', shas.twin!);
  runFolder('title-bbbbbbbb-seed1-b', shas.rebased!);
  runFolder('title-cccccccc-seed1-c', shas.amended!);
  runFolder('title-dddddddd-seed1-d', shas.side!);
  runFolder('title-eeeeeeee-seed1-e', 'f'.repeat(40));
  runFolder('title-ffffffff-seed1-f', 'unknown');
  mkdirSync(join(home, 'runs', 'crashed-before-run-json'), { recursive: true });
}, 60_000);

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('backfillPins', () => {
  test('pins every recorded head the repo holds and maps each one', () => {
    const headsPath = join(home, 'heads.json');
    const r = backfillPins({ root: repo, runsDir: join(home, 'runs'), headsPath });
    expect(r.pinned.sort()).toEqual([shas.twin!, shas.rebased!, shas.amended!, shas.side!].sort());
    expect(r.missing).toEqual(['f'.repeat(40)]);
    expect(r.runs.get(shas.twin!)).toBe(2);
    expect(pinnedHeads(repo).sort()).toEqual(r.pinned.sort());

    const h = readHeads(headsPath)!.heads;
    expect(h[shas.twin!]).toMatchObject({ on: 'main', mainSha: shas.twin, how: 'self', pinned: true });
    expect(h[shas.rebased!]).toMatchObject({ on: 'none', mainSha: shas.twin, how: 'patch-id', subject: 'add f' });
    expect(h[shas.amended!]).toMatchObject({ on: 'none', mainSha: null, how: null, near: shas.landed });
    expect(h[shas.amended!]!.reason).toContain('different patch');
    expect(h[shas.side!]).toMatchObject({ on: 'branch', mainSha: null });
    expect(h[shas.side!]!.reason).toContain('no main-line commit carries the same patch');
  }, 60_000);

  test('a second run pins nothing new and keeps the map', () => {
    const headsPath = join(home, 'heads.json');
    const r = backfillPins({ root: repo, runsDir: join(home, 'runs'), headsPath });
    expect(r.pinned).toEqual([]);
    expect(r.already.length).toBe(4);
    expect(Object.keys(readHeads(headsPath)!.heads).length).toBe(4);
  }, 60_000);

  test('pinned orphans survive gc, and the refs are not pushed', () => {
    run(['reflog', 'expire', '--expire=now', '--all']);
    run(['gc', '-q', '--prune=now']);
    for (const sha of [shas.rebased!, shas.amended!]) expect(run(['cat-file', '-t', sha])).toBe('commit');
    const bare = mkdtempSync(join(tmpdir(), 'evals-prov-remote-'));
    try {
      spawnSync('git', ['init', '-q', '--bare', bare]);
      const r = spawnSync('git', ['push', '--dry-run', '--porcelain', bare, 'main'], { cwd: repo, encoding: 'utf8' });
      expect(r.stdout).not.toContain(PIN_REF_PREFIX);
      expect(r.stdout).toContain('refs/heads/main');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('writeCheckoutPointer', () => {
  test('records the checkout, and ignores a tool copy in EVALS_HOME scratch', () => {
    const at = join(home, 'pointer');
    mkdirSync(join(at, 'scratch', 'line-base-x'), { recursive: true });
    expect(writeCheckoutPointer(join(at, 'scratch', 'line-base-x'), at)).toBe(false);
    expect(writeCheckoutPointer(repo, at)).toBe(true);
    const ptr = JSON.parse(readFileSync(join(at, 'checkout.json'), 'utf8')) as { root: string; at: string };
    expect(ptr.root.endsWith(repo.split('/').pop()!)).toBe(true);
    expect(Number.isNaN(Date.parse(ptr.at))).toBe(false);
  });
});
