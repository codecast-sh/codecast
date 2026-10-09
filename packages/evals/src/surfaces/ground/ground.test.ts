import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { groundRequest } from '../../../../convex/convex/lineGround';
import { groundCausePrompt } from '../../../../shared/contracts/goalsBrief';
import type { Fixture } from '../../adapters/resolver';
import { STRONG_MODEL } from '../../models';
import { REPO_ROOT } from '../../paths';
import type { CallResult, ReplayCtx, ReplayResult, SurfaceRequest } from '../../surface';
import ground, { groundSnapFrom, type GroundLabel, type GroundSnap } from './index';
import { meta } from './meta';

const DIR = join(REPO_ROOT, 'packages', 'evals', 'fixtures', 'ground');
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ kase: f.replace(/\.json$/, ''), fixture: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture & { snapshot: GroundSnap; label?: GroundLabel } }));

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
      throw new Error('ground makes no agent runs');
    },
  } satisfies ReplayCtx;
  return { ctx, sent, calls };
}

async function replayWith(snap: GroundSnap, reply: string): Promise<{ result: ReplayResult; sent: SurfaceRequest[] }> {
  const { ctx, sent, calls } = recordingCtx(reply);
  const out = await ground.replay(snap, ctx);
  return { result: { ...out, calls, agents: [] }, sent };
}

const answer = (fields: Record<string, string>) => `\`\`\`json\n${JSON.stringify({ risk: 'review', note: 'why', ...fields })}\n\`\`\``;

describe('ground replay', () => {
  test('each fixture sends exactly the request the server posts, on its model and budget', async () => {
    for (const { kase, fixture } of fixtures) {
      const { sent } = await replayWith(fixture.snapshot, answer({ goal_ref: 'none', category: 'code', readiness: 'ready' }));
      const { system, prompt } = groundCausePrompt(fixture.snapshot.cause, fixture.snapshot.brief, fixture.snapshot.now);
      expect(sent, kase).toHaveLength(1);
      expect(sent[0], kase).toEqual(groundRequest(fixture.snapshot.cause, fixture.snapshot.brief, fixture.snapshot.now));
      expect(sent[0]!.system, kase).toBe(system);
      expect(sent[0]!.prompt, kase).toBe(prompt);
      expect(sent[0]!.model, kase).toBe(STRONG_MODEL);
      expect(sent[0]!.max_tokens, kase).toBe(2000);
    }
  });
});

describe('ground gates', () => {
  const snap = fixtures.find((f) => f.kase === 'checkout-totals-wrong')!.fixture.snapshot;
  const ids = (gs: Array<{ id: string; pass: boolean }>) => gs.map((g) => [g.id, g.pass]);

  test('a reply matching every labeled field passes parse and each match', async () => {
    const { result } = await replayWith(snap, answer({ goal_ref: 'pj-12', category: 'code', readiness: 'ready' }));
    expect(ids(ground.gates(snap, result, { goal_ref: 'pj-12', category: 'code', readiness: 'ready' }))).toEqual([['parse', true], ['goal-ref-match', true], ['category-match', true], ['readiness-match', true]]);
  });

  test('a wrong goal fails only its gate, naming both', async () => {
    const { result } = await replayWith(snap, answer({ goal_ref: 'pj-14', category: 'code', readiness: 'ready' }));
    const gates = ground.gates(snap, result, { goal_ref: 'pj-12', category: 'code' });
    expect(ids(gates)).toEqual([['parse', true], ['goal-ref-match', false], ['category-match', true]]);
    expect(gates[1]!.evidence?.summary).toBe('expected pj-12, got pj-14');
  });

  test('a goal_ref the brief does not offer fails parse with the reader\'s reason', async () => {
    const { result } = await replayWith(snap, answer({ goal_ref: 'pj-99', category: 'code', readiness: 'ready' }));
    const gates = ground.gates(snap, result, { category: 'code' });
    expect(ids(gates)).toEqual([['parse', false], ['category-match', false]]);
    expect(gates[0]!.evidence?.summary).toBe('goal_ref "pj-99" is not a ref the brief offers');
  });

  test('prose with no JSON fails parse; with no label there is only parse', async () => {
    const { result } = await replayWith(snap, 'It threatens checkout.');
    expect(ids(ground.gates(snap, result))).toEqual([['parse', false]]);
  });
});

describe('ground capture', () => {
  test('cuts signals and comments at the moment, newest signals first, comments oldest first, and drops the principles', () => {
    const task = { short_id: 'ct-1', title: 'T', _creationTime: 1000.5, priority: 'high', cause: { signal_count: 2, first_seen: 1000, last_seen: 3000 }, comments: [{ author: 'ground', text: 'Grounded', created_at: 5000 }, { author: 'Dana', text: 'b', created_at: 2000 }, { author: 'Ann', text: 'a', created_at: 1500 }] };
    const signals = [{ source: 's', kind: 'bug', title: 'one', observed_at: 1000, created_at: 1000, short_id: 'sg-1' }, { source: 's', kind: 'bug', title: 'later', observed_at: 6000, created_at: 6000 }, { source: 's', kind: 'bug', title: 'two', observed_at: 3000, created_at: 3000 }];
    const snap = groundSnapFrom(task, signals, { workspace: 'team:x', initiatives: [], projects: [], principles: '# P' }, 5000);
    expect(snap.cause.signals.map((s) => s.title)).toEqual(['two', 'one']);
    expect(snap.cause.signals[0]).toEqual({ source: 's', kind: 'bug', title: 'two', subject: undefined, goal_hint: undefined, detail_md: undefined, observed_at: 3000 });
    expect(snap.cause.comments.map((c) => c.text)).toEqual(['a', 'b']);
    expect(snap.brief).toEqual({ workspace: 'team:x', initiatives: [], projects: [] });
    expect(snap.cause.created_at).toBe(1000.5);
  });

  test('capture refuses a ref that is not a cause', async () => {
    await expect(ground.capture('jx7abc:3', { readConversation: async () => ({}) })).rejects.toThrow('ground@ takes a fixture or a cause');
  });
});
