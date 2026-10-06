import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EVALS_ROUTE_KEYS, matchEvalsRoute, runRowProblems, type EvalsBridgeResponse, type EvalsRouteKey, type RunRow } from '@codecast/shared/contracts/evalsApi';

import { harnessExit, harnessTookMs, thenFiles, unitDirs } from '../layout';
import { REPO_ROOT } from '../paths';
import { notComparedOf, simGrid, simReplay, simSessions } from './simHistory';
import { guardEntriesOf } from './files';
import { bisectPlanArgs, bisectStartArgs } from './bisects';
import { bisectCommand } from '../../../web/store/__tests__/sim/replay';

// The api child driven the way the daemon drives it: one process, one JSON
// request per stdin line, answers matched by id. The world is a scratch git
// repo standing in for the checkout's tree, a scratch EVALS_HOME and sim
// home, and a fake `tmux` and eval tool first on PATH that only record the
// argv they were given, so no bisect, shrink or sweep ever runs.

// The machine this runs on is often loaded; a request can wait seconds for a CPU.
setDefaultTimeout(60_000);

// The bridge's own command: the tool's entry, `api --stdio`.
const API = join(REPO_ROOT, 'packages', 'evals', 'src', 'index.ts');
const DAY = 86_400_000;
const F = 'f0e1d2c3-0000-4000-8000-000000000001';
const G = 'a1b2c3d4-0000-4000-8000-000000000002';
const SIM_SESSION = '2026-10-01T10-00-00-000Z-1234';
const SIM_RUN = 'demoScenario-interleave-7';

let repo: string;
let home: string;
let simHome: string;
let bin: string;
let recorded: string;
let proc: ReturnType<typeof Bun.spawn>;
let nextId = 0;
const waiting = new Map<number, (r: EvalsBridgeResponse) => void>();
const stray: string[] = [];
const sha = { c1: '', c2: '' };
const batch = { a: '', b: '' };

const json = (path: string, v: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 1));
};
/** writeFileSync that makes the parent dirs first. */
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const stampOf = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-');

function git(...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: process.env.T_DATE ?? '', GIT_COMMITTER_DATE: process.env.T_DATE ?? '' } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

interface Rep {
  freeze: string;
  seed: number;
  at: number;
  batch: string;
  head: string;
  pass: boolean;
  promptSha: string;
  prompt: string;
  agent?: boolean;
  log?: string;
  versions?: boolean;
}

/** One echo rep in the layout writeRunFolder and the harness leave. */
function writeRep(r: Rep): string {
  const id = `echo-${r.freeze.slice(0, 8)}-seed${r.seed}-${stampOf(r.at)}`;
  const dir = join(home, 'runs', id);
  const reply = r.pass ? 'say this back' : 'something else';
  json(join(dir, 'run.json'), { freezeId: r.freeze, notes: null, model: 'claude-haiku-4-5-20251001', route: 'call', sourceHash: `s-${r.head.slice(0, 6)}`, sourceHashDisk: `d-${r.head.slice(0, 6)}`, treePatch: null, freezeSha: 'fz1', promptSha: r.promptSha, judgeModel: null, budgetUsd: null, gitHead: r.head, dirty: false, dry: false, temperatureProd: [0], temperatureReplay: 'cli-default', liveReads: 0, batch: r.batch, cadence: null, title: 'echo a' });
  json(join(dir, 'result.json'), { scenario: `echo-${r.freeze.slice(0, 8)}`, seed: r.seed, title: 'echo a', startedAt: new Date(r.at).toISOString(), endedBecause: 'done', stopReason: null, steps: 1, virtualElapsedMs: 0, realElapsedMs: 900, costUsd: 0.002, captures: 1 });
  const score = { pass: r.pass, score: r.pass ? 1 : 0, passMark: 0.7, gates: [{ id: 'echoed', pass: r.pass, decidedBy: 'mechanical', evidence: { summary: r.pass ? 'the reply is the prompt' : 'the reply differs' } }], checks: [], missedFloors: [], judgeCostUsd: 0, judgeModel: null, scoredAt: new Date(r.at + 60_000).toISOString() };
  json(join(dir, 'score.json'), score);
  if (r.versions) {
    json(join(dir, `score.${stampOf(r.at + 30_000)}.json`), { ...score, score: 0.5, scoredAt: new Date(r.at + 30_000).toISOString() });
  }
  json(join(dir, 'sends.json'), [{ seq: 3, at: new Date(r.at).toISOString(), label: 'reply', rail: 'session', to: 'owner', text: reply, chars: reply.length, isGroup: false, audience: 'owner' }]);
  json(join(dir, 'captures.json'), [{ label: 'call1', request: {}, reply, stopReason: 'end_turn', modelUsage: {} }]);
  put(join(dir, 'events.jsonl'), '');
  json(join(dir, 'call1', 'request.json'), { model: 'claude-haiku-4-5-20251001', max_tokens: 50, temperature: 0, prompt: r.prompt });
  put(join(dir, 'call1', 'prompt.md'), r.prompt);
  json(join(dir, 'call1', 'run', 'out.json'), { result: reply, stop_reason: 'end_turn', total_cost_usd: 0.002, is_error: false, usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } });
  put(join(dir, 'call1', 'run', 'exit.txt'), '0');
  put(join(dir, 'call1', 'run', 'took.txt'), '2s');
  if (r.agent) {
    put(join(dir, 'agent1', 'prompt.md'), 'wake up');
    put(join(dir, 'agent1', 'then2.md'), 'and again');
    json(join(dir, 'agent1', 'agent', 'args.json'), { model: 'claude-sonnet-5-5', call: false, maxOutputTokens: null, tools: ['Bash'], maxTurns: 8, serve: '/served', guard: '/guard' });
    put(join(dir, 'agent1', 'agent', 'calls.log'), ['brief', 'SERVED brief', 'task show ct-1', 'LIVE task show ct-1', '# turn 2', 'task comment ct-1 done', 'REFUSED task comment ct-1 done', 'roster'].join('\n') + '\n');
    put(
      join(dir, 'agent1', 'agent', 'stream.jsonl'),
      [
        { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'thinking', thinking: 'look first' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cast brief' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'the brief' }] } },
        { type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'done for now' }] } },
      ].map((e) => JSON.stringify(e)).join('\n'),
    );
    json(join(dir, 'agent1', 'agent', 'said.json'), ['done for now']);
    json(join(dir, 'agent1', 'agent', 'out.json'), { result: 'done for now', total_cost_usd: 0.01, is_error: false, usage: { input_tokens: 500, output_tokens: 40 } });
    put(join(dir, 'brief.md'), 'the role brief');
  }
  if (r.log) put(join(dir, 'run.log'), r.log);
  return id;
}

