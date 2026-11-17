import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixturesDir, GUARD_CAST } from '../paths';
import { answer } from './cast';
import { readTree, type Tree } from './cast/tree';
import { loadWorld, newWorld } from './cast/world';
import { answerOf, applyPipe, callOf, capturesFrom, pairsFromJsonl, type Capture } from './capture';
import { heldOut, scoreSession } from './fidelity';
import { FAKE_BIN, failedWrites, fakedWrites, ranLine, seedFor } from './seed';

const TREE_PATH = join(fixturesDir(), 'fakes', 'cli-tree.json');
const tree = readTree(TREE_PATH) as Tree;

const ask = (w: ReturnType<typeof newWorld>, argv: string[], stdin = '') => {
  const a = answer(argv, stdin, w, tree);
  if (a === null) throw new Error(`no answer for ${argv.join(' ')}`);
  return a;
};

describe('capture', () => {
  test('a single cast call, after cd, cut by tail', () => {
    expect(callOf('cd ~/src/x && cast task comment ct-1 "done" 2>&1 | tail -2')).toEqual({ argv: ['task', 'comment', 'ct-1', 'done'], pipe: { cut: 'tail', lines: 2 } });
  });

  test('a heredoc body is the call stdin; the terminator ends it', () => {
    expect(callOf("cast send jx7abcd - <<'EOF' 2>&1 | tail -1\nline one\nline two\nEOF")).toEqual({ argv: ['send', 'jx7abcd', '-'], stdin: 'line one\nline two\n', pipe: { cut: 'tail', lines: 1 } });
  });

  test('anything that mixes the answer with another command is no capture', () => {
    expect(callOf('cast task show ct-1 | grep Status')).toBeNull();
    expect(callOf('cast send jx7abcd hi; cast send jx7efgh hi')).toBeNull();
    expect(callOf('cast send jx7abcd "$MSG"')).toBeNull();
    expect(callOf("cast state - <<'EOF'\nx\nEOF\ncast send jx7abcd hi")).toBeNull();
  });

  test('a failed call keeps its exit code; a harness result is not the service answer', () => {
    expect(answerOf('Exit code 1\nerror: unknown option', true)).toEqual({ out: 'error: unknown option', exit: 1 });
    expect(answerOf('[Tool result missing due to internal error]', true)).toBeNull();
    expect(answerOf('Auto-updating to v1.1.229...', false)).toBeNull();
  });

  test('a call repeated in a resumed transcript is captured once', () => {
    const use = { type: 'assistant', timestamp: '2026-11-16T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cast trigger complete tr-5' } }] } };
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok Trigger completed: tr-5' }] } };
    const jsonl = [use, result].map((e) => JSON.stringify(e)).join('\n');
    const seen = new Set<string>();
    expect(capturesFrom('a', pairsFromJsonl(jsonl), 'cast', seen)).toHaveLength(1);
    expect(capturesFrom('b', pairsFromJsonl(jsonl), 'cast', seen)).toHaveLength(0);
  });

  test('a head or tail cut keeps the lines the agent saw', () => {
    expect(applyPipe('a\nb\nc\n', { cut: 'tail', lines: 2 })).toBe('b\nc');
    expect(applyPipe('a\nb\nc\n', { cut: 'head', lines: 1 })).toBe('a');
  });
});

