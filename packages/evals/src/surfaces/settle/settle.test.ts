import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSettlePrompt, settleRequest, shapeSettleTail } from '../../../../convex/convex/idleSummary';
import { toRows, type CliReadMessage } from '../../adapters/convo';
import type { Fixture } from '../../adapters/resolver';
import { CALL_MODEL } from '../../models';
import { REPO_ROOT } from '../../paths';
import type { CallResult, ReplayCtx, ReplayResult, SurfaceRequest } from '../../surface';
import settle, { settleCapture, type SettleLabel, type SettleSnap } from './index';
import { meta } from './meta';

// The 17 cases came out of packages/convex/scripts/settle-eval.ts (deleted
// once they moved here). Each fingerprint below was taken from that script's
// inline case, rows and label, before the move, so a fixture that drifts from
// what the old suite graded fails here. Change a fixture on purpose and its
// fingerprint changes with it.
const LEGACY_FINGERPRINTS: Record<string, string> = {
  'closing-report-defers-to-meeting': '6ebd6893da4f38464fbdd85797a1d1b2f47d0de9d8eb74f993cfbc545b2b86f3',
  'delivered-summary-no-ask': 'fddc04c5a33baa60c17cb832d08fb68d368c12276db8c3e07ca2d1c9eabf9d7a',
  'delivered-courtesy-offer': 'd83c564412bce289ad9fd0083b46f46b4349bc5507aafb9e2f5ccbfb9910dfe5',
  'blocked-on-credentials': '8b788afbc353454b3ca0d7b6980b97a552c0adbba60813fa965e9d662f8b0f31',
  'options-at-end-of-long-message': '8d6ec6479b8c7f42202cb01698f8d36910c1e9cef49d64b62994eb13ef879448',
  'agent-lists-its-own-next-steps': 'c231be3cc5897a4d1478397f654937cce3207c10e475839fb3bfee3d53e00964',
  'waiting-on-a-person': 'd81ee5df6619b58e2b445959637778ad533a8c8b5bbcdeaaa6619dff01204060',
  'earlier-machine-wait-final-delivers': '0ba15cc614b23f52edc6b80c0c87f0a839feadca7f8ba221f99031c3901560c1',
  'halted-mid-tool-call': '220f94df8712b908b56335e8f5a96a605401258969dbe63dd2783bffa951d276',
  'findings-report-no-ask': 'd3f9364c54329d60301e6079f64c48778a7042c61224c6f4badc95e5bb72ccce',
  'report-hands-human-decisions': 'c1b3d6a3cf865cb2f97089d6b6d3e69115f0d2ef34fa7c13cf0c101508afdd53',
  'single-word-ack': '39764f941558f0f87859985c0eb979545397be47d9f51691c58ff8f2466a0128',
  'yes-no-buried-after-report': '01ac4f8cdc95e4db3ff63dd7603a83bdc9eed1d056fdace9fc7db88a1f3b0a94',
  'unresolvable-error': '84edafcffef8518494a1774756f3f1a072582fc728aca41fc5aae3c7639c5ce2',
  'wrapping-up-no-ask': '6c6e54017fb9a04bee90642bc266135e1960f79948e7d86e500dd49e05f58046',
  'root-cause-fix-proposed': '8bddfeaa26cfd3730973f2081113c302191d4401cb6584c652682b40ed395fc6',
  'design-spec-build-ahead': 'e6bc54003c1f50cd23ad40b3f6c8cf1a62ce2cf3bdd74b1dd9a83c8bfc95c3ff',
};

const DIR = join(REPO_ROOT, 'packages', 'evals', 'fixtures', 'settle');
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ kase: f.replace(/\.json$/, ''), fixture: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture & { snapshot: SettleSnap; label: SettleLabel } }));

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
      throw new Error('settle makes no agent runs');
    },
  } satisfies ReplayCtx;
  return { ctx, sent, calls };
}

async function replayWith(snap: SettleSnap, reply: string): Promise<{ result: ReplayResult; sent: SurfaceRequest[] }> {
  const { ctx, sent, calls } = recordingCtx(reply);
  const out = await settle.replay(snap, ctx);
  return { result: { ...out, calls, agents: [] }, sent };
}

