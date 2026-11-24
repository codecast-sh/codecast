import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Score } from '@platform/evals';

import { buildCloseAdvicePrompt, closeAdviceRequest } from '../../../../convex/convex/closeAdvice';
import type { Fixture } from '../../adapters/resolver';
import { CALL_MODEL } from '../../models';
import { REPO_ROOT } from '../../paths';
import type { CallResult, ReplayCtx, ReplayResult, SurfaceRequest } from '../../surface';
import closeAdvice, { closeAdviceCapture, closeAdviceInputFor, convOf, frozenDb, NO_SESSION_CAPTURE, type CloseAdviceLabel, type CloseAdviceSnap } from './index';
import { classifyNamedWorkState } from '../../../../convex/convex/conversations';
import { meta } from './meta';

const DIR = join(REPO_ROOT, 'packages', 'evals', 'fixtures', 'close-advice');
const fixtures = Object.fromEntries(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture & { snapshot: CloseAdviceSnap; label: CloseAdviceLabel }]),
);
const snapOf = (kase: string) => fixtures[kase]!.snapshot;

/** A ReplayCtx that records each request and answers with a canned reply. */
function recordingCtx(reply: string): { ctx: ReplayCtx; sent: SurfaceRequest[]; calls: CallResult[] } {
  const sent: SurfaceRequest[] = [];
  const calls: CallResult[] = [];
  const ctx = {
    dry: true,
    model: meta.model,
    runDir: '/nonexistent',
    freeze: {} as ReplayCtx['freeze'],
    async call(req: SurfaceRequest) {
      sent.push(req);
      const r: CallResult = { request: req, text: reply, outputTokens: 10, stopReason: 'end_turn', modelUsage: { [req.model]: { outputTokens: 10 } }, costUsd: 0, isError: false, exitCode: 0, dir: '', realMs: 0 };
      calls.push(r);
      return r;
    },
    async agent() {
      throw new Error('close advice makes no agent runs');
    },
  } satisfies ReplayCtx;
  return { ctx, sent, calls };
}

async function replayWith(snap: CloseAdviceSnap, reply: string): Promise<{ result: ReplayResult; sent: SurfaceRequest[] }> {
  const { ctx, sent, calls } = recordingCtx(reply);
  const out = await closeAdvice.replay(snap, ctx);
  return { result: { ...out, calls, agents: [] }, sent };
}

const verdicts = (snap: CloseAdviceSnap, result: ReplayResult, label?: CloseAdviceLabel) => closeAdvice.gates(snap, result, label).map((g) => [g.id, g.pass]);

describe('close-advice replay', () => {
  test('the residue posts the request prod builds from the gathered facts and tail, once, on the prod model', async () => {
    const snap = snapOf('asks-which-channel');
    const input = await closeAdviceInputFor(snap);
    if ('advice' in input) throw new Error('the fixture should reach the model');
    const { sent } = await replayWith(snap, 'VERDICT: needs_you\nREASON: Name the channel.');
    expect(sent).toEqual([closeAdviceRequest(input.facts, input.tail)]);
    expect(sent[0]!.model).toBe(CALL_MODEL);
    // The frozen db hands the gather the moment as prod would: its clock, its title, the final message last.
    const prompt = buildCloseAdvicePrompt(input.facts, input.tail);
    expect(prompt).toContain('Now: 2026-09-01T12:00:00.000Z');
    expect(prompt).toContain('Title: Post the release notes');
    expect(prompt.trimEnd().endsWith("I'll post as soon as you say.")).toBe(true);
    expect(prompt).toMatch(/Agent \[FINAL MESSAGE\]: The release notes are drafted/);
  });

  test('the replay rests on the placement the inbox classifier gives the frozen docs', async () => {
    const placedState = async (snap: CloseAdviceSnap) => {
      const db = frozenDb(snap);
      return (await classifyNamedWorkState({ db }, await convOf(snap, db), snap.now)).state;
    };
    const dormant = snapOf('armed-trigger-decides');
    expect(await placedState(dormant)).toBe('dormant');
    // Without the settled stop the inbox files it needs_input, and the advice goes to the model.
    const conv = { ...dormant.docs.conversations![0]!, settle_verdict: undefined, settle_verdict_at: undefined };
    const unsettled = { ...dormant, docs: { ...dormant.docs, conversations: [conv] } };
    expect(await placedState(unsettled)).toBe('needs_input');
    const { sent } = await replayWith(unsettled, 'VERDICT: close\nREASON: Set the trigger.');
    expect(sent).toHaveLength(1);
    // The model is told the trigger Close keeps, never that nothing will wake it.
    expect(sent[0]!.prompt).toContain('Armed wakes: closing keeps one: stops it, runs its trigger out of sight');
    expect(sent[0]!.prompt).not.toContain('Nothing the system can see will wake this session');
  });

  test('a moment the verified facts decide makes no call, like prod', async () => {
    const { result, sent } = await replayWith(snapOf('armed-trigger-decides'), 'never read');
    expect(sent).toHaveLength(0);
    expect(result.parsed).toMatchObject({ verdict: 'close', decided_by: 'facts' });
    expect(verdicts(snapOf('armed-trigger-decides'), result, fixtures['armed-trigger-decides']!.label)).toEqual([['parse', true], ['label-match', true]]);
  });
});