function seedWorld(): void {
  repo = mkdtempSync(join(tmpdir(), 'evals-api-repo-'));
  home = mkdtempSync(join(tmpdir(), 'evals-api-home-'));
  simHome = mkdtempSync(join(tmpdir(), 'evals-api-sim-'));
  bin = mkdtempSync(join(tmpdir(), 'evals-api-bin-'));
  recorded = join(bin, 'argv.jsonl');
  const pkg = join(repo, 'packages', 'evals');
  // The scratch tree: the echo fixture, its public freeze, and the declared source.
  json(join(pkg, 'fixtures', 'echo', 'a.json'), { asOf: '2026-01-01T00:00:00.000Z', snapshot: { text: 'say this back' }, label: { verdict: 'echo it' } });
  json(join(pkg, 'freezes', `${F}.json`), { id: F, name: 'echo a', createdAt: '2026-09-01T00:00:00.000Z', anchor: { kind: 'message', id: 'fixture:a' }, subject: { kind: 'synthetic', id: 'echo:a', title: 'echo a' }, asOf: '2026-01-01T00:00:00.000Z', trigger: { type: 'echo' }, meta: { surface: 'echo', visibility: 'public', snapshot: 'fixtures/echo/a.json' }, judge: null, notes: null, tags: [] });
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'src', 'testSurface.ts'), '// v1\n');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: repo });
  const now = Date.now();
  process.env.T_DATE = new Date(now - 3 * DAY).toISOString();
  git('add', '-A');
  git('commit', '-qm', 'echo: first');
  sha.c1 = git('rev-parse', 'HEAD');
  writeFileSync(join(pkg, 'src', 'testSurface.ts'), '// v2: the prompt changed\n');
  process.env.T_DATE = new Date(now - 1.5 * DAY).toISOString();
  git('commit', '-qam', 'echo: change the prompt\n\nCodecast-Session: jx7test');
  sha.c2 = git('rev-parse', 'HEAD');

  // Two batches: a passes on c1, b fails on c2 with another rendered prompt.
  batch.a = new Date(now - 2 * DAY).toISOString();
  batch.b = new Date(now - 1 * DAY).toISOString();
  for (const seed of [1, 2, 3]) {
    writeRep({ freeze: F, seed, at: Date.parse(batch.a) + seed * 1000, batch: batch.a, head: sha.c1, pass: true, promptSha: 'p1', prompt: 'say this back', versions: seed === 1 });
    writeRep({ freeze: F, seed, at: Date.parse(batch.b) + seed * 1000, batch: batch.b, head: sha.c2, pass: false, promptSha: 'p2', prompt: 'say this back, but differently', agent: seed === 1, log: seed === 2 ? 'line one\nboom: it broke\n' : undefined });
  }
  // A symlink inside a run folder that points outside it.
  const firstB = `echo-${F.slice(0, 8)}-seed1-${stampOf(Date.parse(batch.b) + 1000)}`;
  symlinkSync(join(home, 'state.json'), join(home, 'runs', firstB, 'escape.json'));
  writeFileSync(join(home, 'state.json'), '{"secret":true}');
  json(join(home, 'freezes', `${G}.json`), { id: G, name: 'a private moment', createdAt: '2026-09-01T00:00:00.000Z', anchor: { kind: 'message', id: 'm' }, subject: { kind: 'session', id: 's', title: 'private' }, asOf: '2026-09-01T00:00:00.000Z', meta: { surface: 'echo', visibility: 'private', snapshot: 'echo/missing.json' }, judge: null, notes: null, tags: [] });

  // A bisect, mid-run, with three steps.
  const bdir = join(home, 'bisects', 'echo-20260930-100000');
  const t = new Date(now - 10 * 60_000).toISOString();
  const endpoint = { batch: batch.a, sha: sha.c1, mainSha: sha.c1, dirty: false, treePatch: null, footing: { model: 'm', ruler: null }, at: batch.a };
  json(join(bdir, 'state.json'), { id: 'echo-20260930-100000', surface: 'echo', seq: 3, status: 'probing', tier: 2, range: { good: sha.c1, bad: sha.c2 }, candidates: [], classes: null, probes: [], spentUsd: 0.4, budgetUsd: 2, startedAt: t, updatedAt: t, finishedAt: null, tmux: 'evals-bisect-echo-20260930-100000', answer: null, plan: { surface: 'echo', good: endpoint, bad: endpoint } });
  writeFileSync(join(bdir, 'steps.jsonl'), [1, 2, 3].map((seq) => JSON.stringify({ seq, at: t, kind: 'rep', sha: sha.c2, text: `rep ${seq}` })).join('\n') + '\n');
  writeFileSync(join(bdir, 'log.txt'), 'probe 1\nprobe 2\n');

  // A Multiplayer sim session with one failing run that was shrunk.
  const sdir = join(simHome, 'sessions', SIM_SESSION);
  json(join(sdir, 'session.json'), { id: SIM_SESSION, argv: ['demoScenario'], gitHead: sha.c2, dirty: false, treePatch: null, startedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:01:00.000Z', exit: 1 });
  writeFileSync(join(sdir, 'runs.jsonl'), [{ scenario: 'demoScenario', mode: 'scripted', seed: 1, passed: true, deliveries: 10, ms: 50 }, { scenario: 'demoScenario', mode: 'interleave', seed: 7, passed: false, deliveries: 4, ms: 60, dir: SIM_RUN }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const rdir = join(sdir, SIM_RUN);
  json(join(rdir, 'result.json'), { scenario: 'demoScenario', mode: 'interleave', seed: 7, step: 'settle #1', delivery: 4, invariant: { id: 'INV-followers', meaning: 'followers match' }, row: { table: 'tasks', id: 't1', label: 'task#1', diff: [{ field: 'title', server: 'a', replica: 'b' }] }, order: 'conn:w1 repl:w1>w2 sched', labels: {}, text: 'failed', minimalOrder: 'repl:w1>w2' });
  writeFileSync(join(rdir, 'events.jsonl'), [{ seq: 1, channel: 'conn:w1', due: 0, label: 'x', producer: 'p' }, { kind: 'step', seq: 0, verb: 'settle', actor: 'world', label: 'settle #1' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  json(join(rdir, 'world.json'), { scenario: 'demoScenario', mode: 'interleave', seed: 7, labels: {}, devices: [{ name: 'd1', windows: [{ name: 'w1', role: 'host', closed: false }] }] });
  json(join(rdir, 'final.json'), { deliveries: 4, writesSpent: 0, producers: {}, calls: [], actors: [], windowErrors: {} });
  json(join(rdir, 'minimal.json'), { order: ['repl:w1>w2'], removed: [0, 2], attempts: 9, ms: 1000, oneMinimal: true });
  const pdir = join(sdir, 'demoScenario-scripted-1');
  json(join(pdir, 'result.json'), { scenario: 'demoScenario', mode: 'scripted', seed: 1, passed: true, deliveries: 10 });

  // The fakes: tmux and the eval tool record their argv and do nothing else.
  writeFileSync(join(bin, 'tmux'), `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(recorded)}, JSON.stringify(['tmux', ...process.argv.slice(2)]) + '\\n');\nprocess.exit(process.argv[2] === 'has-session' ? 1 : 0);\n`);
  chmodSync(join(bin, 'tmux'), 0o755);
  writeFileSync(
    join(bin, 'tool.ts'),
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(recorded)}, JSON.stringify(['tool', ...process.argv.slice(2)]) + '\\n');\nconsole.log(JSON.stringify({ surface: process.argv[4], summary: 'canned plan', freezes: [], reps: 3 }));\n`,
  );
}

const recordedArgv = (): string[][] => (existsSync(recorded) ? readFileSync(recorded, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

async function pump(): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let r: EvalsBridgeResponse;
      try {
        r = JSON.parse(line) as EvalsBridgeResponse;
      } catch {
        stray.push(line);
        continue;
      }
      waiting.get(r.id)?.(r);
      waiting.delete(r.id);
    }
  }
}

function send(line: string, id: number): Promise<EvalsBridgeResponse> {
  const p = new Promise<EvalsBridgeResponse>((resolve) => waiting.set(id, resolve));
  const stdin = proc.stdin as import('bun').FileSink;
  stdin.write(`${line}\n`);
  stdin.flush();
  return p;
}

/** Every contract route this file has had a 200 from, so the last test can hold the file to driving them all. */
const answered = new Set<EvalsRouteKey>();
const call = async (method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body?: unknown): Promise<EvalsBridgeResponse> => {
  const id = ++nextId;
  const r = await send(JSON.stringify({ id, method, path, query, ...(body !== undefined ? { body } : {}) }), id);
  const key = matchEvalsRoute(method, path)?.key;
  if (key && r.status === 200) answered.add(key);
  return r;
};
const ok = async <T>(method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> => {
  const r = await call(method, path, query, body);
  if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
};

let runs: RunRow[] = [];
const runOf = (b: string, seed: number) => runs.find((r) => r.batch === b && r.seed === seed)!;

beforeAll(async () => {
  seedWorld();
  proc = Bun.spawn(['bun', API, 'api', '--stdio'], {
    cwd: repo,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODECAST_EVALS_HOME: home, CODECAST_EVALS_REPO_ROOT: repo, CODECAST_EVALS_TEST: '1', CODECAST_SIM_HOME: simHome, CODECAST_EVALS_API_TOOL: join(bin, 'tool.ts'), CODECAST_DIR: mkdtempSync(join(tmpdir(), 'evals-api-nocast-')), NO_COLOR: '1' },
  });
  void pump();
  void new Response(proc.stderr as ReadableStream).text().then((t) => {
    if (t.trim()) process.stderr.write(`api child stderr:\n${t}\n`);
  });
  runs = (await ok<{ runs: RunRow[] }>('GET', '/surface/echo')).runs;
}, 120_000);

afterAll(async () => {
  (proc.stdin as import('bun').FileSink).end();
  await proc.exited;
  for (const d of [repo, home, simHome, bin]) rmSync(d, { recursive: true, force: true });
});

describe('the stdio protocol', () => {
  test('every answer is a JSON line matched by id; nothing else reaches stdout', async () => {
    const [a, b] = await Promise.all([call('GET', '/health'), call('GET', '/bisects')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(stray).toEqual([]);
  });

  test('a line that is not JSON, a missing id and an unknown route are refused, not fatal', async () => {
    const bad = await send('not json', -1);
    expect(bad.status).toBe(400);
    expect((await call('GET', '/nope')).status).toBe(404);
    const noMethod = await send(JSON.stringify({ id: 9001, method: 'DELETE', path: '/health' }), 9001);
    expect(noMethod.status).toBe(400);
    expect((await call('GET', '/health')).status).toBe(200);
  });

});

describe('GET routes against a fixture EVALS_HOME', () => {
  test('/health names the checkout, the home and this process', async () => {
    const h = await ok<{ root: string; evalsHome: string; pid: number; runsIndexed: number; index: { state: string } }>('GET', '/health');
    expect(h.root).toBe(REPO_ROOT);
    expect(h.evalsHome).toBe(home);
    expect(h.pid).toBeGreaterThan(0);
    expect(h.runsIndexed).toBe(6);
    expect(h.index.state).toBe('warm');
  });

  test('/overview: the echo row has both batches, its verdict and its spend; the bisect and the sim session ride along', async () => {
    const o = await ok<any>('GET', '/overview', { cadence: 'all' });
    expect(o.cadence).toBe('all');
    const echo = o.surfaces.find((s: any) => s.id === 'echo');
    expect(echo.strip.map((s: any) => s.batch)).toEqual([batch.a, batch.b]);
    // Six reps, but the strip draws one dot per status and pixel row of score: three passes at 1, three fails at 0.
    expect(echo.dots.map((d: any) => [d.batch, d.status, d.score])).toEqual([
      [batch.a, 'pass', 1],
      [batch.b, 'fail', 0],
    ]);
    expect(echo.latest.batch).toBe(batch.b);
    expect(echo.latest.flips.map((f: any) => f.direction)).toEqual(['broke']);
    expect(echo.freezes).toEqual({ public: 1, private: 1 });
    // The row's spend per day, summed by the wall over its own window like the total below.
    expect(echo.spendByDay.reduce((t: number, d: any) => t + d.usd + d.judgeUsd, 0)).toBeCloseTo(0.012, 6);
    for (const d of echo.spendByDay) expect(d.usd + d.judgeUsd).toBeLessThanOrEqual(o.spendByDay.find((t: any) => t.day === d.day).usd + o.spendByDay.find((t: any) => t.day === d.day).judgeUsd + 1e-9);
    expect(['fresh', 'stale', 'waiting', 'due', 'blocked']).toContain(echo.staleness);
    expect(o.surfaces.length).toBe(15);
    expect(o.moved.some((m: any) => m.kind === 'flips' && m.surface === 'echo' && m.broke === 1)).toBe(true);
    expect(o.bisects.map((b: any) => b.id)).toEqual(['echo-20260930-100000']);
    expect(o.sim.id).toBe(SIM_SESSION);
    expect(o.spendByDay.length).toBe(2);
  }, 60_000);

  test('/overview with a cadence filter keeps only that cadence', async () => {
    const o = await ok<any>('GET', '/overview', { cadence: 'nightly' });
    expect(o.surfaces.find((s: any) => s.id === 'echo').strip).toEqual([]);
  });

  test('/surface/:id: rows that hold the contract, two batches, epochs, the ledger flip, and the commit that touched the sources', async () => {
    const s = await ok<any>('GET', '/surface/echo');
    expect(s.runs.length).toBe(6);
    for (const r of s.runs) expect(runRowProblems(r)).toEqual([]);
    expect(s.batches.map((b: any) => b.batch)).toEqual([batch.a, batch.b]);
    expect(s.epochs.length).toBe(2);
    const row = s.ledger.find((l: any) => l.freezeId === F);
    expect(row.flips).toBe(1);
    expect(row.cells[batch.b].flip).toBe('broke');
    expect(row.cells[batch.a].majority).toBe(true);
    expect(s.commits.map((c: any) => c.sha)).toContain(sha.c2);
    expect(s.commits.find((c: any) => c.sha === sha.c2).session).toBe('jx7test');
    expect(s.surface.freezes).toEqual({ public: 1, private: 1 });
    // The latest batch weighed as the wall weighs it, so the page can say what brought the investigator here.
    expect(s.latest.batch).toBe(batch.b);
    expect(s.latest.baseline.batches).toEqual([batch.a]);
  });

  test('/surface/:id refuses a surface the registry does not have', async () => {
    const r = await call('GET', '/surface/nope');
    expect(r.status).toBe(404);
    expect((r.body as any).reason).toBe('not-found');
  });

  test('/freeze/:id: the moment from the surface describe(), the inline label, its runs and epochs', async () => {
    const f = await ok<any>('GET', `/freeze/${F}`);
    expect(f.freeze.visibility).toBe('public');
    expect(f.moment.map((m: any) => m.text)).toEqual(['say this back']);
    expect(f.cutAt).toBe(1);
    expect(f.label).toEqual({ verdict: 'echo it' });
    expect(f.labelSource).toBe('inline');
    expect(f.runs.length).toBe(6);
    expect(f.epochs.length).toBe(2);
    expect((await call('GET', '/freeze/ffffffff-0000-4000-8000-00000000ffff')).status).toBe(404);
    expect((await call('GET', '/freeze/..%2F..%2Fstate')).status).toBe(400);
  });

  test('/run/:id: the call, its tokens, the agent turns, the guard log, score versions, siblings and neighbours', async () => {
    const a1 = runOf(batch.a, 1);
    const b1 = runOf(batch.b, 1);
    const r = await ok<any>('GET', `/run/${b1.id}`);
    expect(r.row.id).toBe(b1.id);
    expect(r.calls[0]).toMatchObject({ n: 1, dir: 'call1', prompt: 'say this back, but differently', reply: 'something else', stopReason: 'end_turn', tokens: { input: 120, output: 8, cacheRead: 100, cacheWrite: 0 }, costUsd: 0.002, realMs: 2000 });
    expect(r.agents[0].then).toEqual(['and again']);
    expect(r.agents[0].turns[0].map((i: any) => i.kind)).toEqual(['thinking', 'tool', 'text']);
    expect(r.agents[0].turns[0][1]).toMatchObject({ name: 'Bash', output: 'the brief', isError: false });
    expect(r.agents[0].brief).toBe('the role brief');
    expect(r.agents[0].args.maxTurns).toBe(8);
    expect(r.guard.map((g: any) => [g.turn, g.status, g.argv])).toEqual([
      [1, 'SERVED', 'brief'],
      [1, 'LIVE', 'task show ct-1'],
      [2, 'REFUSED', 'task comment ct-1 done'],
      [2, null, 'roster'],
    ]);
    expect(r.score.gates[0].id).toBe('echoed');
    expect(r.rubric).toBeNull();
    expect(r.siblings.map((s: RunRow) => s.seed).sort()).toEqual([2, 3]);
    expect(r.adjacent).toEqual({ previous: a1.id, next: null });
    expect(r.files.some((f: any) => f.path === 'call1/prompt.md')).toBe(true);
    const a = await ok<any>('GET', `/run/${a1.id}`);
    expect(a.scoreVersions.map((v: any) => [v.file.startsWith('score.2'), v.score])).toEqual([
      [true, 0.5],
      [false, 1],
    ]);
    const crashed = await ok<any>('GET', `/run/${runOf(batch.b, 2).id}`);
    expect(crashed.logTail).toBe('line one\nboom: it broke');
  });

  test('/run/:id refuses an unknown run id', async () => {
    const r = await call('GET', '/run/echo-nope-seed1-2026-01-01T00-00-00-000Z');
    expect(r.status).toBe(404);
  });

  test('/run/:id/file reads inside the folder and refuses ../, absolute paths and symlinks out', async () => {
    const id = runOf(batch.b, 1).id;
    const f = await ok<any>('GET', `/run/${id}/file`, { path: 'call1/prompt.md' });
    expect(f.text).toBe('say this back, but differently');
    for (const path of ['../../state.json', `../${runOf(batch.a, 1).id}/run.json`, '/etc/passwd', 'escape.json', '..']) {
      const r = await call('GET', `/run/${id}/file`, { path });
      expect([r.status, (r.body as any).text]).toEqual([404, undefined]);
    }
    expect((await call('GET', `/run/${id}/file`)).status).toBe(400);
  });

  test('/compare: the gate flip, both replies and both prompts', async () => {
    const c = await ok<any>('GET', '/compare', { a: runOf(batch.a, 1).id, b: runOf(batch.b, 3).id });
    expect(c.diff).toEqual([{ kind: 'gate', id: 'echoed', before: true, after: false }]);
    expect(c.replies).toEqual({ a: 'say this back', b: 'something else' });
    expect(c.prompts.map((p: any) => p.file)).toEqual(['call1/prompt.md']);
  });

  test('/batches: b against a, the flip, gate deltas and the prompt diff', async () => {
    const b = await ok<any>('GET', '/batches', { surface: 'echo', a: batch.a, b: batch.b });
    expect(b.verdict.baseline.kind).toBe('against');
    expect(b.flips.ok).toBe(true);
    expect(b.flips.flips.map((f: any) => f.direction)).toEqual(['broke']);
    expect(b.gateDeltas).toEqual([{ id: 'echoed', a: 0, b: 3 }]);
    expect(b.promptDiffs[0].b.text).toBe('say this back, but differently');
    expect((await call('GET', '/batches', { surface: 'echo', a: batch.a, b: 'no-such-batch' })).status).toBe(404);
  });

  test('/epoch: epoch 2 against 1 with its prompt diff; an epoch that does not exist is refused', async () => {
    const e = await ok<any>('GET', '/epoch', { surface: 'echo', n: '2' });
    expect(e.epoch.n).toBe(2);
    expect(e.previous.n).toBe(1);
    const pair = e.diffs.find((d: any) => d.file === 'call1/prompt.md');
    expect([pair.a.text, pair.b.text]).toEqual(['say this back', 'say this back, but differently']);
    expect(e.commits.map((c: any) => c.sha)).toEqual([sha.c2]);
    expect((await call('GET', '/epoch', { surface: 'echo', n: '9' })).status).toBe(404);
    expect((await call('GET', '/epoch', { surface: 'echo', n: 'x' })).status).toBe(400);
  });

  test('/attribution refuses a hex sha that is not a commit here, before attribution runs', async () => {
    const r = await call('GET', '/attribution', { surface: 'echo', good: batch.a, bad: 'deadbeefdeadbeef' });
    expect([r.status, (r.body as any).error]).toEqual([400, 'deadbeefdeadbeef is not a commit in this repo']);
  });

  test('/attribution: the five-line checklist and a source answer pinned to the one commit', async () => {
    const a = await ok<any>('GET', '/attribution', { surface: 'echo', good: batch.a, bad: batch.b });
    expect(a.checklist.map((c: any) => c.class)).toEqual(['footing', 'freeze', 'live-reads', 'source', 'noise']);
    expect(a.answer.kind).toBe('source');
    expect(a.answer.confidence).toBe('pinned');
    expect(a.answer.candidates.map((c: any) => c.commit.sha)).toEqual([sha.c2]);
    expect(a.answer.rangeCommits).toBe(1);
    expect(a.mode).toBe('flip');
    // --all-commits rides the query: every commit in the range is searched, so nothing reads as "no declared source moved".
    const wide = await ok<any>('GET', '/attribution', { surface: 'echo', good: batch.a, bad: batch.b, allCommits: '1' });
    expect(wide.answer).toMatchObject({ kind: 'source', confidence: 'pinned', noDeclaredSourceMoved: false, rangeCommits: 1 });
    expect((await call('GET', '/attribution', { surface: 'echo', good: '$(rm -rf ~)', bad: batch.b })).status).toBe(400);
    // A freeze limit rides the query too (the launcher's "Attribute this freeze"), so the free answer weighs what the plan will.
    const limited = await ok<any>('GET', '/attribution', { surface: 'echo', good: batch.a, bad: batch.b, freeze: F.slice(0, 8) });
    expect(limited.flipped.map((f: any) => f.freezeId)).toEqual([F]);
    expect(limited.answer).toMatchObject({ kind: 'source', confidence: 'pinned' });
    // A freeze the surface never ran (G is another surface's) is refused, never weighed as "nothing flipped", and so is a ref
    // shorter than a freeze prefix, which would match several freezes: the same check, and the same 400, as the bisect POSTs.
    expect((await call('GET', '/attribution', { surface: 'echo', good: batch.a, bad: batch.b, freeze: G.slice(0, 8) })).status).toBe(400);
    expect((await call('GET', '/attribution', { surface: 'echo', good: batch.a, bad: batch.b, freeze: F.slice(0, 1) })).status).toBe(400);
  });

  test('/commit/:sha: the commit, its files and diff; a bad sha is refused before git sees it', async () => {
    const c = await ok<any>('GET', `/commit/${sha.c2.slice(0, 10)}`, { surface: 'echo' });
    expect(c.commit.sha).toBe(sha.c2);
    expect(c.commit.session).toBe('jx7test');
    expect(c.parents).toEqual([sha.c1]);
    expect(c.files).toEqual([{ path: 'packages/evals/src/testSurface.ts', status: 'M', additions: 1, deletions: 1 }]);
    expect(c.diff).toContain('+// v2: the prompt changed');
    expect(c.whole).toBe(false);
    expect(c.truncated).toBe(false);
    for (const bad of ['zzzzzzz', '--output=x', 'deadbeefdeadbeef', 'HEAD']) expect((await call('GET', `/commit/${encodeURIComponent(bad)}`)).status).toBe(400);
  });

  test('/commit/:sha: a commit past PATCH_TEXT_MAX sends its first 2 MiB and says so, with its whole file list', async () => {
    // Built with plumbing and left on no ref, so the scratch history the other tests read is unchanged.
    const big = join(bin, 'big.txt');
    writeFileSync(big, 'a lockfile line that keeps going\n'.repeat(100_000));
    const blob = git('hash-object', '-w', big);
    const mk = Bun.spawnSync(['git', 'mktree'], { cwd: repo, stdin: Buffer.from(`100644 blob ${blob}\tbig.txt\n`) });
    const commit = git('commit-tree', mk.stdout.toString().trim(), '-p', sha.c2, '-m', 'vendor: a huge refresh');
    const c = await ok<any>('GET', `/commit/${commit}`, { whole: '1' });
    expect(c.truncated).toBe(true);
    expect(c.diff.length).toBe(2 * 1024 * 1024);
    expect(c.files.map((f: any) => f.path)).toContain('big.txt');
  });

  test('/patch/:sha: a kept tree patch with its files; a name that is not a sha256 is refused, an unknown one is a 404', async () => {
    const text = 'diff --git a/packages/evals/src/testSurface.ts b/packages/evals/src/testSurface.ts\n--- a/packages/evals/src/testSurface.ts\n+++ b/packages/evals/src/testSurface.ts\n@@ -1 +1,2 @@\n-// v2: the prompt changed\n+// v3: on the disk only\n+// and one more line\n';
    const name = new Bun.CryptoHasher('sha256').update(text).digest('hex');
    mkdirSync(join(home, 'trees'), { recursive: true });
    writeFileSync(join(home, 'trees', `${name}.patch`), text);
    const p = await ok<any>('GET', `/patch/${name}`);
    expect(p).toEqual({ sha: name, files: [{ path: 'packages/evals/src/testSurface.ts', additions: 2, deletions: 1 }], diff: text, truncated: false });
    for (const bad of [name.slice(0, 12), '../x', 'Z'.repeat(64)]) expect((await call('GET', `/patch/${encodeURIComponent(bad)}`)).status).toBe(400);
    expect((await call('GET', `/patch/${'0'.repeat(64)}`)).status).toBe(404);
    // A Multiplayer sim session's kept edits live gzipped under the sim home; the same route reads them.
    const simText = text.replace('v3', 'v4');
    const simName = new Bun.CryptoHasher('sha256').update(simText).digest('hex');
    mkdirSync(join(simHome, 'trees'), { recursive: true });
    writeFileSync(join(simHome, 'trees', `${simName}.patch.gz`), Bun.gzipSync(Buffer.from(simText)));
    expect(await ok<any>('GET', `/patch/${simName}`)).toEqual({ sha: simName, files: [{ path: 'packages/evals/src/testSurface.ts', additions: 2, deletions: 1 }], diff: simText, truncated: false });
  });

  test('/search: freezes and runs by id prefix, from the index', async () => {
    const s = await ok<any>('GET', '/search', { q: F.slice(0, 6) });
    expect(s.freezes.map((f: any) => [f.id, f.surface])).toEqual([[F, 'echo']]);
    const prefix = `echo-${F.slice(0, 8)}-seed1-`;
    const runs = await ok<any>('GET', '/search', { q: prefix });
    expect(runs.runs.length).toBeGreaterThan(1);
    expect(runs.runs.every((r: any) => r.id.startsWith(prefix) && r.surface === 'echo')).toBe(true);
    expect(await ok<any>('GET', '/search', { q: 'ec' })).toEqual({ freezes: [], runs: [] });
  });

  test('/changes: a cursor, then only what landed after it', async () => {
    const repsBefore = (await ok<any>('GET', '/overview', { cadence: 'all' })).surfaces.find((s: any) => s.id === 'echo').strip.find((b: any) => b.batch === batch.b).reps;
    const first = await ok<any>('GET', '/changes', { since: '0' });
    expect(first.runs).toEqual([]);
    expect(first.bisects.length).toBe(1);
    const id = writeRep({ freeze: F, seed: 4, at: Date.parse(batch.b) + 4000, batch: batch.b, head: sha.c2, pass: false, promptSha: 'p2', prompt: 'x' });
    await Bun.sleep(2100);
    const next = await ok<any>('GET', '/changes', { since: String(first.cursor) });
    expect(next.runs.map((r: RunRow) => r.id)).toEqual([id]);
    expect(next.bisects).toEqual([]);
    expect(next.cursor).toBeGreaterThan(first.cursor);
    // The wall's memo is keyed on the index, so the rep that landed is on it at once.
    const o = await ok<any>('GET', '/overview', { cadence: 'all' });
    expect(o.surfaces.find((s: any) => s.id === 'echo').strip.find((b: any) => b.batch === batch.b).reps).toBe(repsBefore + 1);
  });

  test('/bisects and /bisect/:id: the list, steps after a cursor, a stall flag and the log tail', async () => {
    const l = await ok<any>('GET', '/bisects');
    expect(l.bisects[0]).toMatchObject({ id: 'echo-20260930-100000', status: 'probing', outcome: null });
    // The list carries the last write, so the list and the wall can say "stalled?" too.
    expect(typeof l.bisects[0].updatedAt).toBe('string');
    // No live process holds bisects/running.json, so nothing blocks a start.
    expect(l.running).toBeNull();
    const b = await ok<any>('GET', '/bisect/echo-20260930-100000', { since: '1' });
    expect(b.steps.map((s: any) => s.seq)).toEqual([2, 3]);
    expect(b.cursor).toBe(3);
    expect(b.stalled).toBe(true);
    expect(b.logTail).toEqual(['probe 1', 'probe 2']);
    expect((await call('GET', '/bisect/nope')).status).toBe(404);
    expect((await call('GET', '/bisect/..')).status).toBe(404);
  });
});

describe('POST routes build argv arrays only', () => {
  test('/bisect/plan runs `./evals bisect plan … --json` and returns its JSON', async () => {
    const plan = await ok<any>('POST', '/bisect/plan', {}, { surface: 'echo', good: batch.a, bad: sha.c2.slice(0, 9), reps: 3 });
    expect(plan.summary).toBe('canned plan');
    expect(recordedArgv().at(-1)).toEqual(['tool', 'bisect', 'plan', 'echo', '--good', batch.a, '--bad', sha.c2.slice(0, 9), '--reps', '3', '--no-render', '--json']);
  });

  test('a bisect body that is not a batch or a sha, or names a freeze never run, is refused before anything spawns', async () => {
    const before = recordedArgv().length;
    for (const body of [{ surface: 'echo', good: 'a; rm -rf ~', bad: batch.b }, { surface: 'echo', good: batch.a, bad: 'deadbeefdeadbeef' }, { surface: 'echo', good: batch.a, bad: batch.b, freezes: ['deadbeef'] }, { surface: 'nope', good: batch.a, bad: batch.b }, { surface: 'echo', good: batch.a, bad: batch.b, reps: 99 }]) {
      expect((await call('POST', '/bisect/plan', {}, body)).status).toBe(400);
    }
    expect(recordedArgv().length).toBe(before);
  });

  test('/bisect/:id/stop writes the stop file for a running bisect', async () => {
    expect(await ok<any>('POST', '/bisect/echo-20260930-100000/stop')).toEqual({ id: 'echo-20260930-100000', stopping: true });
    expect(existsSync(join(home, 'bisects', 'echo-20260930-100000', 'stop'))).toBe(true);
  });

  test('/bisect refuses while the runner lock is held by a live process, then starts one in tmux with every flag as its own argument', async () => {
    const lock = join(home, 'bisects', 'running.json');
    writeFileSync(lock, JSON.stringify({ id: 'echo-20260930-100000', pid: process.pid }));
    const held = await call('POST', '/bisect', {}, { surface: 'echo', good: batch.a, bad: batch.b });
    expect([held.status, (held.body as any).error]).toEqual([400, 'bisect echo-20260930-100000 is running; one runs at a time']);
    // A holder whose process is gone (a crash) holds nothing.
    writeFileSync(lock, JSON.stringify({ id: 'echo-20260930-100000', pid: 2 ** 22 + 12345 }));
    // The records pin a..b to one commit: the free plan says so here, before anything spawns.
    const spawned = recordedArgv().length;
    const pinned = await call('POST', '/bisect', {}, { surface: 'echo', good: batch.a, bad: batch.b });
    expect(pinned.status).toBe(400);
    expect((pinned.body as any).error).toContain('nothing to search');
    expect(recordedArgv().length).toBe(spawned);
    // Two later commits on the declared source, built with plumbing on no ref. The good end is a passing batch on c2 and the bad
    // end is c4, which stands for the failing batch that ran on it, so the freeze fell and c3..c4 hold two candidates the records
    // cannot settle.
    const commitOn = (parent: string, text: string, msg: string) => {
      const blob = Bun.spawnSync(['git', 'hash-object', '-w', '--stdin'], { cwd: repo, stdin: Buffer.from(text) }).stdout.toString().trim();
      const index = join(bin, `index-${msg.length}`);
      const env = { ...process.env, GIT_INDEX_FILE: index };
      Bun.spawnSync(['git', 'read-tree', parent], { cwd: repo, env });
      Bun.spawnSync(['git', 'update-index', '--cacheinfo', `100644,${blob},packages/evals/src/testSurface.ts`], { cwd: repo, env });
      const tree = Bun.spawnSync(['git', 'write-tree'], { cwd: repo, env }).stdout.toString().trim();
      return git('commit-tree', tree, '-p', parent, '-m', msg);
    };
    const c3 = commitOn(sha.c2, '', 'echo: empty the prompt');
    const c4 = commitOn(c3, '// v4\n', 'echo: write the prompt again');
    const atG = Date.parse(batch.b) + 3600_000;
    const good = new Date(atG).toISOString();
    for (const seed of [1, 2, 3]) {
      writeRep({ freeze: F, seed, at: atG + seed * 1000, batch: good, head: sha.c2, pass: true, promptSha: 'p2', prompt: 'say this back' });
      writeRep({ freeze: F, seed, at: atG + 3600_000 + seed * 1000, batch: new Date(atG + 3600_000).toISOString(), head: c4, pass: false, promptSha: 'p4', prompt: '' });
    }
    await Bun.sleep(2100);
    const r = await ok<any>('POST', '/bisect', {}, { surface: 'echo', good, bad: c4, freezes: [F.slice(0, 8)], reps: 3, budgetUsd: 2.5, maxMinutes: 30 });
    expect(r.tmux).toBe(`evals-bisect-${r.id}`);
    // The pane is teed into job.log before the tool is exec'd in it, so nothing it prints is lost with the window.
    const tmux = recordedArgv().filter((a) => a[0] === 'tmux').slice(-3);
    expect(tmux[0]!.slice(0, 8)).toEqual(['tmux', 'new-session', '-d', '-s', `evals-bisect-${r.id}`, '-c', REPO_ROOT, '--']);
    expect(tmux[1]!.slice(0, 5)).toEqual(['tmux', 'pipe-pane', '-t', `=evals-bisect-${r.id}:`, '-o']);
    expect(tmux[1]![5]).toBe(`cat >> '${join(home, 'bisects', r.id, 'job.log')}'`);
    const argv = tmux[2]!;
    expect(argv.slice(0, 8)).toEqual(['tmux', 'respawn-pane', '-k', '-t', `=evals-bisect-${r.id}:`, '-c', REPO_ROOT, '--']);
    expect(argv.slice(9)).toEqual([join(bin, 'tool.ts'), 'bisect', 'start', 'echo', '--good', good, '--bad', c4, '--freeze', F.slice(0, 8), '--reps', '3', '--budget', '2.5', '--max-minutes', '30', '--id', r.id]);
    // The page the founder is sent to has a bisect to read at once: the placeholder, planning, from the free plan.
    rmSync(lock, { force: true });
    const placed = JSON.parse(readFileSync(join(home, 'bisects', r.id, 'state.json'), 'utf8'));
    expect(placed).toMatchObject({ id: r.id, surface: 'echo', status: 'planning', pending: true, tmux: `evals-bisect-${r.id}` });
    expect(placed.plan.candidates.length).toBeGreaterThan(1);
    // The fake tmux has no session, so the job has ended without a runner: it reads as failed, with what the job printed.
    writeFileSync(join(home, 'bisects', r.id, 'job.log'), '\u001b[2mloading\u001b[0m\r\nerror: Cannot find module x\r\n');
    const read = await ok<any>('GET', `/bisect/${r.id}`);
    expect(read.state.status).toBe('failed');
    expect(read.logTail).toEqual(['loading', 'error: Cannot find module x']);
    const listed = await ok<any>('GET', '/bisects');
    expect(listed.bisects.find((b: any) => b.id === r.id).status).toBe('failed');
    expect(listed.running).toBeNull();
  });

  test('/sim/shrink starts `bun run sim --shrink <artifact folder>` for a failure of a scenario the suite holds', async () => {
    // A failing run of a real scenario (the catalog is the checkout's own sim.ts --list).
    const live = 'memberRemovedMidTurn-interleave-9';
    json(join(simHome, 'sessions', SIM_SESSION, live, 'result.json'), { scenario: 'memberRemovedMidTurn', mode: 'interleave', seed: 9, step: 'settle #1', delivery: 3, invariant: { id: 'INV-followers', meaning: 'followers match' }, order: 'conn:w1 sched', labels: {}, text: 'failed' });
    const r = await ok<any>('POST', '/sim/shrink', {}, { session: SIM_SESSION, run: live });
    expect(r.job).toMatch(/^shrink-/);
    const argv = recordedArgv().at(-1)!;
    expect(argv.slice(0, 2)).toEqual(['tmux', 'respawn-pane']);
    expect(argv.slice(-3)).toEqual([join(REPO_ROOT, 'packages', 'web', 'scripts', 'sim.ts'), '--shrink', join(simHome, 'sessions', SIM_SESSION, live)]);
    // demoScenario is not in the suite: sim.ts --shrink would exit at once with no trace, so the child refuses before it spawns.
    const spawned = recordedArgv().length;
    const gone = await call('POST', '/sim/shrink', {}, { session: SIM_SESSION, run: SIM_RUN });
    expect(gone.status).toBe(400);
    expect(JSON.stringify(gone.body)).toContain('no longer in the suite');
    expect(recordedArgv().length).toBe(spawned);
    expect((await call('POST', '/sim/shrink', {}, { session: SIM_SESSION, run: 'demoScenario-scripted-1' })).status).toBe(400);
    expect((await call('POST', '/sim/shrink', {}, { session: '..', run: SIM_RUN })).status).toBe(400);
    const changes = await ok<any>('GET', '/changes', { since: '0' });
    expect(changes.jobs.find((j: any) => j.id === r.job)).toMatchObject({ kind: 'shrink', status: 'failed', run: live, logTail: [] });
    // The run page reads the job back after a reload: its outcome and the lines it printed.
    writeFileSync(join(simHome, 'jobs', `${r.job}.log`), 'replaying memberRemovedMidTurn\nerror: the recorded order no longer fails\n');
    const page = await ok<any>('GET', `/sim/run/${SIM_SESSION}/${live}`);
    expect(page.lastShrink).toMatchObject({ id: r.job, status: 'failed', logTail: ['replaying memberRemovedMidTurn', 'error: the recorded order no longer fails'] });
  });

  test('/sim/sweep starts `bun run sim <filter> --sweep N`; a filter that names nothing is refused', async () => {
    const r = await ok<any>('POST', '/sim/sweep', {}, { filter: 'memberRemovedMidTurn', seeds: 20 });
    expect(r.job).toMatch(/^sweep-/);
    expect(recordedArgv().at(-1)!.slice(-3)).toEqual(['memberRemovedMidTurn', '--sweep', '20']);
    expect((await call('POST', '/sim/sweep', {}, { filter: 'x; rm -rf ~', seeds: 2 })).status).toBe(400);
    expect((await call('POST', '/sim/sweep', {}, { filter: '--keep', seeds: 2 })).status).toBe(400);
    expect((await call('POST', '/sim/sweep', {}, { filter: 'noSuchScenarioAnywhere', seeds: 2 })).status).toBe(400);
    expect((await call('POST', '/sim/sweep', {}, { seeds: 0 })).status).toBe(400);
    // The catalog page reads the sweep back after a reload: its outcome and the lines it printed.
    writeFileSync(join(simHome, 'jobs', `${r.job}.log`), 'sweeping memberRemovedMidTurn\nerror: bun exited 1\n');
    const sessions = await ok<any>('GET', '/sim/sessions');
    expect(sessions.lastSweep).toMatchObject({ id: r.job, kind: 'sweep', status: 'failed', logTail: ['sweeping memberRemovedMidTurn', 'error: bun exited 1'] });
  }, 60_000);
});

describe('the Multiplayer sim', () => {
  test('/sim/catalog: the real runner catalog, the not-compared keys, and the history grid', async () => {
    const c = await ok<any>('GET', '/sim/catalog');
    expect(c.scenarios.some((s: any) => s.name === 'memberRemovedMidTurn')).toBe(true);
    expect(c.invariants.some((i: any) => i.id === 'INV-followers')).toBe(true);
    expect(c.notCompared.length).toBeGreaterThan(10);
    const cell = c.grid.find((g: any) => g.scenario === 'demoScenario' && g.mode === 'interleave');
    expect(cell.latest).toMatchObject({ session: SIM_SESSION, run: SIM_RUN, passed: false, seed: 7 });
    expect(cell.history).toEqual([{ session: SIM_SESSION, seeds: 1, failed: 1 }]);
    expect(cell.newestFailure).toEqual({ session: SIM_SESSION, run: SIM_RUN, seed: 7, invariant: 'INV-followers', at: '2026-10-01T10:00:00.000Z' });
    expect(c.grid.find((g: any) => g.scenario === 'demoScenario' && g.mode === 'scripted').newestFailure).toBeNull();
    expect(c.caught).toEqual({ 'INV-followers': 1 });
  }, 60_000);

  test('a cell whose newest session passed still links to its last failure', () => {
    const was = process.env.CODECAST_SIM_HOME;
    process.env.CODECAST_SIM_HOME = simHome;
    try {
      const older = simSessions().find((s) => s.session.id === SIM_SESSION)!;
      const later = { session: { ...older.session, id: '2026-10-02T10-00-00-000Z-1', startedAt: '2026-10-02T10:00:00.000Z' }, runs: [{ scenario: 'demoScenario', mode: 'interleave' as const, seed: 8, passed: true, deliveries: 9, ms: 40 }] };
      const cell = simGrid([{ name: 'demoScenario', file: 'scenarios/demo.scenario.ts', selftest: false, modes: ['scripted', 'interleave'], red: [], known: [] }], [later, older]).grid.find((g) => g.mode === 'interleave')!;
      expect(cell.latest).toMatchObject({ session: later.session.id, passed: true });
      expect(cell.newestFailure).toMatchObject({ session: SIM_SESSION, run: SIM_RUN, invariant: 'INV-followers' });
    } finally {
      if (was === undefined) delete process.env.CODECAST_SIM_HOME;
      else process.env.CODECAST_SIM_HOME = was;
    }
  });

  test('/sim/sessions and /sim/run: the summary, the run in full and its three replay lines', async () => {
    const s = await ok<any>('GET', '/sim/sessions');
    expect(s.sessions[0]).toMatchObject({ id: SIM_SESSION, runs: 2, failed: 1, scenarios: 1 });
    // Its failing rows, so the catalog can open each one, an older sweep seed included.
    expect(s.sessions[0].failing).toEqual([expect.objectContaining({ scenario: 'demoScenario', seed: 7, dir: SIM_RUN })]);
    const r = await ok<any>('GET', `/sim/run/${SIM_SESSION}/${SIM_RUN}`);
    expect(r.events.length).toBe(2);
    expect(r.minimal.removed).toEqual([0, 2]);
    expect(r.world.devices[0].name).toBe('d1');
    expect(r.invariant.id).toBe('INV-followers');
    expect(r.replay).toEqual({
      trace: 'bun run sim demoScenario --seed 7 --trace task#1',
      order: 'bun run sim demoScenario --seed 7 --order="conn:w1 repl:w1>w2 sched"',
      minimal: 'bun run sim demoScenario --seed 7 --order="repl:w1>w2"',
      // The free sim bisect over this run's own artifact folder.
      bisect: bisectCommand(join(simHome, 'sessions', SIM_SESSION, SIM_RUN)),
    });
    expect((await call('GET', `/sim/run/${SIM_SESSION}/nope`)).status).toBe(404);
    expect((await call('GET', `/sim/run/%2E%2E/${SIM_RUN}`)).status).toBe(404);
  });
});

describe('pure pieces', () => {
  test('calls.log entries pair each argv with its mark, per turn', () => {
    expect(guardEntriesOf(['a', 'HELP a', 'b', '# turn 2', 'c', 'UNSERVED c'])).toEqual([
      { seq: 1, turn: 1, argv: 'a', status: 'HELP' },
      { seq: 2, turn: 1, argv: 'b', status: null },
      { seq: 3, turn: 2, argv: 'c', status: 'UNSERVED' },
    ]);
  });

  test('parallel calls: every argv logged before any mark still pairs, oldest same argv first, never across turns', () => {
    expect(guardEntriesOf(['a', 'b', 'a', 'LIVE b', 'LIVE a', 'REFUSED a', '# turn 2', 'HELP a', 'c'])).toEqual([
      { seq: 1, turn: 1, argv: 'a', status: 'LIVE' },
      { seq: 2, turn: 1, argv: 'b', status: 'LIVE' },
      { seq: 3, turn: 1, argv: 'a', status: 'REFUSED' },
      { seq: 4, turn: 2, argv: 'HELP a', status: null },
      { seq: 5, turn: 2, argv: 'c', status: null },
    ]);
  });

  test('NOT_COMPARED is read statically from the source', () => {
    expect(notComparedOf('export const NOT_COMPARED: X = {\n  a: "why \\"a\\"",\n  b: "why b",\n};\n')).toEqual([
      { key: 'a', reason: 'why "a"' },
      { key: 'b', reason: 'why b' },
    ]);
  });

  test('the rep folder helpers grade and the run page share: units in number order, a missing exit.txt reads as failed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-api-layout-'));
    for (const n of ['call10', 'call2', 'agent1', 'judge', 'call1x']) mkdirSync(join(dir, n));
    for (const f of ['then10.md', 'then2.md', 'prompt.md']) writeFileSync(join(dir, 'agent1', f), '');
    expect(unitDirs(dir, 'call')).toEqual(['call2', 'call10']);
    expect(thenFiles(join(dir, 'agent1'))).toEqual(['then2.md', 'then10.md']);
    expect(harnessExit(join(dir, 'call2'))).toBe(1);
    writeFileSync(join(dir, 'call2', 'exit.txt'), '0\n');
    writeFileSync(join(dir, 'call2', 'took.txt'), '12s\n');
    expect([harnessExit(join(dir, 'call2')), harnessTookMs(join(dir, 'call2')), harnessTookMs(join(dir, 'call10'))]).toEqual([0, 12_000, null]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('replay lines quote a label that needs it and keep an empty order as one word', () => {
    expect(simReplay({ scenario: 's', seed: 1, order: '', row: { table: 't', id: 'i', label: "it's", diff: [] }, minimalOrder: '' })).toEqual({ trace: `bun run sim s --seed 1 --trace 'it'\\''s'`, order: 'bun run sim s --seed 1 --order=""', minimal: 'bun run sim s --seed 1 --order=""' });
  });

  test('bisect argv: --yes only on an explicit confirm, --all-commits only when asked', () => {
    expect(bisectPlanArgs({ surface: 's', good: 'g', bad: 'b' })).toEqual(['bisect', 'plan', 's', '--good', 'g', '--bad', 'b', '--no-render', '--json']);
    expect(bisectPlanArgs({ surface: 's', good: 'g', bad: 'b', budgetUsd: 3, maxMinutes: 20, allCommits: true })).toEqual(['bisect', 'plan', 's', '--good', 'g', '--bad', 'b', '--budget', '3', '--max-minutes', '20', '--all-commits', '--no-render', '--json']);
    expect(bisectStartArgs({ surface: 's', good: 'g', bad: 'b', confirm: true, allCommits: true }, 'id1')).toEqual(['bisect', 'start', 's', '--good', 'g', '--bad', 'b', '--all-commits', '--yes', '--id', 'id1']);
  });
});

// Last, since bun runs a file's tests in order: a route added to the contract
// without a case here fails this, not a page in the browser.
describe('coverage', () => {
  test('every route in the contract was answered 200 over the protocol', () => {
    expect(EVALS_ROUTE_KEYS.filter((k) => !answered.has(k))).toEqual([]);
    expect(answered.size).toBe(EVALS_ROUTE_KEYS.length);
  });
});
