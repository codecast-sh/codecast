import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { batchSet, pooledRuns, previousRuns, previousRunSet } from '../commands/verdict';
import { rescoreRun } from '../commands/grade';
import { runSnapshot } from '../commands/snapshot';
import type { SurfaceRun } from './runs';
import { surfaceMeta } from '../registry';
import { servedReadKey } from '../served';
import type { AgentResult, CallResult, SurfaceImpl } from '../surface';
import { echoImpl, echoMeta } from '../testSurface';
import type { Freeze } from '@platform/evals';
import { assertAnswered, filesWrittenOf, harnessFailure, loopTurnsOf, outsideWorldCommands, readAgentRun } from './dryRun';
import { rulerAt } from '../history/runIndex';
import { GUARD_STAMP } from '../paths';
import { loggedArgv } from '../served';
import { dominantModel, guardClassifierSha, replayRep, routeGates, scoreOf, type PreparedFreeze, type RepLedger } from './replay';

const call = (over: Partial<CallResult> = {}): CallResult => ({
  request: { model: 'pin', prompt: 'p', max_tokens: 100 },
  text: 't',
  outputTokens: 10,
  stopReason: 'end_turn',
  modelUsage: { pin: { outputTokens: 10 }, 'side-model': { outputTokens: 2 } },
  costUsd: 0.001,
  isError: false,
  exitCode: 0,
  dir: '/tmp/x',
  realMs: 1,
  ...over,
});
const agent = (calls: string[]): AgentResult => ({ runSubdir: '/tmp/a', said: ['hi'], turns: [['hi']], calls, costUsd: 0.1, modelUsage: { pin: { outputTokens: 50 } }, isError: false, exitCode: 0, model: 'pin', realMs: 1 });
const byId = (gates: Array<{ id: string; pass: boolean; evidence: { summary: string } }>) => Object.fromEntries(gates.map((g) => [g.id, g]));

