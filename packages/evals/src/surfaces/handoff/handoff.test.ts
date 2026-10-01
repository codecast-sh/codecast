import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeHandoffPrompt } from '../../../../shared/contracts/handoffPrompt';
import { buildHandoffBriefPrompt, handoffBriefInput, shapeHandoffTranscript } from '../../../../convex/convex/handoff';
import type { Fixture } from '../../adapters/resolver';
import { REPO_ROOT } from '../../paths';
import type { CallResult, ReplayCtx, ReplayResult, SurfaceRequest } from '../../surface';
import handoff, { parseHandoffPrompt, type HandoffSnap } from './index';
import { meta } from './meta';

const DIR = join(REPO_ROOT, 'packages', 'evals', 'fixtures', 'handoff');
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ kase: f.replace(/\.json$/, ''), fixture: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture & { snapshot: HandoffSnap } }));

async function replay(snap: HandoffSnap, reply: string) {
  const calls: CallResult[] = [];
  const ctx = {
    dry: true,
    model: meta.model,
    runDir: '/nonexistent',
    freeze: {} as ReplayCtx['freeze'],
    async call(req: SurfaceRequest) {
      const r: CallResult = { request: req, text: reply, outputTokens: 10, stopReason: 'end_turn', modelUsage: { [req.model]: { outputTokens: 10 } }, costUsd: 0, isError: false, exitCode: 0, dir: '', realMs: 0 };
      calls.push(r);
      return r;
    },
    async agent(): Promise<never> {
      throw new Error('handoff makes no agent run');
    },
  } satisfies ReplayCtx;
  const out = await handoff.replay(snap, ctx);
  const result: ReplayResult = { ...out, calls, agents: [] };
  return { calls, result, gates: handoff.gates(snap, result) };
}

describe('the handoff replay', () => {
  test("every fixture sends prod's brief prompt over its rows and facts, at prod's cap", async () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
    for (const { kase, fixture } of fixtures) {
      const { calls, gates } = await replay(fixture.snapshot, '## Goal\nShip it.\n\n## Next steps\n1. Run the tests.');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.request.max_tokens).toBe(meta.maxTokens!);
      expect(calls[0]!.request.prompt).toBe(buildHandoffBriefPrompt(handoffBriefInput(fixture.snapshot.facts, shapeHandoffTranscript(fixture.snapshot.rows))));
      expect(gates.every((g) => g.pass), kase).toBe(true);
    }
  });

  test('a source with nothing readable gets the fallback brief and no call, as in prod', async () => {
    const snap: HandoffSnap = { rows: [{ role: 'user', content: '', timestamp: 1, line: 1, tool_results: [{}] }], facts: { title: 'T', agent_type: 'claude_code', model: null, thread_state: null, task_short_id: null, plan_short_id: null } };
    const { calls, result } = await replay(snap, 'unused');
    expect(calls).toHaveLength(0);
    expect(result.reply).toContain('No model brief was available');
  });

  test('no-refusal fails a first-person refusal, non-empty an empty brief', async () => {
    const snap = fixtures[0]!.fixture.snapshot;
    expect((await replay(snap, "I can't write a brief for this.")).gates.find((g) => g.id === 'no-refusal')!.pass).toBe(false);
    expect((await replay(snap, '  ')).gates.find((g) => g.id === 'non-empty')!.pass).toBe(false);
  });

  test('the judge sees the facts and the shaped turns at their own lines', () => {
    const snap = fixtures.find((f) => f.kase === 'ledger-migration-bound')!.fixture.snapshot;
    const view = handoff.describe(snap);
    expect(view[0]!.text).toContain('Bound task: ct-101');
    const turns = view.slice(1);
    expect(turns).toHaveLength(shapeHandoffTranscript(snap.rows).length);
    expect(turns.map((m) => m.n)).toEqual([...turns.map((m) => m.n)].sort((a, b) => a - b));
    expect(turns.at(-1)!.n).toBe(Math.max(...snap.rows.map((r) => r.line)));
  });
});

describe('a real handoff', () => {
  const prompt = composeHandoffPrompt({
    source: { short_id: 'jx7abcd', title: 'Fix the login test', agent_type: 'claude_code', model: 'opus', message_count: 42, task_short_id: 'ct-9', plan_short_id: null },
    brief: '## Goal\nFix it.\n\n## Next steps\n1. Push.',
  });

  test("parseHandoffPrompt reads composeHandoffPrompt's output back, inside a paste wrapper too", () => {
    const want = { source: 'jx7abcd', title: 'Fix the login test', model: 'opus', brief: '## Goal\nFix it.\n\n## Next steps\n1. Push.', task: 'ct-9', plan: null };
    expect(parseHandoffPrompt(prompt)).toEqual(want);
    expect(parseHandoffPrompt(`\n\n<pasted_content id="1">\n${prompt}</pasted_content>`)).toEqual(want);
    expect(parseHandoffPrompt('just a prompt')).toBeNull();
  });

  test('productionReply is the brief prod wrote into the child, and null without one', () => {
    const snap = { ...fixtures[0]!.fixture.snapshot, production: { child: 'child', at: 1_768_500_000_000, brief: 'the brief' } };
    expect(handoff.productionReply?.(snap)?.messages[0]?.text).toBe('the brief');
    expect(handoff.productionReply?.(fixtures[0]!.fixture.snapshot)).toBeNull();
  });
});
