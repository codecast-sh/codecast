import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertLabelsPushable, labelsRemoteProblem } from './labels';

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
