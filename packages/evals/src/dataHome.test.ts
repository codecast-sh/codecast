import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncDataHome } from './dataHome';

// Two machines' EVALS_HOMEs share one local bare repo standing in for the
// private remote. Nothing here names the real remote: the clone comes from the
// bare repo and the origin check is the test's own, so no run can reach GitHub.
setDefaultTimeout(60_000);

let bare = '';

beforeAll(() => {
  bare = mkdtempSync(join(tmpdir(), 'data-bare-'));
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
  // The remote starts as the labels repo does: one label.
  const seed = mkdtempSync(join(tmpdir(), 'data-seed-'));
  spawnSync('git', ['clone', '-q', bare, seed]);
  mkdirSync(join(seed, 'route'));
  writeFileSync(join(seed, 'route', 'a.json'), '{}');
  spawnSync('git', ['add', '-A'], { cwd: seed });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed'], { cwd: seed });
  spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seed });
});

const machine = (): string => mkdtempSync(join(tmpdir(), 'evals-home-'));
const sync = (root: string, push = false, warnings: string[] = []) =>
  syncDataHome({ root, push, cloneUrl: bare, remoteProblem: () => null, visibility: () => 'PRIVATE', warn: (l) => warnings.push(l) });
const remoteFiles = (): string[] => spawnSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: bare, encoding: 'utf8' }).stdout.trim().split('\n');

describe('the shared eval data', () => {
  test('a machine with data from before the repo carried it clones the repo, moves its freezes and snapshots in, and pushes them', () => {
    const laptop = machine();
    mkdirSync(join(laptop, 'freezes'));
    writeFileSync(join(laptop, 'freezes', 'f1.json'), '{"id":"f1"}');
    mkdirSync(join(laptop, 'snapshots', 'suggest'), { recursive: true });
    writeFileSync(join(laptop, 'snapshots', 'suggest', 'aaa.json'), '{}');
    const warnings: string[] = [];
    sync(laptop, false, warnings);
    expect(warnings).toEqual([]);
    for (const d of ['freezes', 'snapshots']) expect(lstatSync(join(laptop, d)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(laptop, 'freezes', 'f1.json'), 'utf8')).toBe('{"id":"f1"}');
    expect(remoteFiles()).toEqual(expect.arrayContaining(['freezes/f1.json', 'snapshots/suggest/aaa.json', 'route/a.json']));
  });

  test('another machine reads that freeze, and what it writes reaches the first machine', () => {
    const laptop = machine();
    sync(laptop);
    const host = machine();
    mkdirSync(join(host, 'freezes'));
    writeFileSync(join(host, 'freezes', 'h1.json'), '{"id":"h1"}');
    sync(host);
    expect(readFileSync(join(host, 'freezes', 'f1.json'), 'utf8')).toBe('{"id":"f1"}');
    expect(readFileSync(join(host, 'freezes', 'h1.json'), 'utf8')).toBe('{"id":"h1"}');

    // A run on the host writes a freeze through the link; the end-of-run sync sends it.
    writeFileSync(join(host, 'freezes', 'h2.json'), '{"id":"h2"}');
    sync(host, true);
    expect(remoteFiles()).toContain('freezes/h2.json');

    // The laptop fetched under a minute ago, so it reads what it has; once that fetch is a minute old, a run brings the host's freeze.
    sync(laptop);
    expect(existsSync(join(laptop, 'freezes', 'h2.json'))).toBe(false);
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(laptop, 'labels', '.git', 'FETCH_HEAD'), old, old);
    sync(laptop);
    expect(existsSync(join(laptop, 'freezes', 'h2.json'))).toBe(true);
  });

  test('a file the repo already holds is set aside, never overwritten or lost', () => {
    const host = machine();
    mkdirSync(join(host, 'freezes'));
    writeFileSync(join(host, 'freezes', 'f1.json'), '{"id":"f1","local":true}');
    mkdirSync(join(host, 'snapshots', 'suggest'), { recursive: true });
    writeFileSync(join(host, 'snapshots', 'suggest', 'aaa.json'), '{}');
    const warnings: string[] = [];
    sync(host, false, warnings);
    expect(readFileSync(join(host, 'freezes', 'f1.json'), 'utf8')).toBe('{"id":"f1"}');
    // The identical snapshot is simply the same file; only the freeze that differs is set aside.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('freezes files');
    const aside = join(host, 'scratch', 'data-adopt');
    const [dir] = readdirSync(aside);
    expect(readFileSync(join(aside, dir!, 'f1.json'), 'utf8')).toBe('{"id":"f1","local":true}');
  });

  test('a machine that cannot clone keeps its data where it was, warns once, and does not retry for an hour', () => {
    const host = machine();
    mkdirSync(join(host, 'freezes'));
    writeFileSync(join(host, 'freezes', 'x.json'), '{}');
    const warnings: string[] = [];
    syncDataHome({ root: host, cloneUrl: join(tmpdir(), 'no-such-repo'), warn: (l) => warnings.push(l) });
    syncDataHome({ root: host, cloneUrl: join(tmpdir(), 'no-such-repo'), warn: (l) => warnings.push(l) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cloning');
    expect(lstatSync(join(host, 'freezes')).isDirectory()).toBe(true);
    expect(existsSync(join(host, 'freezes', 'x.json'))).toBe(true);
    expect(existsSync(join(host, 'labels'))).toBe(false);
  });
});