describe('route gates', () => {
  const callMeta = { ...surfaceMeta('title')!, model: 'pin' };
  const agentMeta = { ...surfaceMeta('role-wake')!, model: 'pin' };

  test('a clean call passes model-as-pinned, ok and prod-budget', () => {
    expect(routeGates(callMeta, { calls: [call()], agents: [] }).map((g) => `${g.id}:${g.pass}`)).toEqual(['model-as-pinned:true', 'ok:true', 'prod-budget:true']);
  });

  test('another model doing most of the work fails model-as-pinned', () => {
    const g = byId(routeGates(callMeta, { calls: [call({ modelUsage: { pin: { outputTokens: 1 }, other: { outputTokens: 90 } } })], agents: [] }));
    expect(g['model-as-pinned']!.pass).toBe(false);
    expect(g['model-as-pinned']!.evidence.summary).toContain('answered on other');
    expect(dominantModel({ a: { outputTokens: 1 }, b: { outputTokens: 3 } })).toBe('b');
  });

  test("an agent's own loop decides model-as-pinned; the subagents it starts are named, not counted", () => {
    // b4c3120d seed8 on 2026-10-02: the loop stayed on the pin and handed record batches to sonnet subagents, which wrote more output.
    const delegating = { ...agent([]), modelUsage: { pin: { outputTokens: 39228 }, sub: { outputTokens: 47016 } }, loopTurns: { pin: 57 } };
    const g = byId(routeGates(agentMeta, { calls: [], agents: [delegating] }))['model-as-pinned']!;
    expect(g.pass).toBe(true);
    expect(g.evidence.summary).toContain("agent1's subagents answered on sub (47016 output tokens)");
    // A loop message on another model fails it, however little it wrote.
    const drifted = byId(routeGates(agentMeta, { calls: [], agents: [{ ...delegating, loopTurns: { pin: 56, other: 1 } }] }))['model-as-pinned']!;
    expect(drifted.pass).toBe(false);
    expect(drifted.evidence.summary).toContain('agent1 pinned pin, its loop answered on other');
    // No stream to read: the model with the most output, as for a call.
    expect(byId(routeGates(agentMeta, { calls: [], agents: [{ ...delegating, loopTurns: {} }] }))['model-as-pinned']!.pass).toBe(false);
  });

  test("the loop's model is read per message from the stream; a subagent's messages carry their parent tool use", () => {
    const line = (id: string, model: string, parent: string | null) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { id, model, content: [] } });
    const stream = [line('m1', 'pin', null), line('m1', 'pin', null), line('m2', 'pin', null), line('s1', 'sub', 'toolu_1'), '{"type":"user"}', 'not json'].join('\n');
    expect(loopTurnsOf(stream)).toEqual({ pin: 2 });
  });

  test('a reply prod would have truncated fails prod-budget', () => {
    expect(byId(routeGates(callMeta, { calls: [call({ stopReason: 'max_tokens' })], agents: [] }))['prod-budget']!.pass).toBe(false);
    expect(byId(routeGates(callMeta, { calls: [call({ outputTokens: 101 })], agents: [] }))['prod-budget']!.pass).toBe(false);
  });

  test('an agent read that went live fails frozen-reads and names the argv and the fix', () => {
    const g = byId(routeGates(agentMeta, { calls: [], agents: [agent(['brief', 'SERVED brief', 'UNSERVED org inputs --team T --json'])] }));
    expect(g['frozen-reads']!.pass).toBe(false);
    expect(g['frozen-reads']!.evidence.summary).toContain('cast org inputs --team T --json was not captured, so it was refused: add it to meta.frozenReads');
    expect(g['no-unexpected-writes']!.pass).toBe(true);
    expect(byId(routeGates(agentMeta, { calls: [], agents: [agent(['REFUSED task create x'])] }))['no-unexpected-writes']!.pass).toBe(false);
  });

  test("a read an older guard refused is judged by today's guard and is no write", () => {
    const writes = (line: string) => byId(routeGates(agentMeta, { calls: [], agents: [agent([line])] }))['no-unexpected-writes']!;
    expect(writes('REFUSED goals --brief').pass).toBe(true);
    expect(writes('REFUSED publish ls --json').pass).toBe(true);
    expect(writes('REFUSED plan replay pl-461').pass).toBe(true);
    expect(writes('REFUSED publish comments pg --resolve c1').evidence.summary).toBe('refused: cast publish comments pg --resolve c1');
    // The guard logs a quoted argument quoted, so a write whose question begins with a read verb is still the write it was.
    expect(writes("REFUSED decide 'show which plan ships' -o a").pass).toBe(false);
    expect(writes("REFUSED chat 'read the thread first' --channel c1").pass).toBe(false);
    expect(writes('REFUSED stack show sd-55').pass).toBe(true);
  });

  test('a logged argv splits back into exactly the arguments the guard logged', () => {
    expect(loggedArgv(`decide 'show which plan ships' -o 'it'\\''s' '' 'a"b'`)).toEqual(['decide', 'show which plan ships', '-o', "it's", '', 'a"b']);
    expect(loggedArgv('task show ct-1 --json')).toEqual(['task', 'show', 'ct-1', '--json']);
    expect(loggedArgv("say 'never closed")).toBeNull();
  });

  test('score: any failed gate zeroes it; a missed floor fails it', () => {
    const ok = { id: 'g', pass: true, evidence: { summary: '' } };
    expect(scoreOf([ok], [{ id: 'c', weight: 1, score: 0.8 }]).pass).toBe(true);
    expect(scoreOf([{ ...ok, pass: false }], [{ id: 'c', weight: 1, score: 0.8 }]).score).toBe(0);
    const floored = scoreOf([ok], [{ id: 'criteria', weight: 1, score: 0.6, must: 0.7 }, { id: 'x', weight: 3, score: 1 }]);
    expect(floored.score).toBeCloseTo(0.9);
    expect(floored.pass).toBe(false);
    expect(floored.missedFloors).toEqual([{ id: 'criteria', score: 0.6, must: 0.7 }]);
  });
});

