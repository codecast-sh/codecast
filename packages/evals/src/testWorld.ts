import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT } from './paths';

// The CLI as a subprocess in a scratch world, for tests: a scratch git repo
// stands in for the checkout (its packages/evals holds the echo fixtures and
// freezes) and a scratch EVALS_HOME holds everything else. No auth, no
// network, no model.

const INDEX = join(REPO_ROOT, 'packages', 'evals', 'src', 'index.ts');

export interface World {
  repo: string;
  home: string;
  pkg: string;
  run(...args: string[]): { code: number; out: string; err: string };
  git(...args: string[]): void;
}

export function world(): World {
  const repo = mkdtempSync(join(tmpdir(), 'evals-cli-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'evals-cli-home-'));
  const pkg = join(repo, 'packages', 'evals');
  mkdirSync(join(pkg, 'freezes'), { recursive: true });
  mkdirSync(join(pkg, 'fixtures', 'echo'), { recursive: true });
  mkdirSync(join(pkg, 'src'), { recursive: true });
  cpSync(join(REPO_ROOT, 'packages', 'evals', 'src', 'testSurface.ts'), join(pkg, 'src', 'testSurface.ts'));
  writeFileSync(join(pkg, 'fixtures', 'echo', 'a.json'), JSON.stringify({ asOf: '2026-01-01T00:00:00.000Z', snapshot: { text: 'say this back' }, judge: 'the reply repeats the prompt' }, null, 2));
  writeFileSync(join(pkg, 'fixtures', 'echo', 'boom.json'), JSON.stringify({ asOf: '2026-01-01T00:00:00.000Z', snapshot: { text: 'never sent', crash: true } }, null, 2));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'scratch');
  const env = { ...process.env, CODECAST_EVALS_HOME: home, CODECAST_EVALS_REPO_ROOT: repo, CODECAST_EVALS_TEST: '1', CODECAST_DIR: mkdtempSync(join(tmpdir(), 'evals-cli-nocast-')), NO_COLOR: '1', FORCE_COLOR: '0' };
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(['bun', INDEX, ...args], { env, cwd: repo });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  return { repo, home, pkg, run, git };
}

export const freezeIdOf = (out: string): string => (JSON.parse(out) as { id: string }).id;

export const runDirs = (w: World): string[] => (existsSync(join(w.home, 'runs')) ? readdirSync(join(w.home, 'runs')) : []);
