import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Freeze } from '@platform/evals';

import { suggestRequest } from '../../../../convex/convex/composerSuggestions';
import { toRows, type CliReadMessage } from '../../adapters/convo';
import { routeGates } from '../../adapters/replay';
import { JUDGE_MODEL } from '../../models';
import { fixturesDir } from '../../paths';
import type { CallResult, ReplayCtx, ReplayResult, SurfaceRequest } from '../../surface';
import impl, { contextOf, gradeTotals, isMoment, momentSnapshot, momentsIn, scrubTruth, type Read, type SuggestSnap } from './index';
import { meta } from './meta';

// The suggest surface with no network and no model: the pair finding ported
// from the retired suggest eval script, the snapshot a capture writes, a
// replay whose request is prod's own, and the grades a fake grader hands back.

const fixture = (name: string): SuggestSnap => JSON.parse(readFileSync(join(fixturesDir(), 'suggest', `${name}.json`), 'utf8')).snapshot;

const msg = (line: number, role: string, content: string, extra: Partial<CliReadMessage> = {}): CliReadMessage => ({ id: `msg-${line}`, line, role, content, timestamp: new Date(Date.UTC(2026, 2, 1, 10, 0, line)).toISOString(), ...extra });

const READ: Read = {
  conversation: { id: 'conv-1', title: 'Rename the flag', message_count: 9, project_path: '/work/app' } as Read['conversation'],
  messages: [
    msg(1, 'user', 'rename the --fast flag to --quick'),
    msg(2, 'assistant', 'Renamed it in the parser and the help text. Want me to keep --fast as a hidden alias?'),
    msg(3, 'user', 'yes keep it hidden for one release'),
    msg(4, 'assistant', 'Working on it.', { tool_calls: [{ id: 't1', name: 'Edit' }] }),
    msg(5, 'user', '', { tool_results: [{ tool_use_id: 't1', content: 'ok' }] }),
    msg(6, 'assistant', 'Done, the alias is in.'),
    msg(7, 'user', '<teammate-message from="other">please rebase</teammate-message>'),
    msg(8, 'assistant', 'Rebased.'),
    msg(9, 'user', 'continue'),
  ],
};

const call = (req: SurfaceRequest, text: string, over: Partial<CallResult> = {}): CallResult => ({ request: req, text, outputTokens: 20, stopReason: 'end_turn', modelUsage: { [req.model]: { outputTokens: 20 } }, costUsd: 0.001, isError: false, exitCode: 0, dir: '/tmp/x', realMs: 1, ...over });

/** A ReplayCtx whose suggester answers `pills` and whose grader answers `grade`. */
function fakeCtx(pills: string, grade = '{"grade":"hit","why":"same request"}', over: Partial<CallResult> = {}) {
  const calls: CallResult[] = [];
  const ctx: ReplayCtx = {
    dry: false,
    model: meta.model,
    runDir: '/tmp/x',
    freeze: {} as Freeze,
    async call(req, opts) {
      const r = call(req, req.model === JUDGE_MODEL ? grade : pills, req.model === JUDGE_MODEL ? {} : over);
      if (opts?.grader) r.grader = true;
      calls.push(r);
      return r;
    },
    agent: async () => {
      throw new Error('no agents here');
    },
  };
  return { ctx, calls };
}

async function replay(snap: SuggestSnap, pills: string, grade?: string, over?: Partial<CallResult>) {
  const { ctx, calls } = fakeCtx(pills, grade, over);
  const out = await impl.replay(snap, ctx);
  const result: ReplayResult = { ...out, calls, agents: [] };
  return { result, calls, gates: impl.gates(snap, result), checks: impl.checks!(snap, result) };
}