describe('a run the model never answered', () => {
  // The out.json the harness wrote on 2026-10-01 when the copied login was revoked mid-check.
  const revoked = { is_error: true, terminal_reason: 'api_error', api_error_status: 401, result: 'Failed to authenticate: OAuth token revoked.', modelUsage: {} };

  test('an API error the prompt did not cause, or no out.json, is a harness failure; a 400 and a clean reply are not', () => {
    expect(harnessFailure(revoked, 1)).toBe('API error 401: Failed to authenticate: OAuth token revoked.');
    expect(harnessFailure(null, 2)).toBe('the harness wrote no out.json (exit 2)');
    expect(harnessFailure({ ...revoked, api_error_status: 400, result: 'prompt is too long' }, 1)).toBeUndefined();
    expect(harnessFailure({ is_error: false, terminal_reason: 'completed', result: '{}' }, 0)).toBeUndefined();
  });

  test('the rep crashes instead of failing model-as-pinned, ok and the surface gates', () => {
    expect(() => assertAnswered(call({ harnessFailure: harnessFailure(revoked, 1), dir: '/tmp/x/run' }), 'call1')).toThrow('call1 cannot grade the prompt: API error 401');
    expect(() => assertAnswered(call(), 'call1')).not.toThrow();
  });
});

describe('a run that left its world', () => {
  const use = (id: string, command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (id: string, content: unknown) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  // What the 2026-10-02 opus reps' streams held: the real CLI's answer to a cast the guard never saw, and a file that only quotes the words.
  const stream = [
    use('t1', 'cast org inputs --team "Union" --json > /tmp/i.json; echo $?'),
    result('t1', 'Not authenticated. Run: cast auth\n1'),
    use('t2', 'cat convex/lib/auth.ts'),
    result('t2', '    if (!userId) throw new Error("Not authenticated");'),
    use('t3', '~/.codecast/bin/cast read jx7 2>&1 | head'),
    result('t3', [{ type: 'text', text: "Error: Not authenticated. Run 'cast auth' first." }]),
    use('t4', 'cast org health --json'),
    result('t4', 'SERVED'),
  ].map((e) => JSON.stringify(e)).join('\n');

  test('the files a turn wrote: write tools and shell redirects, never a read', () => {
    const tool = (name: string, input: Record<string, string>) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: name, name, input }] } });
    const turn = [tool('Write', { file_path: '/r/.claude/projects/p/memory/fern-role.md', content: 'x' }), tool('Read', { file_path: '/r/memory/MEMORY.md' }), tool('Edit', { file_path: '/r/CLAUDE.md' }), tool('Bash', { command: 'echo hi >> notes/today.md && cat a | tee -a log.txt' })].join('\n');
    expect(filesWrittenOf(turn)).toEqual(['/r/.claude/projects/p/memory/fern-role.md', '/r/CLAUDE.md', 'notes/today.md', 'log.txt']);
    expect(filesWrittenOf(stream)).toEqual(['/tmp/i.json']);
  });

  test("names each command the real CLI answered signed out, and not a file that quotes the words", () => {
    expect(outsideWorldCommands(stream)).toEqual(['cast org inputs --team "Union" --json > /tmp/i.json; echo $?', '~/.codecast/bin/cast read jx7 2>&1 | head']);
    expect(outsideWorldCommands(JSON.stringify(use('a', 'cast brief')) + '\n' + JSON.stringify(result('a', 'Brief: steady')))).toEqual([]);
  });

  test('the agent run is a harness failure, so the rep is a crash and never a graded 0', () => {
    const sub = mkdtempSync(join(tmpdir(), 'evals-outside-'));
    writeFileSync(join(sub, 'out.json'), JSON.stringify({ is_error: false, terminal_reason: 'completed', total_cost_usd: 7, modelUsage: {} }));
    writeFileSync(join(sub, 'stream.jsonl'), stream);
    const a = readAgentRun(sub, 'pin', 1, 0, 0);
    expect(a.harnessFailure).toBe(`the agent's cast reached the real CLI outside the served world 2 time(s), first on: cast org inputs --team "Union" --json > /tmp/i.json; echo $?`);
    expect(() => assertAnswered(a, 'agent1')).toThrow('agent1 cannot grade the prompt: the agent');
  });
});

