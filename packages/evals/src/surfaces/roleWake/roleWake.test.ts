import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseScheduledTask, triggerRunFrame } from '@codecast/shared/contracts';

import { ROLE_CHECK_PROMPT } from '../../../../convex/convex/lib/orgRoutine';
import { routeGates } from '../../adapters/replay';
import { readFixture } from '../../adapters/resolver';
import { runSnapshot } from '../../commands/snapshot';
import { REPO_ROOT } from '../../paths';
import { EVERY_READ, readFrozenVerbs, servedReadKey } from '../../served';
import type { AgentResult } from '../../surface';
import impl, { captureRoleWake, frameOf, MAX_SKEW_MS, type RoleWakeDeps, type RoleWakeSnap } from './index';
import { meta } from './meta';
import { harnessNote, readWorld, servedDirFor } from './world';

const GUARD = join(REPO_ROOT, 'packages', 'cli', 'scripts', 'prompt-dry-run-bin', 'cast');
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evals-rolewake-'));
  process.env.CODECAST_EVALS_HOME = home;
});
afterEach(() => {
  delete process.env.CODECAST_EVALS_HOME;
  rmSync(home, { recursive: true, force: true });
});

const fixtureSnap = (kase: string) => readFixture('role-wake', kase).snapshot as RoleWakeSnap;

describe('the frame', () => {
  test("a fixture renders through the server's own frame writer, with the tree's routine prompt", () => {
    const snap = fixtureSnap('docs-check');
    const frame = frameOf(snap);
    expect(frame).toBe(triggerRunFrame({ _id: 'fixture-tr-901', short_id: 'tr-901', title: "Check Docs lead's area", prompt: ROLE_CHECK_PROMPT, role_id: 'fixture-docs' }, { role: snap.fixture!.role, stashed: false }));
    expect(parseScheduledTask(frame)).toMatchObject({ trigger: 'tr-901', role: { handle: 'docs' }, body: ROLE_CHECK_PROMPT });
  });

  test('a needs-input fixture carries the event and the session that waits', () => {
    const parsed = parseScheduledTask(frameOf(fixtureSnap('docs-needs-input')));
    expect(parsed?.event).toBe('session_needs_input');
    expect(parsed?.waiting).toMatchObject({ short_id: 'jx7ref2', decision: 'sd-55' });
  });

  test('a real freeze replays the frame prod built, untouched', () => {
    expect(frameOf({ captured_at: 'x', frame: '<scheduled-task title="t">prod</scheduled-task>' })).toBe('<scheduled-task title="t">prod</scheduled-task>');
  });
});

/** A snapshot as `./evals snapshot role-wake` writes it, from a fake cast. */
function snapshot(name: string, role = 'docs') {
  return runSnapshot('role-wake', ['--trigger', 'tr-901', '--team', 'Fernhill', '--role', role, '--name', name], (argv) => ({ out: `served ${argv.join(' ')}`, code: 0 }));
}

const prodFrame = triggerRunFrame({ _id: 'task1', short_id: 'tr-901', title: "Check Docs lead's area", prompt: ROLE_CHECK_PROMPT, role_id: 'r1' }, { role: { handle: 'docs', name: 'Docs lead', reports_to: 'Mara', scope: ['Docs site'], goals: [] }, stashed: false });

function deps(over: Partial<RoleWakeDeps> = {}): RoleWakeDeps {
  return {
    listTriggers: async () => [{ _id: 'task1', short_id: 'tr-901', title: "Check Docs lead's area", originating_conversation_id: 'conv1', model: null }],
    injectFrame: async (id) => (id === 'task1' ? prodFrame : null),
    readConversation: async () => ({ conversation: { id: 'conv1', model: 'claude-opus-5-5[1m]' }, messages: [] }),
    now: () => Date.now(),
    ...over,
  };
}