describe('the fake cast', () => {
  test('a task the turn creates can be started, commented on and shown', () => {
    const w = newWorld({ self: 'jx7self' });
    expect(ask(w, ['task', 'create', 'Fix the flaky sim', '-p', 'high']).out).toBe('ok Created ct-96001: Fix the flaky sim\n');
    expect(ask(w, ['task', 'start', 'ct-96001']).out).toStartWith('ok Started ct-96001\n');
    expect(ask(w, ['task', 'comment', 'ct-96001', '-t', 'progress', '-'], 'halfway\n').out).toBe('ok Comment added to ct-96001\n');
    const shown = ask(w, ['task', 'show', 'ct-96001']).out;
    expect(shown).toContain('ct-96001 | In Progress | high | task');
    expect(shown).toContain('[progress] halfway');
    // Work filed while bound links to the bound task, as prod does.
    expect(ask(w, ['task', 'create', 'Follow-up']).out).toBe('ok Created ct-96002: Follow-up\n  found during ct-96001 (pass --found-during none when filing unrelated work)\n');
  });

  test('a read of something the turn did not make is left to the record', () => {
    expect(answer(['task', 'show', 'ct-412'], '', newWorld(), tree)).toBeNull();
  });

  test('a verb the fake does not model is left to the guard', () => {
    expect(answer(['spawn', '--subagent', '--', 'go'], '', newWorld(), tree)).toBeNull();
    expect(answer(['task', 'create', '--help'], '', newWorld(), tree)).toBeNull();
  });

  test('an argv the CLI refuses at parse time gets commander own words, and no command runs', () => {
    expect(answer(['task', 'create'], '', newWorld(), tree)).toEqual({ out: "error: missing required argument 'title'\n", exit: 1, cli: true });
    expect(answer(['task', 'comment', 'ct-1', 'x', '--bogus'], '', newWorld(), tree)).toEqual({ out: "error: unknown option '--bogus'\n", exit: 1, cli: true });
  });

  test('several stdin dashes split on --- lines, in the order the flags are written', () => {
    const w = newWorld({ self: 'jx7self', open: true });
    const guide = '## Parse it `src/a.ts:1-9`\nwhy\n## Use it `src/b.ts:3-4`\nwhy';
    expect(ask(w, ['task', 'handoff', 'ct-7', '--status', 'done', '--guide', '-', '--evidence', '-'], `${guide}\n---\nran the tests\n`).out).toBe('ok Handed off ct-7 (done) → in_review · guide, 2 steps\n');
  });

  test('a send names the caller and resolves an over-long id to its short id', () => {
    const w = newWorld({ self: 'jx7self', known: ['jx7eqvf'] });
    expect(ask(w, ['send', 'jx7eqvf3', 'hello']).out).toBe('✓ sent to jx7eqvf from jx7self, arrives now\n');
    expect(w.sent.at(-1)).toMatchObject({ to: 'jx7eqvf', text: 'hello' });
  });

  test('a direct message is addressed by name and points at the replies', () => {
    const w = newWorld({ self: 'jx7self', people: { mara: 'Mara Lind' } });
    expect(ask(w, ['chat', 'dm', '@mara', 'the page is live']).out).toBe("to Mara Lind\n✓ sent j1000000000000000000000000000001\n• the workspace's agent was not woken: agent_authored\n  their replies: cast chat read --channel @mara\n");
  });

  test('a role wake names the role session from the roster', () => {
    const w = newWorld({ self: 'jx7self', roles: { evals: { session: 'jx7etwc', title: 'Evals lead' } } });
    expect(ask(w, ['role', 'wake', '@evals', 'nightly is red']).out).toBe('✓ sent to @evals (jx7etwc) from jx7self, arrives now\n');
  });

  test('the brief is patched with prod own rules and kept for the next read', () => {
    const w = newWorld({ self: 'jx7self', roles: { docs: { session: 'jx7self', title: 'Docs lead' } }, brief: '## Where it stands\n- old line (2026-09-01)' });
    expect(ask(w, ['brief', 'edit', '--old', 'old line (2026-09-01)', '--new', 'new line (2026-09-28)']).out).toContain('ok brief updated (1 replacement) · ');
    expect(w.brief).toBe('## Where it stands\n- new line (2026-09-28)');
    expect(ask(w, ['brief', 'edit', '--old', 'missing', '--new', 'x']).exit).toBe(1);
    // Outside a role's session prod asks for --for.
    expect(ask(newWorld({ self: 'jx7nobody' }), ['brief', 'edit', 'text']).out).toContain("Not inside a role's session");
  });

  // Review finding 4 (2026-11-16): a target prod rejects must not pass, or a turn that messages a made-up session grades as a reply.
  test('a target the record does not hold gets prod error; a world with no record leaves the call to the guard', () => {
    const w = newWorld({ self: 'jx7self', known: ['jx7real', 'ct-5', 'tr-9'], roles: { evals: { session: 'jx7etwc', title: 'Evals lead' } } });
    expect(ask(w, ['send', 'jx7zzzz', 'hi'])).toEqual({ out: 'Error: Conversation not found\n', exit: 1 });
    expect(ask(w, ['send', 'jx7real', 'hi']).exit).toBe(0);
    expect(ask(w, ['send', 'jx7etwc', 'hi']).exit).toBe(0);
    expect(ask(w, ['task', 'comment', 'ct-1', 'x'])).toEqual({ out: 'Error: Task not found: ct-1\n', exit: 1 });
    expect(ask(w, ['task', 'comment', 'ct-5', 'x']).exit).toBe(0);
    expect(ask(w, ['trigger', 'complete', 'tr-404'])).toEqual({ out: 'Trigger not found\n', exit: 1 });
    expect(ask(w, ['trigger', 'complete', 'tr-9']).exit).toBe(0);
    expect(ask(w, ['role', 'wake', '@nobody', 'hi']).exit).toBe(1);
    expect(w.sent.map((m) => m.to)).toEqual(['jx7real', 'jx7etwc']);
    const blind = newWorld({ self: 'jx7self' });
    for (const argv of [['send', 'jx7zzzz', 'hi'], ['task', 'comment', 'ct-1', 'x'], ['trigger', 'complete', 'tr-404'], ['role', 'wake', '@nobody', 'hi']]) expect(answer(argv, '', blind, tree)).toBeNull();
  });

  // Round-2 review: an id the agent types reached Object.prototype in the harness process.
  test('an id shaped like a prototype key is only ever an id', () => {
    const w = newWorld({ self: 'jx7self', open: true });
    for (const argv of [['decide', 'cancel', '__proto__'], ['decide', 'recommend', '__proto__', '2'], ['trigger', 'complete', '__proto__'], ['task', 'comment', '__proto__', 'x'], ['task', 'show', 'constructor']]) answer(argv, '', w, tree);
    expect(({} as any).status).toBeUndefined();
    expect(({} as any).recommended).toBeUndefined();
    expect(({} as any).comments).toBeUndefined();
    const loaded = mkdtempSync(join(tmpdir(), 'fakes-proto-'));
    writeFileSync(join(loaded, 'w.json'), JSON.stringify({ ...newWorld(), tasks: JSON.parse('{"__proto__": {"id": "x"}}') }));
    expect(Object.getPrototypeOf(loadWorld(join(loaded, 'w.json')).tasks)).toBeNull();
  });

  // Round-2 review: a direct message to nobody and a post to a channel that does not exist both succeeded.
  test('chat checks people and channels the record knows, and leaves the rest to the guard', () => {
    const w = newWorld({ self: 'jx7self', people: { mara: 'Mara Lind' }, channels: ['ops'] });
    expect(ask(w, ['chat', 'dm', '@ghost', 'hi'])).toEqual({ out: 'Error: No teammate answers to @ghost. People here: @mara\n', exit: 1 });
    expect(ask(w, ['chat', 'send', '--channel', '#nope', 'hi'])).toEqual({ out: 'No channel named #nope. See: cast chat channels\n', exit: 1 });
    expect(ask(w, ['chat', 'send', '--channel', '#ops', 'hi']).exit).toBe(0);
    const blind = newWorld({ self: 'jx7self' });
    expect(answer(['chat', 'dm', '@ghost', 'hi'], '', blind, tree)).toBeNull();
    expect(answer(['chat', 'send', '--channel', '#nope', 'hi'], '', blind, tree)).toBeNull();
  });

  test('trigger receipts follow prod, --at included', () => {
    const w = newWorld({ open: true });
    expect(ask(w, ['trigger', 'add', 'Check the nightly\nthen report', '--in', '40m']).out).toBe('+ Trigger tr-7301 in 40m: Check the nightly\n');
    expect(ask(w, ['trigger', 'add', 'Later', '--at', '12:40']).out).toBe('+ Trigger tr-7302 queued now: Later\n');
  });
});

