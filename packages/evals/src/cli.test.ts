import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFixtureRun } from '@platform/evals/fixture';

import { auditPublicTree } from './adapters/freezes';
import { REPO_ROOT } from './paths';
import { EVALS_SNIPPET, REPO_NOTES } from './snippet';
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
    for (const cmd of ['convo', 'freeze', 'runs', 'status', 'check', 'stale', 'line', 'snapshot', 'grade', 'capture', 'doctor', 'snippet', 'publish']) expect(r.out).toContain(`  ${cmd}`);
    // No simulation launcher is wired here, so there is no `sim` command to advertise.
    expect(r.out).not.toContain('  sim ');
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

  test('output through a pipe arrives whole past 64 KiB', () => {
    const w = world();
    for (let i = 0; i < 300; i++) writeFixtureRun(join(w.home, 'runs'), { id: `weekend-seed${i}-2026-03-05T18-00-00-000Z` });
    const r = w.run('runs', 'list', '--json', '--limit', '1000');
    expect(r.code).toBe(0);
    expect(r.out.length).toBeGreaterThan(65_536);
    expect(JSON.parse(r.out)).toHaveLength(300);
  });

  test('a bad argument to the stale precheck is one line and exit 2, never the 1 that means nothing changed', () => {
    const w = world();
    for (const [arg, says] of [['--bogus', 'stale has no option --bogus'], ['bogus', 'no surface bogus'], ['--budget=abc', '--budget takes a positive number, not "abc"']]) {
      const r = w.run('stale', arg!);
      expect(r.code).toBe(2);
      expect(r.err.trim().split('\n')).toEqual([expect.stringContaining(says!)]);
    }
  });

  test('a mistyped command is an unknown command with a suggestion, not the status view', () => {
    const r = world().run('chek');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("unknown command 'chek'");
    expect(r.err).toContain('check');
    expect(r.out).not.toContain('surface');
  });

  test('--budget and --reps refuse anything but a positive number, so no spend check is silently off', () => {
    const w = world();
    w.run('freeze', 'create', 'echo@fixture:a');
    expect(w.run('check', 'echo', '--budget', '5usd').err).toContain('--budget takes a positive number, not "5usd"');
    expect(w.run('check', 'echo', '--reps', 'abc').err).toContain('--reps takes a positive whole number, not "abc"');
    expect(runDirs(w)).toEqual([]);
  });

  test('check --dry writes one run per rep, which runs and freeze results read', () => {
    const w = world();
    const id = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:a', '--json').out);
    const r = w.run('check', 'echo', '--dry', '--reps', '3', '--freeze', id.slice(0, 8));
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry: 3 rep(s) ran through the wiring');
    expect(runDirs(w)).toHaveLength(3);
    // A dry rep is never a pass or a fail: no view counts it, and no check takes it for a baseline.
    const listed = JSON.parse(w.run('runs', 'list', '--since', '1d', '--json').out) as Array<{ freezeId: string; status: string; model: string; startedAt: string; createdAt: string; batch: string | null }>;
    expect(listed).toHaveLength(3);
    expect(listed.every((x) => x.freezeId === id && x.status === 'dry' && x.model === echoMeta.model)).toBe(true);
    // Each listed rep names its check, so two checks on one day with the same notes stay apart.
    expect(new Set(listed.map((x) => x.batch)).size).toBe(1);
    expect(listed[0]!.batch).toBeTruthy();
    // A replay runs now on a moment frozen on 2026-01-01: it starts, and lists, when it ran.
    expect(listed.every((x) => x.startedAt === x.createdAt)).toBe(true);
    const results = JSON.parse(w.run('freeze', 'results', id.slice(0, 8), '--json').out) as { replays: Array<{ verdict: { gates: Array<{ id: string; pass: boolean }> } }> };
    expect(results.replays).toHaveLength(3);
    const gates = results.replays[0]!.verdict.gates.map((g) => `${g.id}:${g.pass}`);
    expect(gates).toEqual(['model-as-pinned:true', 'ok:true', 'prod-budget:true', 'echoed:true']);
    const run = JSON.parse(readFileSync(join(w.home, 'runs', runDirs(w)[0]!, 'run.json'), 'utf8'));
    expect(run).toMatchObject({ freezeId: id, route: 'call', dry: true, temperatureProd: [0], temperatureReplay: 'cli-default', liveReads: 0, judgeModel: 'claude-sonnet-5-5' });
  });

  test('check --parallel runs every rep of every freeze through one pool', () => {
    const w = world();
    writeFileSync(join(w.pkg, 'fixtures', 'echo', 'b.json'), JSON.stringify({ asOf: '2026-01-01T00:00:00.000Z', snapshot: { text: 'and this' } }, null, 2));
    w.git('add', '-A');
    w.git('commit', '-qm', 'second fixture');
    w.run('freeze', 'create', 'echo@fixture:a');
    w.run('freeze', 'create', 'echo@fixture:b');
    const r = w.run('check', 'echo', '--dry', '--reps', '3', '--parallel', '4');
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry: 6 rep(s) ran through the wiring');
    expect(runDirs(w)).toHaveLength(6);
    expect(new Set(runDirs(w).map((d) => d.replace(/-\d{4}-\d{2}-\d{2}T.*$/, ''))).size).toBe(6);
    expect(w.run('check', 'echo', '--parallel', '0').err).toContain('--parallel takes a positive whole number, not "0"');
  });

  test('a time stop over a parallel pool writes one stop and exits 3 with the surface left stale', () => {
    const w = world();
    w.run('freeze', 'create', 'echo@fixture:a');
    const r = w.run('check', 'echo', '--dry', '--reps', '4', '--parallel', '4', '--max-minutes', '0.000001');
    expect(r.code).toBe(3);
    expect(r.out).toContain('minute limit passed');
    expect(r.out).toContain('never reached: echo');
    expect(runDirs(w)).toHaveLength(1);
    expect(w.run('stale', 'echo').code).toBe(0);
  });

  test('check refuses before running when the estimate is over --budget', () => {
    const w = world();
    w.run('freeze', 'create', 'echo@fixture:a');
    const r = w.run('check', 'echo', '--budget', '0.0001');
    expect(r.code).toBe(1);
    expect(r.out).toContain('refused: the estimate');
    expect(runDirs(w)).toEqual([]);
  });

  test('check --stale refuses a surface over the budget on its own, and the precheck stays quiet about it at that budget', () => {
    const w = world();
    w.run('freeze', 'create', 'echo@fixture:a');
    const r = w.run('check', 'echo', '--stale', '--budget', '0.0001');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refused: echo \(\$[\d.]+\) alone over the --budget/);
    expect(r.out).toContain('not retried until their sources change');
    expect(runDirs(w)).toEqual([]);
    expect(w.run('stale', 'echo', '--budget', '0.0001').code).toBe(1);
    expect(w.run('stale', 'echo', '--budget', '5').code).toBe(0);
  });

  test('check --cadence stamps every rep with the standing run it belongs to', () => {
    const w = world();
    const id = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:a', '--json').out);
    expect(w.run('check', 'echo', '--dry', '--reps', '1', '--freeze', id.slice(0, 8), '--cadence', 'nightly').code).toBe(0);
    const [dir] = runDirs(w);
    expect(JSON.parse(readFileSync(join(w.home, 'runs', dir!, 'run.json'), 'utf8')).cadence).toBe('nightly');
    const runs = JSON.parse(w.run('runs', 'list', '--json').out) as Array<{ cadence?: string | null }>;
    expect(runs.map((r) => r.cadence)).toEqual(['nightly']);
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

  test('a resumed batch runs a crashed seed again, and the set counts that seed once', () => {
    const w = world();
    const boom = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:boom', '--json').out);
    const first = w.run('check', 'echo', '--dry', '--reps', '1', '--freeze', boom.slice(0, 8), '--batch', 'b1');
    expect(first.out).toContain('1 crashed, left out of the numbers above');
    const again = w.run('check', 'echo', '--dry', '--reps', '1', '--freeze', boom.slice(0, 8), '--batch', 'b1');
    expect(again.out).not.toContain('already scored');
    expect(again.out).toContain('1 reps over 1 surface(s)');
    expect(again.out).toContain('1 crashed');
    expect(runDirs(w)).toHaveLength(2);
  });

  test('line --dry: base and branch runs, eval-result.json, exit by the station rule', () => {
    const w = world();
    w.git('branch', 'base');
    const out = join(w.home, 'eval-result.json');
    const nothing = w.run('line', '--base', 'base', '--dry', '--out', out);
    expect(nothing.code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).surfaces).toEqual([]);

    writeFileSync(join(w.pkg, 'src', 'testSurface.ts'), '// the change under test\n', { flag: 'a' });
    w.git('commit', '-qam', 'edit the surface');
    expect(w.run('stale', '--base', 'base', '--list').out.trim().split('\n')).toEqual(['echo']);
    // A touched surface nobody has frozen is skipped, said so, and does not fail the station.
    const unfrozen = w.run('line', '--base', 'base', '--dry', '--out', out);
    expect(unfrozen.code).toBe(0);
    expect(unfrozen.out).toContain('skip echo  no freezes to replay; make one with ./evals freeze create echo@<ref>');
    const skipped = JSON.parse(readFileSync(out, 'utf8'));
    expect(skipped.ok).toBe(true);
    expect(skipped.surfaces).toEqual([expect.objectContaining({ surface: 'echo', ok: true, base: null, branch: null, reasons: [], skipped: expect.stringContaining('no freezes to replay') })]);
    expect(runDirs(w)).toEqual([]);

    const id = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:a', '--json').out);
    // The dry echo passes on the base too: a "proven" freeze that shows no
    // miss on the base fails the station (P9 step 2), with its base verdict.
    const r = w.run('line', '--base', 'base', '--dry', '--reps', '2', '--freeze', id.slice(0, 8), '--out', out);
    expect(r.err).toBe('');
    expect(r.code).toBe(1);
    const res = JSON.parse(readFileSync(out, 'utf8'));
    expect(res).toMatchObject({ version: 1, base: { ref: 'base' }, dry: true, ok: false });
    expect(res.surfaces).toHaveLength(1);
    expect(res.surfaces[0]).toMatchObject({ surface: 'echo', separation: 'too-few', gatesFailed: [], crashes: 0, flips: [], ok: false, proven: [{ freeze: id, basePasses: true, passes: true }] });
    expect(res.surfaces[0].reasons).toEqual([expect.stringContaining(`proven freeze ${id.slice(0, 8)} already passes on the base`)]);
    expect(res.surfaces[0].base).toMatchObject({ reps: 2, passed: 2 });
    expect(res.surfaces[0].branch).toMatchObject({ reps: 2, passed: 2 });
    // The base ran in a worktree that is gone, and neither side moved the cadence state.
    expect(readdirSync(join(w.home, 'scratch'))).toEqual([]);
    expect(existsSync(join(w.home, 'state.json'))).toBe(false);

    const boom = freezeIdOf(w.run('freeze', 'create', 'echo@fixture:boom', '--json').out);
    const failed = w.run('line', '--base', 'base', '--dry', '--reps', '1', '--freeze', boom.slice(0, 8), '--out', out);
    expect(failed.code).toBe(1);
    const bad = JSON.parse(readFileSync(out, 'utf8')).surfaces[0];
    expect(bad.ok).toBe(false);
    expect(bad.reasons).toContain(`proven freeze ${boom.slice(0, 8)} still fails`);
    expect(bad.reasons).toContain('1 rep(s) crashed');
  }, 480_000);

  // Only what applies in codecast reaches AGENTS.md: no channels, phones or
  // simulations, and nothing it then has to tell the reader to ignore.
  test('snippet show is the codecast reference alone', () => {
    const w = world();
    const r = w.run('snippet', 'show');
    expect(r.code).toBe(0);
    expect(r.out).toBe(EVALS_SNIPPET.trimStart());
    expect(r.out).toContain(REPO_NOTES.trim());
    for (const absent of ['--channel', 'imessage', 'freeze sim', 'sim run', 'Ignore']) expect(r.out).not.toContain(absent);
  });
});
