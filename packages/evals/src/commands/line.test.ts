import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { checkArgs, dropBaseTree, pinMissingImports, prepareTreeAt } from './line';

// The base worktree runs this checkout's eval tool against the base's prod
// code. A tool import the base cannot satisfy reads this checkout's module; a
// surface adapter's imports always stay the base's.

const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe('pinMissingImports', () => {
  test('pins only tool imports whose values the base lacks', () => {
    const wt = mkdtempSync(join(tmpdir(), 'line-pin-wt-'));
    const own = mkdtempSync(join(tmpdir(), 'line-pin-own-'));
    const pkg = join(wt, 'packages', 'evals');
    put(wt, 'packages/lib/h.ts', 'export const x = 1;\nexport type T = 1;\n');
    put(own, 'packages/lib/h.ts', 'export const x = 1;\nexport const y = 2;\nexport type T = 1;\n');
    put(own, 'packages/lib/gone.ts', 'export const z = 3;\n');
    put(pkg, 'src/needsNew.ts', "import { x, y as why } from '../../lib/h';\n");
    put(pkg, 'src/baseHas.ts', "import { x, type T } from '../../lib/h';\nexport { x as CALL } from '../../lib/h';\n");
    put(pkg, 'src/typeOnly.ts', "import type { T } from '../../lib/h';\n");
    put(pkg, 'src/deep/fileGone.ts', "import { z } from '../../../lib/gone';\n");
    put(pkg, 'src/local.ts', "import { x } from './baseHas';\n");
    put(pkg, 'src/surfaces/s/index.ts', "import { y } from '../../../../lib/h';\n");

    const pinned = pinMissingImports(pkg, wt, own);

    expect(pinned.sort()).toEqual(['src/deep/fileGone.ts: packages/lib/gone.ts', 'src/needsNew.ts: packages/lib/h.ts']);
    expect(readFileSync(join(pkg, 'src/needsNew.ts'), 'utf8')).toBe(`import { x, y as why } from '${join(own, 'packages/lib/h.ts')}';\n`);
    expect(readFileSync(join(pkg, 'src/deep/fileGone.ts'), 'utf8')).toBe(`import { z } from '${join(own, 'packages/lib/gone.ts')}';\n`);
    expect(readFileSync(join(pkg, 'src/baseHas.ts'), 'utf8')).toBe("import { x, type T } from '../../lib/h';\nexport { x as CALL } from '../../lib/h';\n");
    expect(readFileSync(join(pkg, 'src/typeOnly.ts'), 'utf8')).toBe("import type { T } from '../../lib/h';\n");
    expect(readFileSync(join(pkg, 'src/local.ts'), 'utf8')).toBe("import { x } from './baseHas';\n");
    expect(readFileSync(join(pkg, 'src/surfaces/s/index.ts'), 'utf8')).toBe("import { y } from '../../../../lib/h';\n");
  });
});

describe('pinMissingImports: a tool file reading a surface module', () => {
  test("today's tool importing what a commit's surface lacks reads this checkout's copy; the surface's own imports stay", () => {
    const wt = mkdtempSync(join(tmpdir(), 'line-pin-wt-'));
    const own = mkdtempSync(join(tmpdir(), 'line-pin-own-'));
    const pkg = join(wt, 'packages', 'evals');
    put(wt, 'packages/evals/src/surfaces/org/grade.ts', 'export const GRADE = 1;\n');
    put(own, 'packages/evals/src/surfaces/org/grade.ts', 'export const GRADE = 1;\nexport const moveIn = 2;\n');
    put(pkg, 'src/commands/label.ts', "import { GRADE, moveIn } from '../surfaces/org/grade';\n");
    put(pkg, 'src/commands/plain.ts', "import { GRADE } from '../surfaces/org/grade';\n");

    expect(pinMissingImports(pkg, wt, own)).toEqual(['src/commands/label.ts: packages/evals/src/surfaces/org/grade.ts']);
    expect(readFileSync(join(pkg, 'src/commands/label.ts'), 'utf8')).toBe(`import { GRADE, moveIn } from '${join(own, 'packages/evals/src/surfaces/org/grade.ts')}';\n`);
    expect(readFileSync(join(pkg, 'src/commands/plain.ts'), 'utf8')).toBe("import { GRADE } from '../surfaces/org/grade';\n");
  });
});