describe('snapshot', () => {
  test('captures every frozen read by its served key, the legacy org files, the frozen verbs, read-only', () => {
    process.env.CODECAST_EVALS_HOME = mkdtempSync(join(tmpdir(), 'evals-snap-'));
    try {
      const seen: string[][] = [];
      const dir = runSnapshot('role-wake', ['--team', 'T', '--role', 'R', '--name', 'scratch'], (argv) => {
        seen.push(argv);
        return { out: `served ${argv.join(' ')}`, code: argv[0] === 'sessions' ? 3 : 0 };
      });
      expect(seen).toEqual(surfaceMeta('role-wake')!.frozenReads!.map((t) => t.map((p) => p.replace('{team}', 'T').replace('{role}', 'R'))));
      expect(readFileSync(join(dir, 'reads', `${servedReadKey(['brief'])}.out`), 'utf8')).toBe('served brief @R');
      expect(readFileSync(join(dir, 'reads', `${servedReadKey(['sessions', '--json'])}.exit`), 'utf8').trim()).toBe('3');
      expect(readFileSync(join(dir, 'org-inputs.json'), 'utf8')).toBe('served org inputs --team T --json');
      expect(readFileSync(join(dir, 'frozen'), 'utf8').trim().split('\n')).toEqual(['brief', 'org', 'sessions']);
      expect(statSync(join(dir, 'captured.json')).mode & 0o777).toBe(0o444);
      expect(() => runSnapshot('role-wake', ['--team', 'T', '--role', 'R', '--name', 'scratch'], () => ({ out: '', code: 0 }))).toThrow('immutable');
      expect(() => runSnapshot('role-wake', ['--role', 'R', '--name', 'other'], () => ({ out: '', code: 0 }))).toThrow('--team is required');
      expect(() => runSnapshot('title', [], () => ({ out: '', code: 0 }))).toThrow('snapshot is for the agent surfaces');
    } finally {
      delete process.env.CODECAST_EVALS_HOME;
    }
  });
});

describe('rescore', () => {
  test("grades a rep's route gates again from its harness files and keeps the surface's own gates and checks when its freeze is not here", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'evals-rescore-')), 'org-review-0bc4cd18-seed1-2026-10-02T17-44-53-948Z');
    const sub = join(dir, 'agent1', 'agent');
    mkdirSync(sub, { recursive: true });
    const model = surfaceMeta('org-review')!.model;
    writeFileSync(join(sub, 'args.json'), JSON.stringify({ model }));
    writeFileSync(join(sub, 'exit.txt'), '0\n');
    writeFileSync(join(sub, 'out.json'), JSON.stringify({ is_error: false, total_cost_usd: 7, modelUsage: { [model]: { outputTokens: 10 }, other: { outputTokens: 99 } } }));
    writeFileSync(join(sub, 'stream.jsonl'), JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', model, content: [] } }));
    writeFileSync(join(sub, 'calls.log'), 'SERVED org inputs --team U --json\nLIVE task show ct-1\nREFUSED brief edit -\n');
    // A freeze this machine does not hold: the surface's own gates are kept as scored.
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ model, dry: false, freezeId: 'zzzzzzzz-no-such-freeze' }));
    const gate = (id: string, pass: boolean) => ({ id, pass, decidedBy: 'mechanical', evidence: { summary: '' } });
    // Stored as the 2026-10-02 first batch was: zeroed by the brief edit, and by a subagent-heavy usage.
    const stored = { pass: false, score: 0, passMark: 0.7, gates: [gate('model-as-pinned', false), gate('ok', true), gate('frozen-reads', true), gate('no-unexpected-writes', false), gate('no-wrong-close', true)], checks: [{ id: 'records', weight: 1, score: 0.8 }], missedFloors: [], judgeCostUsd: null, judgeModel: null, scoredAt: 'x', scenario: 'org-review-0bc4cd18', title: 't', seed: 1 };
    writeFileSync(join(dir, 'score.json'), JSON.stringify(stored));
    const r = (await rescoreRun(dir))!;
    // A rescore regrades refusals with today's guard, and says so in the rep's ruler.
    expect(readFileSync(join(dir, GUARD_STAMP), 'utf8').trim()).toBe(guardClassifierSha());
    expect(r.after!.gates.map((g) => `${g.id}:${g.pass}`)).toEqual(['model-as-pinned:true', 'ok:true', 'frozen-reads:true', 'no-unexpected-writes:true', 'no-wrong-close:true']);
    expect(r.after!.score).toBeCloseTo(0.8);
    expect(r.after!.pass).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'))).toMatchObject({ score: r.after!.score, seed: 1, scenario: 'org-review-0bc4cd18' });
    expect(JSON.parse(readFileSync(join(dir, 'score.before-rescore.json'), 'utf8')).score).toBe(0);
    // Each rescore also keeps its score as a version of its own, so a later one never loses it.
    const versions = () => readdirSync(dir).filter((n) => /^score\.\d{4}-.*\.json$/.test(n));
    expect(versions()).toEqual([`score.${r.after!.scoredAt!.replace(/[:.]/g, '-')}.json`]);
    expect(readFileSync(join(dir, versions()[0]!), 'utf8')).toBe(readFileSync(join(dir, 'score.json'), 'utf8'));
    // Another role's brief stays a refused write on a rescore too.
    writeFileSync(join(sub, 'calls.log'), 'REFUSED brief edit --for @docs -\n');
    await Bun.sleep(5);
    expect((await rescoreRun(dir))!.after!.gates.find((g) => g.id === 'no-unexpected-writes')!.pass).toBe(false);
    expect(versions()).toHaveLength(2);
    // A rep whose cast reached the real CLI becomes the crash a fresh run records, its score kept aside.
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ endedBecause: 'done', stopReason: null }));
    writeFileSync(join(sub, 'stream.jsonl'), [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u', input: { command: 'cast brief' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u', content: 'Not authenticated. Run: cast auth' }] } }].map((e) => JSON.stringify(e)).join('\n'));
    const crashed = (await rescoreRun(dir))!;
    expect(crashed.after).toBeNull();
    expect(crashed.crash).toContain('agent1 cannot grade the prompt: the agent\'s cast reached the real CLI outside the served world 1 time(s), first on: cast brief');
    expect(existsSync(join(dir, 'score.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))).toMatchObject({ endedBecause: 'failed', stopReason: crashed.crash });
    expect(JSON.parse(readFileSync(join(dir, 'score.before-rescore.json'), 'utf8')).score).toBe(0);
    expect(await rescoreRun(dir)).toBeNull();
  });
});