describe('moments: an agent turn the developer replied to by typing', () => {
  test('finds typed replies newest first, flags nudges, skips carriers and tool rows', () => {
    expect(momentsIn(toRows(READ.messages))).toEqual([
      { line: 9, nudge: true },
      { line: 3, nudge: false },
    ]);
  });

  test('a reply delivered as a paste counts as typed, and its truth is the text inside the wrapper', () => {
    const read: Read = { ...READ, messages: [msg(1, 'assistant', 'Merge now or wait for CI?'), msg(2, 'user', '<pasted_content id="7">\nwait for ci, then merge\n</pasted_content>')] };
    expect(momentsIn(toRows(read.messages))).toEqual([{ line: 2, nudge: false }]);
    expect((momentSnapshot(read, 'conv-1', 2, { frequent: [], recent: [], generated_at: 1 }).snapshot as SuggestSnap).truth).toBe('wait for ci, then merge');
  });

  test('a pasted wall is not a reply', () => {
    const rows = toRows([msg(1, 'assistant', 'Which file?'), msg(2, 'user', 'x'.repeat(2001))]);
    expect(isMoment(rows[0], rows[1])).toBe(false);
  });

  test('a capture keeps the rows up to the agent turn and holds the reply out as the truth', () => {
    const profile = { frequent: [], recent: ['earlier'], generated_at: 1 };
    const c = momentSnapshot(READ, 'conv-1', 3, profile);
    const snap = c.snapshot as SuggestSnap;
    expect(snap.truth).toBe('yes keep it hidden for one release');
    expect(snap.rows.map((r) => r.line)).toEqual([1, 2]);
    expect(snap.conversation).toEqual({ title: 'Rename the flag', project_path: '/work/app' });
    expect(snap.profile).toBe(profile);
    expect(c.asOf).toBe(READ.messages[1]!.timestamp);
    expect(c.anchor).toEqual({ kind: 'message', id: 'msg-3' });
    expect(c.meta?.snapshot_approximate).toBeArray();
  });

  test('a line that is not a moment names the moments nearby', () => {
    expect(() => momentSnapshot(READ, 'conv-1', 5, { frequent: [], recent: [], generated_at: 1 })).toThrow('moments nearby: suggest@conv-1:9 (nudge), suggest@conv-1:3');
  });

  test('tool payloads stay behind: a tool row keeps only its count', () => {
    const read: Read = { ...READ, messages: [...READ.messages.slice(0, 5), msg(6, 'assistant', 'Done?'), msg(7, 'user', 'ship it after the tests pass')] };
    const snap = momentSnapshot(read, 'conv-1', 7, { frequent: [], recent: [], generated_at: 1 }).snapshot as SuggestSnap;
    expect(snap.rows.find((r) => r.line === 5)?.tool_results).toEqual([{}]);
    expect(JSON.stringify(snap.rows)).not.toContain('"ok"');
  });
});