describe('capture', () => {
  test("the role's own reads are served under the argv it types, captured as the role", () => {
    const dir = snapshot('s1');
    const read = (argv: string[]) => readFileSync(join(dir, 'reads', `${servedReadKey(argv)}.out`), 'utf8');
    expect(read(['brief'])).toBe('served brief @docs');
    expect(read(['brief', '--json'])).toBe('served brief @docs --json');
    expect(read(['org', 'review'])).toBe('served org review --team Fernhill');
    expect(readFileSync(join(dir, 'frozen'), 'utf8').trim().split('\n')).toEqual(['brief', 'org', 'sessions']);
  });

  test("a trigger freezes prod's frame with the newest snapshot of its world, and the session's model", async () => {
    snapshot('s1');
    const c = await captureRoleWake('tr-901', deps());
    const snap = c.snapshot as RoleWakeSnap;
    expect(snap).toMatchObject({ served: 'role-wake/s1', frame: prodFrame, trigger: { short_id: 'tr-901' } });
    expect(c.asOf).toBe(snap.captured_at);
    expect(c.subject).toMatchObject({ kind: 'session', id: 'conv1' });
    expect(c.meta).toMatchObject({ trigger_id: 'task1', conversation_id: 'conv1', workspace: 'Fernhill', model: 'claude-opus-5-5[1m]' });
    // The snapshot's own name works as the ref too.
    expect(((await captureRoleWake('s1', deps())).snapshot as RoleWakeSnap).served).toBe('role-wake/s1');
  });

  test('refuses a world read too long before the frame, a world captured as another role, and no world at all', async () => {
    await expect(captureRoleWake('tr-901', deps())).rejects.toThrow('capture its world first');
    snapshot('s1');
    await expect(captureRoleWake('tr-901', deps({ now: () => Date.now() + MAX_SKEW_MS + 60_000 }))).rejects.toThrow('must share a moment');
    snapshot('s2', 'growth');
    await expect(captureRoleWake('tr-901', deps())).rejects.toThrow('snapshot again with --role docs');
  });
});

const out = (brief: string | null) => ({ reply: '', parsed: { brief }, calls: [], agents: [] });
const pass = (snap: RoleWakeSnap, brief: string | null) => Object.fromEntries(impl.gates(snap, out(brief)).map((g) => [g.id, g]));

describe('gates', () => {
  const snap = fixtureSnap('docs-check');
  test('brief-parses wants a brief.md with a standing line for a role that looks after something', () => {
    expect(pass(snap, null)['brief-parses']!.pass).toBe(false);
    expect(pass(snap, '## Brief\nAll quiet.')['brief-parses']!.evidence.summary).toContain('Docs site, API reference');
    expect(pass(snap, '## Where it stands\n- Docs site: billing page live. (2026-09-28)')['brief-parses']!.pass).toBe(true);
  });

  test('no-stale-lines fails a line older than a week at the wake, and names it', () => {
    const g = pass(snap, '## Where it stands\n- Docs site: fine. (2026-09-28)\n- API reference: review pending. (2026-09-14)')['no-stale-lines']!;
    expect(g.pass).toBe(false);
    expect(g.evidence.summary).toContain('API reference: review pending. (2026-09-14)');
  });
});

/** Runs the real guard the way a replay's agent does, with no model: what calls.log records decides the route gates. */
function guard(serveDir: string, run: string, ...argv: string[]) {
  const fake = mkdtempSync(join(tmpdir(), 'evals-fakecast-'));
  writeFileSync(join(fake, 'cast'), '#!/bin/sh\necho "LIVE $*"\n');
  chmodSync(join(fake, 'cast'), 0o755);
  const r = Bun.spawnSync(['bash', GUARD, ...argv], { env: { ...process.env, RUN_DIR: run, DRY_RUN_SERVE_DIR: serveDir, PATH: `${fake}:${process.env.PATH}` } });
  return { code: r.exitCode, out: r.stdout.toString() };
}