describe('close-advice frozen db', () => {
  const snap = snapOf('asks-which-channel');

  test('a table the moment did not capture throws; one captured empty answers empty', async () => {
    const { pending_messages: _gone, ...rest } = snap.docs;
    await expect(closeAdviceInputFor({ ...snap, docs: rest })).rejects.toThrow('the moment did not capture table pending_messages');
    expect(await frozenDb(snap).query('pending_messages').collect()).toEqual([]);
  });

  test('a table or id declared uncaptured answers empty or null, and the replay runs', async () => {
    const { pending_messages: _p, users: _u, ...rest } = snap.docs;
    const declared = { ...snap, docs: rest, uncaptured: { tables: { pending_messages: 'not read' }, ids: { 'user-1': 'users row not read' } } };
    expect(await frozenDb(declared).get('user-1')).toBeNull();
    expect(await frozenDb(declared).query('pending_messages').first()).toBeNull();
    const { sent } = await replayWith(declared, 'VERDICT: needs_you\nREASON: Name the channel.');
    expect(sent).toHaveLength(1);
  });

  test('a get of an id the moment neither holds nor declares throws', async () => {
    const { users: _u, ...rest } = snap.docs;
    await expect(closeAdviceInputFor({ ...snap, docs: rest })).rejects.toThrow('the moment holds no document user-1');
  });
});

describe('close-advice gates', () => {
  const snap = snapOf('asks-which-channel');
  const owes: CloseAdviceLabel = { verdict: 'needs_input', why: 'names no channel' };

  test('needs_you parses to needs_input and matches the label', async () => {
    const { result } = await replayWith(snap, 'VERDICT: needs_you\nREASON: Name the channel.');
    expect(verdicts(snap, result, owes)).toEqual([['parse', true], ['no-unsafe-close', true], ['label-match', true]]);
  });

  test('close on a session that still owes the person fails as an unsafe close', async () => {
    const { result } = await replayWith(snap, 'VERDICT: close\nREASON: Drafted the notes.');
    const gates = closeAdvice.gates(snap, result, owes);
    expect(gates.map((g) => [g.id, g.pass])).toEqual([['parse', true], ['no-unsafe-close', false], ['label-match', false]]);
    expect(gates.find((g) => g.id === 'no-unsafe-close')!.evidence?.summary).toBe('unsafe close: it still owes the person (names no channel); advice said close: Drafted the notes.');
  });

  test('needs_you on a finished session is a miss, not an unsafe close', async () => {
    const done = snapOf('delivered-fix-no-ask');
    const { result } = await replayWith(done, 'VERDICT: needs_you\nREASON: Check the export.');
    expect(verdicts(done, result, fixtures['delivered-fix-no-ask']!.label)).toEqual([['parse', true], ['label-match', false]]);
  });

  test('a model "keep" or a missing verdict fails parse; with no label only parse runs', async () => {
    for (const reply of ['VERDICT: keep\nREASON: A trigger wakes it.', 'The session is done.']) {
      const { result } = await replayWith(snap, reply);
      expect(verdicts(snap, result)).toEqual([['parse', false]]);
    }
  });

  test('summarize counts unsafe closes apart from safe-direction misses', () => {
    const score = (failing: string[]): Score => ({ pass: !failing.length, score: failing.length ? 0 : 1, passMark: 1, checks: [], gates: ['parse', 'no-unsafe-close', 'label-match'].map((id) => ({ id, pass: !failing.includes(id), decidedBy: 'mechanical' as const, evidence: { summary: '' } })) });
    const lines = closeAdvice.summarize!([score([]), score(['no-unsafe-close', 'label-match']), score(['label-match']), score(['label-match']), score(['parse', 'label-match'])]);
    expect(lines).toEqual(['unsafe closes 1 · kept but closeable 2 · unparsed 1 · of 5 reps']);
  });
});

describe('close-advice capture', () => {
  test('a moment file freezes its documents and clock, anchored on its newest message', () => {
    const fx = snapOf('delivered-fix-no-ask');
    const path = join(mkdtempSync(join(tmpdir(), 'close-advice-')), 'moment.json');
    writeFileSync(path, JSON.stringify({ ...fx, now: new Date(fx.now).toISOString() }));
    const captured = closeAdviceCapture(path);
    expect(captured.snapshot).toEqual(fx);
    expect(captured.asOf).toBe('2026-09-01T12:00:00.000Z');
    expect(captured.anchor).toEqual({ kind: 'message', id: `${fx.conv_id}-m3` });
    expect(captured.subject).toEqual({ kind: 'session', id: fx.conv_id, title: 'Fix the export button' });
  });

  test('a session ref is refused: freezes come from moment files', async () => {
    for (const ref of ['jx7test', 'jx7test:12']) await expect(closeAdvice.capture(ref, { readConversation: async () => ({}) })).rejects.toThrow(NO_SESSION_CAPTURE);
  });

  test('describe shows the conversation oldest first', () => {
    const msgs = closeAdvice.describe(snapOf('delivered-fix-no-ask'));
    expect(msgs.map((m) => m.from)).toEqual(['user', 'assistant', 'assistant']);
    expect(msgs[0]!.text).toContain('CSV export button');
  });
});