describe('replay', () => {
  test('the suggester gets the request prod posts, with the truth scrubbed from the profile', async () => {
    const snap = fixture('approve-plan');
    const { calls } = await replay(snap, '[{"text":"go ahead, and add a regression test that fails before the fix and passes after it","confidence":0.9}]');
    expect(calls[0]!.request).toEqual(suggestRequest(contextOf(snap), scrubTruth(snap.profile, snap.truth)));
    const recent = calls[0]!.request.prompt.split('Their most recent messages')[1]!.split('Conversation:')[0]!;
    expect(snap.profile.recent).toContain(snap.truth);
    expect(recent).not.toContain(snap.truth);
  });

  test('a hit: one suggester call, one grader call on the judge model, every gate passes', async () => {
    const snap = fixture('approve-plan');
    const { result, calls, gates, checks } = await replay(snap, '[{"text":"go ahead, and add a regression test that fails before the fix and passes after it","confidence":0.9}]');
    expect(calls.map((c) => [c.request.model, Boolean(c.grader)])).toEqual([
      [meta.model, false],
      [JUDGE_MODEL, true],
    ]);
    expect(calls[1]!.request.prompt).toContain(snap.truth);
    expect([...routeGates(meta, result), ...gates].every((g) => g.pass)).toBe(true);
    expect(checks).toEqual([expect.objectContaining({ id: 'grade', score: 1, evidence: expect.stringMatching(/^grade=hit;/) })]);
  });

  test('no pills is silent, graded without a model call, and passes', async () => {
    const { calls, gates, checks } = await replay(fixture('correction'), '[]');
    expect(calls).toHaveLength(1);
    expect(gates.every((g) => g.pass)).toBe(true);
    expect(checks[0]).toMatchObject({ score: 0.7, evidence: expect.stringMatching(/^grade=silent;/) });
  });

  test('a shown pill the grader calls a miss scores zero', async () => {
    const { checks } = await replay(fixture('correction'), '[{"text":"add a test for the export","confidence":0.8}]', '{"grade":"miss","why":"the developer corrected the format"}');
    expect(checks[0]).toMatchObject({ score: 0, reasoning: 'the developer corrected the format' });
  });

  test('a bare nudge truth is graded apart, with no grader call', async () => {
    const snap = { ...fixture('correction'), truth: 'continue' };
    const { calls, checks } = await replay(snap, '[{"text":"export it as csv","confidence":0.8}]');
    expect(calls).toHaveLength(1);
    expect(checks[0]!.evidence).toMatch(/^grade=nudge-shown;/);
  });

  test('a failed completion or unparseable reply fails pipeline-ok', async () => {
    const failed = await replay(fixture('correction'), '', undefined, { isError: true });
    expect(failed.gates).toEqual([expect.objectContaining({ id: 'pipeline-ok', pass: false, evidence: { summary: 'the pipeline failed: provider_failed' } })]);
    const garbled = await replay(fixture('correction'), 'I would suggest nothing here.');
    expect(garbled.gates[0]).toMatchObject({ pass: false, evidence: { summary: 'the pipeline failed: invalid_json' } });
  });

  test('a grader that returns no grade fails the graded gate', async () => {
    const { gates } = await replay(fixture('approve-plan'), '[{"text":"go ahead, and add a regression test that fails before the fix and passes after it","confidence":0.9}]', 'not json');
    expect(gates.find((g) => g.id === 'graded')).toMatchObject({ pass: false });
  });

  test('a dry run answers [] and spends nothing on the grader', async () => {
    const { ctx, calls } = fakeCtx('ignored');
    const out = await impl.replay(fixture('approve-plan'), { ...ctx, dry: true });
    expect(calls).toHaveLength(1);
    expect(out.parsed).toMatchObject({ suggestions: [], grade: 'silent' });
  });
});

describe('what check prints and the views show', () => {
  test('grade totals: precision over shown pills, coverage over substantive moments', () => {
    expect(gradeTotals(['hit', 'miss', 'silent', 'silent', 'nudge-silent'])).toEqual({ n: 4, hit: 1, partial: 0, miss: 1, silent: 2, nudgeSilent: 1, nudgeShown: 0, precision: 0.5, coverage: 0.25 });
  });

  test('summarize reads the grade from each rep', () => {
    const score = (g: string) => ({ checks: [{ id: 'grade', weight: 1, score: 1, evidence: `grade=${g}; typed: x` }] }) as never;
    expect(impl.summarize!([score('hit'), score('partial'), score('silent')])).toEqual(['grades: hit 1 partial 1 miss 0 silent 1 | precision 50% coverage 33% | nudge moments: silent 0 shown 0']);
  });

  test('describe shows the context, then the truth after the moment', () => {
    const snap = fixture('approve-plan');
    const msgs = impl.describe(snap);
    const asOf = JSON.parse(readFileSync(join(fixturesDir(), 'suggest', 'approve-plan.json'), 'utf8')).asOf;
    expect(msgs.at(-1)).toMatchObject({ direction: 'in', text: snap.truth });
    expect(Date.parse(msgs.at(-1)!.at)).toBeGreaterThan(Date.parse(asOf));
    expect(msgs.slice(0, -1).every((m) => Date.parse(m.at) <= Date.parse(asOf))).toBe(true);
  });
});