describe('settle fixtures', () => {
  test('all 17 legacy cases moved, rows and labels unchanged', () => {
    const got = Object.fromEntries(fixtures.map(({ kase, fixture }) => [kase, createHash('sha256').update(JSON.stringify({ verdict: fixture.label.verdict, newestFirst: fixture.snapshot.newestFirst })).digest('hex')]));
    expect(got).toEqual(LEGACY_FINGERPRINTS);
  });

  test('each replay sends the request prod builds over the same tail, and nothing else', async () => {
    for (const { kase, fixture } of fixtures) {
      const tail = shapeSettleTail(fixture.snapshot.newestFirst);
      const { sent } = await replayWith(fixture.snapshot, 'VERDICT: done\nSUMMARY: Did it.');
      expect(sent, kase).toHaveLength(1);
      expect(sent[0]!.prompt, kase).toBe(buildSettlePrompt(tail));
      expect(sent[0], kase).toEqual(settleRequest(tail));
      expect(sent[0], kase).toMatchObject({ model: CALL_MODEL, max_tokens: meta.maxTokens!, temperature: meta.prodTemperature as number });
    }
  });
});

describe('settle gates', () => {
  const snap = fixtures[0]!.fixture.snapshot;

  test('a parsed verdict that matches the label passes both gates', async () => {
    const { result } = await replayWith(snap, 'VERDICT: needs_input\nSUMMARY: Choose a fix.');
    expect(settle.gates(snap, result, { verdict: 'needs_input' }).map((g) => [g.id, g.pass])).toEqual([['parse', true], ['label-match', true]]);
  });

  test('the wrong verdict fails label-match and names both', async () => {
    const { result } = await replayWith(snap, 'VERDICT: done\nSUMMARY: Shipped.');
    const match = settle.gates(snap, result, { verdict: 'needs_input' }).find((g) => g.id === 'label-match')!;
    expect(match.pass).toBe(false);
    expect(match.evidence?.summary).toBe('expected needs_input, got done');
  });

  test('a reply with no VERDICT line fails parse; with no label there is no label-match', async () => {
    const { result } = await replayWith(snap, 'The agent finished.');
    expect(settle.gates(snap, result).map((g) => [g.id, g.pass])).toEqual([['parse', false]]);
  });
});

describe('settle snapshot', () => {
  test('describe shows the rows oldest first, ending at the fixture clock', () => {
    const msgs = settle.describe(fixtures.find((f) => f.kase === 'halted-mid-tool-call')!.fixture.snapshot);
    expect(msgs.map((m) => m.text)[3]).toBe('');
    expect(msgs[0]!.text).toBe('ship it');
    expect(msgs.at(-1)!.at).toBe('2026-09-01T12:00:00.000Z');
  });

  test('capture keeps the newest 30 rows up to the moment, newest first, as of that message', () => {
    const messages: CliReadMessage[] = Array.from({ length: 42 }, (_, i) => ({ id: `m${i + 1}`, line: i + 1, role: i % 2 ? 'assistant' : 'user', content: `line ${i + 1}`, timestamp: new Date(Date.UTC(2026, 8, 1, 0, i + 1)).toISOString() }));
    const rows = toRows(messages);
    const captured = settleCapture({ conversation: { id: 'sess123full', title: 'A session' }, rows, at: rows.at(-1)!, line: 42 });
    const snap = captured.snapshot as SettleSnap;
    expect(snap.newestFirst.map((r) => r.line)).toEqual(Array.from({ length: 30 }, (_, i) => 42 - i));
    expect(captured.asOf).toBe('2026-09-01T00:42:00.000Z');
    expect(captured.anchor).toEqual({ kind: 'message', id: 'm42' });
    expect(captured.name).toBe('settle sess123:42');
    expect(captured.meta).toEqual({ conversation_id: 'sess123full', line: 42 });
  });

  test('capture refuses a ref with no line', async () => {
    await expect(settle.capture('sess123', { readConversation: async () => ({}) })).rejects.toThrow('settle@ takes a fixture or a session line');
  });
});