describe('checkArgs', () => {
  test("a line base run: the surfaces, the batch and the line's numbers, never the cadence state", () => {
    expect(checkArgs(['settle', 'title'], 'b1', { reps: 2, model: 'm', budget: 1.5, dry: true, notes: 'line base run' })).toEqual(['check', 'settle', 'title', '--batch', 'b1', '--no-state', '--reps', '2', '--model', 'm', '--budget', '1.5', '--dry', '--notes', 'line base run']);
  });

  test('a bisect probe: its freezes, the bisect cadence, the stop file and the time left', () => {
    expect(checkArgs(['settle'], 'x~abc', { freeze: ['f1', 'f2'], reps: 3, cadence: 'bisect', stopFile: '/h/stop', maxMinutes: 9, notes: 'bisect x' })).toEqual(['check', 'settle', '--batch', 'x~abc', '--no-state', '--freeze', 'f1', '--freeze', 'f2', '--reps', '3', '--cadence', 'bisect', '--stop-file', '/h/stop', '--max-minutes', '9', '--notes', 'bisect x']);
  });
});

describe('prepareTreeAt', () => {
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };

  test("a detached tree at a commit with a dirty rep's patch on top; the replayed moments stay this tree's; dropped clean", () => {
    const repo = mkdtempSync(join(tmpdir(), 'line-tree-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'line-tree-home-'));
    const saved = { root: process.env.CODECAST_EVALS_REPO_ROOT, home: process.env.CODECAST_EVALS_HOME };
    process.env.CODECAST_EVALS_REPO_ROOT = repo;
    process.env.CODECAST_EVALS_HOME = home;
    try {
      git(repo, 'init', '-q');
      put(repo, 'packages/app/prompt.ts', 'v1\n');
      put(repo, 'packages/evals/fixtures/case.json', 'moment v1\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'one');
      const sha = git(repo, 'rev-parse', 'HEAD');
      // The edits a dirty rep ran: the prompt and the fixture both moved.
      put(repo, 'packages/app/prompt.ts', 'v2 uncommitted\n');
      put(repo, 'packages/evals/fixtures/case.json', 'moment v2\n');
      const patch = join(home, 'edits.patch');
      writeFileSync(patch, `${git(repo, 'diff', '--binary', 'HEAD')}\n`);
      put(repo, 'packages/evals/fixtures/case.json', 'moment today\n');

      const { wt } = prepareTreeAt(sha, { patch, prefix: 'bisect-' });
      expect(wt.startsWith(join(home, 'scratch', 'bisect-'))).toBe(true);
      expect(readFileSync(join(wt, 'packages/app/prompt.ts'), 'utf8')).toBe('v2 uncommitted\n');
      expect(readFileSync(join(wt, 'packages/evals/fixtures/case.json'), 'utf8')).toBe('moment today\n');
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(sha);
      expect(git(repo, 'worktree', 'list')).toContain(wt);

      dropBaseTree(wt);
      expect(existsSync(wt)).toBe(false);
      expect(git(repo, 'worktree', 'list')).not.toContain(wt);
      // A patch that does not apply leaves no tree behind.
      writeFileSync(patch, 'not a patch\n');
      expect(() => prepareTreeAt(sha, { patch, prefix: 'bisect-' })).toThrow();
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    } finally {
      for (const [k, v] of [['CODECAST_EVALS_REPO_ROOT', saved.root], ['CODECAST_EVALS_HOME', saved.home]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    // A dozen git processes: seconds on a loaded machine.
  }, 60_000);
});