describe('served reads', () => {
  test("a fixture's reads are served, and deleting one fails frozen-reads with the argv named", () => {
    const runDir = join(home, 'run');
    mkdirSync(runDir, { recursive: true });
    const served = servedDirFor(fixtureSnap('docs-check'), { runDir }, meta);
    // A synthetic world is closed: every read answers from it or fails, so a made-up id never reaches the live workspace.
    expect(readFrozenVerbs(served)).toEqual([EVERY_READ]);
    const agent = (): AgentResult => ({ runSubdir: runDir, said: [], calls: readFileSync(join(runDir, 'calls.log'), 'utf8').split('\n').filter(Boolean), costUsd: 0, modelUsage: { [meta.model]: { outputTokens: 1 } }, isError: false, exitCode: 0, model: meta.model, realMs: 0 });
    const frozen = () => routeGates(meta, { calls: [], agents: [agent()] }).find((g) => g.id === 'frozen-reads')!;

    expect(guard(served, runDir, 'brief')).toMatchObject({ code: 0, out: expect.stringContaining('Docs lead @docs') });
    expect(guard(served, runDir, 'sessions', '--json').code).toBe(0);
    expect(frozen().pass).toBe(true);

    rmSync(join(served, 'reads', `${servedReadKey(['brief'])}.out`));
    expect(guard(served, runDir, 'brief').code).toBe(1);
    const g = frozen();
    expect(g.pass).toBe(false);
    expect(g.evidence.summary).toContain('cast brief was not captured, so it was refused: add it to meta.frozenReads');
  });

  test("a fixture world is closed: the ids its story names are served, and any other read fails, never live", () => {
    const runDir = join(home, 'run');
    mkdirSync(runDir, { recursive: true });
    const served = servedDirFor(fixtureSnap('docs-needs-input'), { runDir }, meta);
    for (const argv of [['plan', 'show', 'pl-31'], ['trigger', 'ls'], ['task', 'ls', '-q', 'webhooks'], ['decide', 'show', 'sd-55'], ['read', 'jx7ref2']]) expect(guard(served, runDir, ...argv).code).toBe(0);
    for (const argv of [['plan', 'show', 'pl-99'], ['trigger', 'show', 'tr-901'], ['feed'], ['search', 'webhooks'], ['project', 'ls'], ['doc', 'ls']]) expect(guard(served, runDir, ...argv)).toMatchObject({ code: 1, out: '' });
    const log = readFileSync(join(runDir, 'calls.log'), 'utf8');
    expect(log).not.toMatch(/^LIVE /m);
    expect(log).toContain('UNSERVED plan show pl-99');
  });

  test("the seat's values serve the role's own brief as the bare argv it types, as a capture's aliases do", () => {
    const runDir = join(home, 'run');
    mkdirSync(runDir, { recursive: true });
    const world = readWorld('fernhill');
    const at = (argv: string[]) => world.reads.find((r) => r.argv.join(' ') === argv.join(' '))!.out;
    const served = servedDirFor(fixtureSnap('docs-check'), { runDir }, meta);
    const read = (argv: string[]) => readFileSync(join(served, 'reads', `${servedReadKey(argv)}.out`), 'utf8');
    expect(read(['brief'])).toBe(at(['brief', '@docs']));
    expect(read(['brief', '--json'])).toBe(at(['brief', '@docs', '--json']));
    // No seat value, no alias: the bare read stays uncaptured.
    const bare = servedDirFor({ captured_at: 'x', world: 'fernhill' }, { runDir: join(home, 'run2') }, meta);
    expect(existsSync(join(bare, 'reads', `${servedReadKey(['brief'])}.out`))).toBe(false);
  });

  test('every fixture reads the shared world, and none carries a copy of it', () => {
    for (const kase of ['docs-check', 'docs-needs-input']) {
      const snap = fixtureSnap(kase);
      expect(snap.world).toBe('fernhill');
      expect(snap.reads ?? []).toEqual([]);
    }
  });
});

describe('the harness note', () => {
  test('says what the served dir actually freezes', () => {
    expect(harnessNote([EVERY_READ])).toContain('Every `cast` read answers from a record of the workspace saved for this turn');
    expect(harnessNote([EVERY_READ])).not.toContain('other reads are live');
    const real = harnessNote(meta.frozenVerbs!);
    expect(real).toContain('Reads under `cast brief`, `cast org` and `cast sessions` answer from a record');
    expect(real).toContain('other reads are live');
  });
});