describe('the previous run set', () => {
  const run = (freezeId: string, batch: string, status = 'pass'): SurfaceRun => ({ id: `${freezeId}-${batch}`, scenario: 's', title: 't', seed: 1, startedAt: batch, createdAt: batch, status: status as SurfaceRun['status'], score: 1, gatesFailed: [], missedFloors: [], sends: 0, costUsd: 0, realMs: 0, virtualMs: 0, freezeId, batch, cadence: null, liveReads: 0 });

  test("is each freeze's newest other batch, so a later run of one freeze hides no other freeze's set", () => {
    const history = [run('a', 'b1'), run('b', 'b1'), run('a', 'b2'), run('a', 'b3', 'dry'), run('b', 'b2', 'unscored'), run('a', 'now')];
    expect(previousRunSet(history, 'now').map((r) => r.id).sort()).toEqual(['a-b2', 'b-b1']);
  });

  test('a seed run again after a crash counts once, as its newest rep, in a set and in the previous set', () => {
    // Newest first, as surfaceRuns lists them: b1's seed 1 crashed, then a resume ran it again.
    const history = [{ ...run('a', 'b1'), id: 'rerun' }, { ...run('a', 'b1', 'crash'), id: 'crash' }, { ...run('a', 'b1', 'unscored'), id: 'stop', seed: 2 }];
    expect(batchSet(history, 'b1').map((r) => r.id)).toEqual(['rerun']);
    expect(previousRunSet(history, 'now').map((r) => r.id)).toEqual(['rerun']);
  });

  test('a batch whose reps on a freeze all crashed graded nothing there, so the comparison falls back to the newest batch that did', () => {
    // The 2026-10-02 opus union-base8 shape: every rep of the newest batch a crash after rescore, an older batch scored.
    const history = [{ ...run('a', 'b2', 'crash'), id: 'c1' }, { ...run('a', 'b2', 'crash'), id: 'c2', seed: 2 }, run('a', 'b1'), run('b', 'b2')];
    expect(previousRunSet(history, 'now').map((r) => r.id).sort()).toEqual(['a-b1', 'b-b2']);
  });

  test('a batch on another model is passed over and named, so a fallback never weighs the model as the prompt', () => {
    // The union-base8 shape of 2026-10-03: the opus baseline's newest other batch on that freeze ran on sonnet.
    const history = [{ ...run('a', 'now'), model: 'opus' }, { ...run('a', 'b2'), model: 'sonnet' }, { ...run('a', 'b1'), model: 'opus' }];
    const prev = previousRuns(history, 'now', () => null);
    expect(prev.set.map((r) => r.id)).toEqual(['a-b1']);
    expect(prev.skipped).toEqual([{ batch: 'b2', freezeId: 'a', why: 'model' }]);
  });

  test('a batch judged on another ruler is passed over until it is rejudged onto the current one', () => {
    const history = [run('a', 'now'), run('a', 'b2'), run('a', 'b1'), run('b', 'now'), run('b', 'b2')];
    const ruler = (r: SurfaceRun) => (r.batch === 'b2' && r.freezeId === 'a' ? 'old' : 'new');
    const prev = previousRuns(history, 'now', ruler);
    expect(prev.set.map((r) => r.id).sort()).toEqual(['a-b1', 'b-b2']);
    expect(prev.skipped).toEqual([{ batch: 'b2', freezeId: 'a', why: 'judge' }]);
    // Once b2 is rejudged its ruler matches, and it is the baseline again.
    expect(previousRunSet(history, 'now', () => 'new').map((r) => r.id).sort()).toEqual(['a-b2', 'b-b2']);
  });

  test("a cadence batch pools its own cadence's newest n batches per freeze, and no other run joins", () => {
    const nightly = (freezeId: string, batch: string, status = 'pass') => ({ ...run(freezeId, batch, status), cadence: 'nightly' });
    // Newest first. 'ablation' carries no cadence (its notes may say anything), n4 crashed on a, b skipped n2.
    const history = [nightly('a', 'now'), nightly('b', 'now'), run('a', 'ablation'), { ...nightly('a', 'n4', 'crash') }, nightly('a', 'n3'), nightly('b', 'n3'), nightly('a', 'n2'), nightly('a', 'n1'), nightly('b', 'n1'), nightly('a', 'n0')];
    const pooled = pooledRuns(history, 'now', 'nightly', 3, () => null);
    expect(pooled.set.map((r) => r.id).sort()).toEqual(['a-n1', 'a-n2', 'a-n3', 'b-n1', 'b-n3']);
    expect(pooled.batches).toEqual(['n1', 'n2', 'n3']);
    expect(pooledRuns(history, 'now', 'weekly', 3, () => null).set).toEqual([]);
  });
});