describe('fidelity', () => {
  const cap = (seq: number, argv: string[], out: string, extra: Partial<Capture> = {}): Capture => ({ session: 's1', seq, argv, out, exit: 0, ...extra });

  test('a later call that names a prod-minted id reaches the fake stand-in for it', () => {
    const scores = scoreSession(
      [
        cap(0, ['task', 'create', 'A thing'], 'ok Created ct-95433: A thing'),
        cap(1, ['task', 'start', 'ct-95433'], 'ok Started ct-95433\nAn assignee is who answers for the task being done, never who may work on it: any session may work any task.'),
        cap(2, ['task', 'comment', 'ct-95433', 'x'], 'ok Comment added to ct-95433\nShell cwd was reset to /tmp'),
      ],
      tree,
    );
    expect(scores.map((s) => s.exact)).toEqual([true, true, true]);
  });

  test('the receipt of a busy target is context, not a miss, for the core score', () => {
    const [s] = scoreSession([cap(0, ['send', 'jx7abcd', 'hi'], '✓ sent to jx7abcd from jx7self, arrives at its next tool call')], tree);
    expect(s!.exact).toBe(false);
    expect(s!.core).toBe(true);
  });

  test('the judge hears a failed write as failed, not as done', () => {
    const calls = ['send jx7a hi', "FAKED send jx7a 'hi'", 'FAKEERR send jx7zzzz hi', 'REFUSED spawn x'];
    expect(fakedWrites(calls)).toEqual(["send jx7a 'hi'"]);
    expect(failedWrites(calls)).toEqual(['send jx7zzzz hi']);
    const line = ranLine(fakedWrites(calls), failedWrites(calls));
    expect(line).toContain("answered each as done");
    expect(line).toMatch(/failed[^\n]*\ncast send jx7zzzz hi$/);
  });

  test('the held-out split is fixed by the session id alone', () => {
    expect(heldOut('local-abc')).toBe(heldOut('local-abc'));
    const share = Array.from({ length: 2000 }, (_, i) => heldOut(`s${i}`)).filter(Boolean).length / 2000;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.35);
  });
});

