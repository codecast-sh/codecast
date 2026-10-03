import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertLabelsPushable, labelPath, labelsRemoteProblem, writeLabel } from './labels';

const repo = (origin?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'labels-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (origin) spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  return dir;
};

describe('the labels push guard', () => {
  test('only the private labels remote passes', () => {
    expect(labelsRemoteProblem(repo('git@github.com:ashot/codecast-eval-labels.git'))).toBeNull();
    expect(labelsRemoteProblem(repo('https://github.com/ashot/codecast-eval-labels'))).toBeNull();
    expect(labelsRemoteProblem(repo('git@github.com:ashot/codecast-eval-labels-public.git'))).toContain('not ashot/codecast-eval-labels');
    expect(labelsRemoteProblem(repo())).toContain('"none"');
    expect(labelsRemoteProblem(mkdtempSync(join(tmpdir(), 'labels-')))).toContain('is not a git repo');
  });

  test('a push is refused on a wrong origin or a repo that is not private', () => {
    const right = repo('git@github.com:ashot/codecast-eval-labels.git');
    expect(() => assertLabelsPushable(right, () => 'PRIVATE')).not.toThrow();
    expect(() => assertLabelsPushable(right, () => 'PUBLIC')).toThrow('only to a private repo');
    expect(() => assertLabelsPushable(right, () => null)).toThrow('not visible to gh');
    expect(() => assertLabelsPushable(repo('git@github.com:someone/else.git'), () => 'PRIVATE')).toThrow('push only to the private');
  });
});

describe('the label write path', () => {
  const REMOTE = 'git@github.com:ashot/codecast-eval-labels.git';
  /** A labels clone whose origin names the private remote, with pushes rewritten to a local bare repo. */
  const clone = () => {
    const bare = mkdtempSync(join(tmpdir(), 'labels-bare-'));
    spawnSync('git', ['init', '-q', '--bare'], { cwd: bare });
    const dir = repo(REMOTE);
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], [`url.${bare}.pushInsteadOf`, REMOTE]]) spawnSync('git', ['config', k!, v!], { cwd: dir });
    return { dir, bare };
  };
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

  test('a label is written, committed and pushed, and only its own file is committed', () => {
    const { dir, bare } = clone();
    mkdirSync(join(dir, 'settle'));
    writeFileSync(join(dir, 'settle', 'unrelated.json'), '{}');
    const path = writeLabel('route', 'abcdef12-0000', { expected: 'head-of-people' }, dir, () => 'PRIVATE');
    expect(path).toBe(labelPath('route', 'abcdef12-0000', dir));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ expected: 'head-of-people' });
    expect(git(dir, 'log', '--format=%s')).toBe('route: label for freeze abcdef12');
    expect(git(dir, 'show', '--name-only', '--format=')).toBe('route/abcdef12-0000.json');
    expect(git(bare, 'log', '--format=%s', '--all')).toBe('route: label for freeze abcdef12');
    expect(git(dir, 'status', '--porcelain')).toBe('?? settle/');
  }, 60_000);

  test('a label is never written into a repo that cannot push to the private remote', () => {
    const { dir } = clone();
    expect(() => writeLabel('route', 'abcdef12-0000', { expected: 'x' }, dir, () => 'PUBLIC')).toThrow('only to a private repo');
    expect(git(dir, 'log', '--format=%s')).toBe('');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  }, 60_000);
});