describe('what a rep records', () => {
  const f = { id: 'eeeeeeee-0000-0000-0000-000000000000', name: 'provenance', asOf: '2026-01-01T00:00:00.000Z', tags: [], meta: { surface: 'echo' } } as unknown as Freeze;
  const prepared = (root: string, impl: SurfaceImpl, route: 'call' | 'agent' = 'call'): PreparedFreeze => ({
    f,
    meta: { ...echoMeta, route },
    impl,
    root,
    model: echoMeta.model,
    scenario: 'echo-eeeeeeee',
    loaded: { snap: { text: 'say this back' } },
    mismatch: null,
    run: { freezeId: f.id, notes: null, model: echoMeta.model, route, sourceHash: 'h', budgetUsd: null, gitHead: 'x', dirty: false, dry: true, temperatureReplay: 'cli-default', batch: 'b', title: 'provenance' },
  });
  const runJsonOf = (root: string) => JSON.parse(readFileSync(join(root, readdirSync(root)[0]!, 'run.json'), 'utf8'));

  test("a dry agent rep writes every follow-up turn, and its promptSha covers them", async () => {
    const briefing = (then: string[]): SurfaceImpl => ({
      ...echoImpl,
      async replay(_snap, ctx) {
        await ctx.agent({ prompt: 'the briefing', model: ctx.model, then });
        return { reply: '' };
      },
      gates: () => [],
    });
    const shaFor = async (then: string[]) => {
      const root = mkdtempSync(join(tmpdir(), 'evals-then-'));
      const r = await replayRep(prepared(root, briefing(then), 'agent'), 1, 1, { reps: 1, model: null, dry: true });
      expect(r.crashed).toBe(false);
      return { root, sha: runJsonOf(root).promptSha as string };
    };
    const two = await shaFor(['second turn', 'third turn']);
    const agentDir = join(two.root, readdirSync(two.root)[0]!, 'agent1');
    expect(readFileSync(join(agentDir, 'then2.md'), 'utf8')).toBe('second turn');
    expect(readFileSync(join(agentDir, 'then3.md'), 'utf8')).toBe('third turn');
    expect(two.sha).toMatch(/^[0-9a-f]{64}$/);
    // A follow-up turn's text moves the hash; the same turns hash the same.
    expect((await shaFor(['second turn', 'a changed third turn'])).sha).not.toBe(two.sha);
    expect((await shaFor(['second turn', 'third turn'])).sha).toBe(two.sha);
    expect((await shaFor([])).sha).not.toBe(two.sha);
  });

  test('a rep that dies mid-run records the prompt its surface named, and an agent rep is stamped with the guard that graded it', async () => {
    const named = 'a'.repeat(64);
    const dies: SurfaceImpl = {
      ...echoImpl,
      async replay(_snap, ctx) {
        await ctx.agent({ prompt: `the briefing for ${ctx.runDir}`, model: ctx.model, promptSha: named });
        throw new Error('the agent left its world');
      },
      gates: () => [],
    };
    const root = mkdtempSync(join(tmpdir(), 'evals-named-'));
    const r = await replayRep(prepared(root, dies, 'agent'), 1, 1, { reps: 1, model: null, dry: true });
    expect(r.crashed).toBe(true);
    expect(runJsonOf(root).promptSha).toBe(named);
    // A graded agent rep carries the guard in its ruler; a call rep does not.
    const graded = mkdtempSync(join(tmpdir(), 'evals-guard-'));
    const agentImpl: SurfaceImpl = { ...echoImpl, async replay(_snap, ctx) { await ctx.agent({ prompt: 'p', model: ctx.model }); return { reply: '' }; }, gates: () => [] };
    await replayRep(prepared(graded, agentImpl, 'agent'), 1, 1, { reps: 1, model: null, dry: true });
    const dir = join(graded, readdirSync(graded)[0]!);
    expect(readFileSync(join(dir, GUARD_STAMP), 'utf8').trim()).toBe(guardClassifierSha());
    expect(rulerAt(dir)).toBe(`guard:${guardClassifierSha()}`);
    const call = mkdtempSync(join(tmpdir(), 'evals-noguard-'));
    await replayRep(prepared(call, echoImpl), 1, 1, { reps: 1, model: null, dry: true });
    expect(existsSync(join(call, readdirSync(call)[0]!, GUARD_STAMP))).toBe(false);
  });

  test("the guard's ruler moves with what it classifies, not with its comments", () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-guardsha-'));
    const guard = readFileSync(join(import.meta.dir, '..', '..', '..', 'cli', 'scripts', 'prompt-dry-run-bin', 'cast'), 'utf8');
    const variant = (name: string, text: string) => {
      writeFileSync(join(dir, name), text);
      return guardClassifierSha(join(dir, name));
    };
    const base = variant('base', guard);
    expect(variant('commented', guard.replace('is_read() {', '# a note\nis_read() {'))).toBe(base);
    expect(variant('wider', guard.replace('state) [ "${2:-}" = show ] ;;', 'state) return 0 ;;'))).not.toBe(base);
  });

  test('a stop file stops the check between reps, like a budget stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evals-stopfile-'));
    const stopFile = join(root, '..', `${root.split('/').pop()}.stop`);
    const ledger: RepLedger = { usd: 0 };
    const o = { reps: 2, model: null, dry: true, spent: ledger, stopFile };
    const first = await replayRep(prepared(root, echoImpl), 1, 2, o);
    expect(first.stopped).toBe(false);
    writeFileSync(stopFile, '');
    const second = await replayRep(prepared(root, echoImpl), 2, 2, o);
    expect(second.stopped).toBe(true);
    expect(ledger.stoppedBy).toBe('stop-file');
    const stop = readdirSync(root).find((d) => d.includes('-seed2-'))!;
    expect(JSON.parse(readFileSync(join(root, stop, 'result.json'), 'utf8'))).toMatchObject({ endedBecause: 'budget', stopReason: `stopped by ${stopFile} after $0.0000` });
  });
});