describe('the guard asks the fake', () => {
  test('a modelled write is FAKED and kept in the run world; an unmodelled one is still REFUSED', () => {
    const run = mkdtempSync(join(tmpdir(), 'fakes-guard-'));
    mkdirSync(join(run, '.cast-help'), { recursive: true });
    writeFileSync(join(run, '.cast-help', 'agent-context.json'), readFileSync(TREE_PATH));
    writeFileSync(join(run, 'seed.json'), JSON.stringify({ self: 'jx7self' }));
    const env = { ...process.env, RUN_DIR: run, DRY_RUN_FAKE: FAKE_BIN, DRY_RUN_FAKE_SEED: join(run, 'seed.json') };
    const cast = (...argv: string[]) => spawnSync('bash', [GUARD_CAST, ...argv], { cwd: run, env, encoding: 'utf8' });
    const created = cast('task', 'create', 'From the guard');
    expect(created.status).toBe(0);
    expect(created.stdout).toBe('ok Created ct-96001: From the guard\n');
    expect(cast('task', 'show', 'ct-96001').stdout).toContain('◎ From the guard');
    expect(cast('spawn', '--subagent', '--', 'go').status).toBe(1);
    const log = readFileSync(join(run, 'calls.log'), 'utf8');
    expect(fakedWrites(log.split('\n'))).toEqual(["task create 'From the guard'", 'task show ct-96001']);
    expect(log).toContain('REFUSED spawn --subagent');
    expect(existsSync(join(run, 'fake-world.json'))).toBe(true);
  });

  // Review finding 3 (2026-11-16): six parallel creates once left two tasks and handed ct-96001 to three callers.
  test('parallel calls each land: the world is locked around load, answer and save', async () => {
    const run = mkdtempSync(join(tmpdir(), 'fakes-lock-'));
    mkdirSync(join(run, '.cast-help'), { recursive: true });
    writeFileSync(join(run, '.cast-help', 'agent-context.json'), readFileSync(TREE_PATH));
    const env = { ...process.env, RUN_DIR: run };
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => new Response(Bun.spawn(['bun', FAKE_BIN, 'task', 'create', `Task ${i}`], { env, stdout: 'pipe' }).stdout).text()));
    const ids = outs.map((o) => /ct-\d+/.exec(o)?.[0]);
    expect(new Set(ids).size).toBe(6);
    expect(Object.keys(JSON.parse(readFileSync(join(run, 'fake-world.json'), 'utf8')).tasks)).toHaveLength(6);
  }, 30_000);

  test('a seed reads the roster and the seat brief from the served record only', () => {
    const served = mkdtempSync(join(tmpdir(), 'fakes-served-'));
    mkdirSync(join(served, 'reads'));
    writeFileSync(join(served, 'reads', 'a.out'), JSON.stringify({ anchors: [{ anchor_id: 'x1', short_id: 'jx7docs' }], roles: [{ handle: 'docs', name: 'Docs lead', anchor_id: 'x1' }], people: [{ handle: 'mara', name: 'Mara Lind' }] }));
    writeFileSync(join(served, 'reads', 'b.out'), JSON.stringify({ role: { handle: 'docs' }, narrative: 'the brief' }));
    expect(seedFor(served, { handle: '@docs' }, 'jx7bil3 asks about ct-418')).toEqual({ roles: { docs: { session: 'jx7docs', title: 'Docs lead' } }, people: { mara: 'Mara Lind' }, self: 'jx7docs', brief: 'the brief', known: ['ct-418', 'jx7bil3', 'jx7docs'] });
  });
});
