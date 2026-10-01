import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evalsSnippet } from '@platform/evals/snippet';
import { writeFixtureRun } from '@platform/evals/fixture';

import { auditPublicTree } from './adapters/freezes';
import { REPO_ROOT } from './paths';
import { REPO_NOTES } from './snippet';
import { sourceHashes, writeState } from './state';
import { echoMeta } from './testSurface';

// The CLI end to end, as a subprocess, with no auth, no network and no model:
// a scratch git repo stands in for the checkout (its packages/evals holds the
// echo fixtures and freezes) and a scratch EVALS_HOME holds everything else.

// Each test spawns the CLI a few times; on a loaded machine one spawn can take seconds.
setDefaultTimeout(120_000);

const INDEX = join(REPO_ROOT, 'packages', 'evals', 'src', 'index.ts');

interface World {
  repo: string;
  home: string;
  pkg: string;
  run(...args: string[]): { code: number; out: string; err: string };
  git(...args: string[]): void;
}

function world(): World {
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

const freezeIdOf = (out: string): string => {
  const f = JSON.parse(out) as { id: string };
  return f.id;
};
const runDirs = (w: World) => (existsSync(join(w.home, 'runs')) ? readdirSync(join(w.home, 'runs')) : []);
const withHash = (w: World, patch: Record<string, unknown> = {}) => {
  process.env.CODECAST_EVALS_HOME = w.home;
  try {
    writeState({ echo: { lastRunHash: sourceHashes([echoMeta], w.repo).get('echo')!, ...patch } });
  } finally {
    delete process.env.CODECAST_EVALS_HOME;
  }
};

describe('./evals', () => {
  test('help needs no auth and names every group', () => {
    const w = world();
    const r = w.run('--help');
    expect(r.code).toBe(0);
    for (const cmd of ['convo', 'freeze', 'runs', 'sim', 'status', 'check', 'stale', 'snapshot', 'grade', 'capture', 'doctor', 'snippet', 'publish']) expect(r.out).toContain(`  ${cmd}`);
  });

  test('runs show reads a run in the platform layout from EVALS_HOME', () => {
    const w = world();
    writeFixtureRun(join(w.home, 'runs'));
    const r = w.run('runs', 'show', 'weekend');
    expect(r.code).toBe(0);
    expect(r.out).toContain('The weekend, with the room in it');
  });

  test('freeze create on a fixture writes a public freeze the guard passes', () => {
    const w = world();
    const r = w.run('freeze', 'create', 'echo@fixture:a', '--json');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const f = JSON.parse(r.out);
    expect(f.meta).toEqual({ surface: 'echo', visibility: 'public', snapshot: 'fixtures/echo/a.json' });
    expect(f.subject).toEqual({ kind: 'synthetic', id: 'echo:a', title: 'echo a' });
    expect(f.judge).toBe('the reply repeats the prompt');
    expect(readdirSync(join(w.pkg, 'freezes'))).toEqual([`${f.id}.json`]);
    expect(auditPublicTree(w.pkg)).toEqual([]);
    expect(existsSync(join(w.home, 'freezes'))).toBe(false);
  });

  test('an unknown surface errors with every ref form', () => {
    const w = world();
    const r = w.run('freeze', 'create', 'nope@x');
    expect(r.code).toBe(1);
    expect(r.err).toContain('nope is not a surface');
    expect(r.err).toContain('title@ needs a session and line, like title@jx7c6zk:142');
    expect(r.err).toContain('org-review@');
    expect(r.err.trim().split('\n')).toHaveLength(1);
  });

  test('check --dry writes one run per rep, which runs and freeze results read', () => {
    const w = world();
    const id = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:a', '--json').out);
    const r = w.run('check', 'echo', '--dry', '--reps', '3', '--freeze', id.slice(0, 8));
    expect(r.code).toBe(0);
    expect(r.out).toContain('pass 3/3');
    expect(runDirs(w)).toHaveLength(3);
    const listed = JSON.parse(w.run('runs', 'list', '--json').out) as Array<{ freezeId: string; status: string; model: string }>;
    expect(listed).toHaveLength(3);
    expect(listed.every((x) => x.freezeId === id && x.status === 'pass' && x.model === echoMeta.model)).toBe(true);
    const results = JSON.parse(w.run('freeze', 'results', id.slice(0, 8), '--json').out) as { replays: Array<{ verdict: { gates: Array<{ id: string; pass: boolean }> } }> };
    expect(results.replays).toHaveLength(3);
    const gates = results.replays[0]!.verdict.gates.map((g) => `${g.id}:${g.pass}`);
    expect(gates).toEqual(['model-as-pinned:true', 'ok:true', 'prod-budget:true', 'echoed:true']);
    const run = JSON.parse(readFileSync(join(w.home, 'runs', runDirs(w)[0]!, 'run.json'), 'utf8'));
    expect(run).toMatchObject({ freezeId: id, route: 'call', temperatureProd: 0, temperatureReplay: 'cli-default', judgeModel: 'claude-sonnet-5-5' });
  });

  test('check refuses before running when the estimate is over --budget', () => {
    const w = world();
    w.run('freeze', 'create', 'echo@fixture:a');
    const r = w.run('check', 'echo', '--budget', '0.0001');
    expect(r.code).toBe(1);
    expect(r.out).toContain('refused: the estimate');
    expect(runDirs(w)).toEqual([]);
  });

  test('stale: exit 0 when a source moved at HEAD since the last run, 1 when not', () => {
    const w = world();
    expect(w.run('stale', 'echo').code).toBe(0);
    withHash(w);
    const quiet = w.run('stale', 'echo');
    expect(quiet.code).toBe(1);
    expect(quiet.out).toContain('nothing changed');
    writeFileSync(join(w.pkg, 'src', 'testSurface.ts'), '// edited\n', { flag: 'a' });
    expect(w.run('stale', 'echo').code).toBe(1);
    w.git('commit', '-qam', 'edit the surface');
    const moved = w.run('stale', 'echo', '--list');
    expect(moved.code).toBe(0);
    expect(moved.out.trim()).toBe('echo');
  });

  test('check --stale with nothing stale runs nothing', () => {
    const w = world();
    w.run('freeze', 'create', 'echo@fixture:a');
    withHash(w);
    const r = w.run('check', 'echo', '--stale', '--dry');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('nothing changed');
    expect(runDirs(w)).toEqual([]);
  });

  test('check --stale skips a surface whose sources are dirty in the checkout', () => {
    const w = world();
    w.run('freeze', 'create', 'echo@fixture:a');
    writeFileSync(join(w.pkg, 'src', 'testSurface.ts'), '// half saved\n', { flag: 'a' });
    const r = w.run('check', 'echo', '--stale', '--dry');
    expect(r.code).toBe(0);
    expect(r.out).toContain('skipped echo: its sources are dirty in the checkout');
    expect(runDirs(w)).toEqual([]);
    // The precheck agrees with check --stale: a stale surface that would be
    // skipped as dirty never spends a trigger run, and counts once committed.
    const gate = w.run('stale', 'echo');
    expect(gate.code).toBe(1);
    expect(gate.out).toContain('stale    echo (call): sources dirty in the checkout, waits for a commit');
    expect(w.run('stale', 'echo', '--list').out.trim()).toBe('');
    w.git('commit', '-qam', 'land the edit');
    expect(w.run('stale', 'echo').code).toBe(0);
  });

  test('two crashes on the same sources block the surface', () => {
    const w = world();
    const boom = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:boom', '--json').out);
    for (let i = 0; i < 2; i++) {
      const r = w.run('check', 'echo', '--dry', '--reps', '1', '--freeze', boom.slice(0, 8));
      expect(r.code).toBe(1);
      expect(r.out).toContain('1 crashed');
    }
    const state = JSON.parse(readFileSync(join(w.home, 'state.json'), 'utf8'));
    expect(state.echo.crash.count).toBe(2);
    const r = w.run('stale', 'echo');
    expect(r.code).toBe(1);
    expect(r.out).toContain('blocked  echo');
    expect(JSON.parse(w.run('runs', 'list', '--json').out).map((x: { status: string }) => x.status)).toEqual(['crash', 'crash']);
  });

  test('snippet show is the platform snippet with codecast notes', () => {
    const w = world();
    const r = w.run('snippet', 'show');
    expect(r.code).toBe(0);
    expect(r.out).toBe(evalsSnippet({ name: 'evals', repoNotes: REPO_NOTES }).trimStart());
  });
});
