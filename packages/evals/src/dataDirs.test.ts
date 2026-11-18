import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { restoreDataDirs } from './dataDirs';

// A labels remote in a local bare repo; nothing here can reach the real one.
setDefaultTimeout(60_000);

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).stdout.trim();

/** An EVALS_HOME the way the November evals-only sync left it: freezes and snapshots inside the labels clone, linked from home. */
function adoptedHome() {
  const bare = mkdtempSync(join(tmpdir(), 'labels-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const root = mkdtempSync(join(tmpdir(), 'evals-home-'));
  const labels = join(root, 'labels');
  spawnSync('git', ['clone', '-q', bare, labels]);
  mkdirSync(join(labels, 'route'));
  writeFileSync(join(labels, 'route', 'label.json'), '{}');
  for (const d of ['freezes', 'snapshots/suggest']) mkdirSync(join(labels, d), { recursive: true });
  writeFileSync(join(labels, 'freezes', 'f1.json'), '{"id":"f1"}');
  writeFileSync(join(labels, 'snapshots', 'suggest', 's.json'), '{}');
  git(labels, 'add', '-A');
  git(labels, 'commit', '-qm', 'adopted');
  git(labels, 'push', '-q', 'origin', 'HEAD:main');
  for (const d of ['freezes', 'snapshots']) symlinkSync(join('labels', d), join(root, d));
  return { root, labels, bare };
}

const restore = (root: string, warnings: string[] = []) => restoreDataDirs({ root, warn: (l) => warnings.push(l), visibility: () => 'PRIVATE', remoteProblem: () => null });

describe('restoring freezes and snapshots to plain folders', () => {
  test('the links become folders with their files, and the labels repo stops tracking them', () => {
    const { root, labels, bare } = adoptedHome();
    const warnings: string[] = [];
    restore(root, warnings);
    expect(warnings).toEqual([]);
    for (const d of ['freezes', 'snapshots']) expect(lstatSync(join(root, d)).isDirectory()).toBe(true);
    expect(readFileSync(join(root, 'freezes', 'f1.json'), 'utf8')).toBe('{"id":"f1"}');
    expect(existsSync(join(root, 'snapshots', 'suggest', 's.json'))).toBe(true);
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main')).toBe('route/label.json');
    expect(git(labels, 'status', '--porcelain')).toBe('');
    // A second run has nothing to do.
    restore(root, warnings);
    expect(warnings).toEqual([]);
  });

  test('a clone still holding the old copies keeps every file when it pulls the removal', () => {
    const first = adoptedHome();
    const root = mkdtempSync(join(tmpdir(), 'evals-home-'));
    spawnSync('git', ['clone', '-q', first.bare, join(root, 'labels')]);
    for (const d of ['freezes', 'snapshots']) symlinkSync(join('labels', d), join(root, d));
    restore(first.root);
    // This machine runs the new code before any pull: its copies move out first.
    restore(root);
    git(join(root, 'labels'), 'pull', '-q', '--rebase', 'origin', 'main');
    expect(readFileSync(join(root, 'freezes', 'f1.json'), 'utf8')).toBe('{"id":"f1"}');
    expect(existsSync(join(root, 'labels', 'freezes'))).toBe(false);
  });

  test('a home that never had the links is left alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'evals-home-'));
    mkdirSync(join(root, 'freezes'));
    writeFileSync(join(root, 'freezes', 'x.json'), '{}');
    const warnings: string[] = [];
    restore(root, warnings);
    expect(warnings).toEqual([]);
    expect(readFileSync(join(root, 'freezes', 'x.json'), 'utf8')).toBe('{}');
  });
});
