import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertLabelsPushable, labelPath, labelsRemoteProblem, writeLabel } from './labels';
import { moveInGradeSets } from './surfaces/orgReview/grade';

// Every test spawns git several times; on a loaded machine one spawn can take seconds.
setDefaultTimeout(60_000);

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
  /** A labels clone whose origin names the private remote, with pushes rewritten to a local bare repo (a fresh one, or `bare`). */
  const clone = (bare = mkdtempSync(join(tmpdir(), 'labels-bare-'))) => {
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
  });

  test('a write after another clone pushed replays onto it, and a conflict says how to recover', () => {
    const { dir, bare } = clone();
    writeLabel('route', 'aaaaaaaa-0000', { expected: 'a' }, dir, () => 'PRIVATE');
    // A second clone (a cloud host) pulls, labels and pushes.
    const other = clone(bare).dir;
    spawnSync('git', ['pull', '-q', bare, git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')], { cwd: other });
    writeLabel('route', 'bbbbbbbb-0000', { expected: 'b' }, other, () => 'PRIVATE');
    // The first clone has not synced, yet its next write lands on top.
    writeLabel('route', 'cccccccc-0000', { expected: 'c' }, dir, () => 'PRIVATE');
    expect(git(bare, 'log', '--format=%s', '--all').split('\n')).toEqual(['route: label for freeze cccccccc', 'route: label for freeze bbbbbbbb', 'route: label for freeze aaaaaaaa']);
    // Both clones then label the same freeze differently: the second's replay conflicts, is undone, and the error names the recovery.
    spawnSync('git', ['pull', '-q', '--rebase', bare, git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')], { cwd: other });
    writeLabel('route', 'dddddddd-0000', { expected: 'other' }, other, () => 'PRIVATE');
    expect(() => writeLabel('route', 'dddddddd-0000', { expected: 'mine' }, dir, () => 'PRIVATE')).toThrow('pull --rebase');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('route: label for freeze dddddddd');
    // Two clones and a few dozen git spawns: minutes on a loaded machine.
  }, 300_000);

  test("a workspace grade-set move commits the sets and its reason together, and pushes", () => {
    const home = mkdtempSync(join(tmpdir(), 'labels-home-'));
    const { dir, bare } = clone();
    const labels = join(home, 'labels');
    spawnSync('mv', [dir, labels]);
    const ws = join(labels, 'org-review', 'acme');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'grade-sets.json'), JSON.stringify({ must_not_close: ['ct-1', 'ct-2'], should_close: [], found_by_a_run: [], name_it: [], never_name: [] }));
    writeFileSync(join(ws, 'ground-truth.md'), '# acme\n');
    const prev = process.env.CODECAST_EVALS_HOME;
    process.env.CODECAST_EVALS_HOME = home;
    try {
      expect(moveInGradeSets('acme', 'ct-1', 'found_by_a_run', 'its owning session shipped the fix first.', { visibility: () => 'PRIVATE' })).toEqual(['must_not_close']);
    } finally {
      if (prev === undefined) delete process.env.CODECAST_EVALS_HOME;
      else process.env.CODECAST_EVALS_HOME = prev;
    }
    expect(JSON.parse(readFileSync(join(ws, 'grade-sets.json'), 'utf8'))).toMatchObject({ must_not_close: ['ct-2'], found_by_a_run: ['ct-1'] });
    expect(readFileSync(join(ws, 'ground-truth.md'), 'utf8')).toMatch(/^# acme\n\n- \d{4}-\d\d-\d\d: ct-1 must_not_close -> found_by_a_run\. its owning session shipped the fix first\.\n$/);
    expect(git(bare, 'log', '--format=%s', '--all')).toBe('org-review/acme: ct-1 must_not_close -> found_by_a_run');
    expect(git(bare, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['org-review/acme/grade-sets.json', 'org-review/acme/ground-truth.md']);
  });

  test('a label is never written into a repo that cannot push to the private remote', () => {
    const { dir } = clone();
    expect(() => writeLabel('route', 'abcdef12-0000', { expected: 'x' }, dir, () => 'PUBLIC')).toThrow('only to a private repo');
    expect(git(dir, 'log', '--format=%s')).toBe('');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
