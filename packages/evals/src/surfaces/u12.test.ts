import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pickSpineRows, selectTitleInput, titleRequest } from '../../../convex/convex/titleGeneration';
import { insightRequest, selectInsightContext } from '../../../convex/convex/sessionInsights';
import { callSummaryRequest, callSummarySource } from '../../../convex/convex/transcripts';
import { routeGates } from '../adapters/replay';
import type { CallResult, ReplayResult, SurfaceRequest } from '../surface';
import callSummary, { callSnapshot, callSummarySurfaceRequest, type CallSummarySnap } from './callSummary';
import { meta as callSummaryMeta } from './callSummary/meta';
import insight, { insightSurfaceRequest, type InsightSnap } from './insight';
import title, { titleSnapshotRows, titleSurfaceRequest, type TitleSnap } from './title';

// U12's surfaces (title, insight, call-summary): each fixture's request is the
// one prod's own builder makes from the same input, and each gate passes a
// good reply and fails the reply it exists to catch. No model calls.

const fixture = (surface: string, kase: string) => JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'fixtures', surface, `${kase}.json`), 'utf8'));

const call = (request: SurfaceRequest, text: string): CallResult => ({
  request,
  text,
  outputTokens: 50,
  stopReason: 'end_turn',
  modelUsage: { [request.model]: { outputTokens: 50 } },
  costUsd: 0,
  isError: false,
  exitCode: 0,
  dir: '/tmp/x',
  realMs: 0,
});
const result = (reply: string, parsed: unknown, calls: CallResult[]): ReplayResult => ({ reply, parsed, calls, agents: [] });
const byId = (gates: Array<{ id: string; pass: boolean }>) => Object.fromEntries(gates.map((g) => [g.id, g.pass]));

/** Runs a surface's replay against a canned reply, then its gates. */
async function replayWith(impl: typeof title, snap: unknown, text: string) {
  const calls: CallResult[] = [];
  const out = await impl.replay(snap, {
    dry: false,
    model: 'm',
    runDir: '/tmp/x',
    freeze: {} as never,
    async call(req) {
      const c = call(req, text);
      calls.push(c);
      return c;
    },
    agent: async () => {
      throw new Error('no agents here');
    },
  });
  const r = result(out.reply, out.parsed, calls);
  return { out: r, gates: byId(impl.gates(snap, r)) };
}

describe('title', () => {
  test('a fixture posts what prod builds from the same rows', () => {
    const snap: TitleSnap = fixture('title', 'rate-limit-done').snapshot;
    expect(titleSurfaceRequest(snap)).toEqual(titleRequest(selectTitleInput({ spine: snap.spine!, latest: snap.latest! }, snap.conversation!)));
  });

  test('titleSnapshotRows keeps what the selector reads and drops tool output', () => {
    const rows = [
      { _id: 'a', role: 'user', content: 'build the thing', timestamp: 1, line: 1 },
      { _id: 'b', role: 'user', content: '', timestamp: 2, line: 2, tool_results: [{ tool_use_id: 't', content: 'secret output' }] },
      { _id: 'c', role: 'assistant', content: 'built', timestamp: 3, line: 3 },
    ];
    const snap = titleSnapshotRows(rows);
    expect(snap.spine).toEqual(pickSpineRows(rows).map((r) => ({ _id: r._id, role: r.role, content: r.content, timestamp: r.timestamp, line: r.line })));
    expect(JSON.stringify(snap)).not.toContain('secret output');
    const full = selectTitleInput({ spine: pickSpineRows(rows), latest: [...rows].reverse() }, {});
    expect(selectTitleInput({ spine: snap.spine!, latest: snap.latest! }, {})).toEqual(full);
  });

  test('the short-title nonce is pinned so a freeze keeps one prompt', () => {
    const snap: TitleSnap = fixture('title', 'short-name-plan').snapshot;
    const a = titleSurfaceRequest(snap);
    expect(a.prompt).toContain('untrusted-00000000');
    expect(titleSurfaceRequest(snap)).toEqual(a);
  });

  test('gates: a clean title passes; no JSON, a long name and refusal prose fail', async () => {
    const snap: TitleSnap = fixture('title', 'rate-limit-done').snapshot;
    const good = await replayWith(title, snap, '{"title": "Webhook rate limiting", "short_title": "Rate limits", "subtitle": "- Per sender limits in Redis\\n- Tests pass"}');
    expect(good.gates).toEqual({ parse: true, clean: true, 'no-refusal': true });
    expect(good.out.reply).toBe('Title: Webhook rate limiting\nShort title: Rate limits\nSubtitle:\n- Per sender limits in Redis\n- Tests pass');
    expect((await replayWith(title, snap, 'I cannot title this.')).gates.parse).toBe(false);
    expect((await replayWith(title, snap, '{"title": "Webhook rate limiting", "short_title": "Per sender webhook rate limiting work"}')).gates.clean).toBe(false);
    const refusal = await replayWith(title, snap, '{"title": "Webhook rate limiting", "short_title": "Rate limits", "subtitle": "I don\'t see a recent conversation to summarize."}');
    expect(refusal.gates['no-refusal']).toBe(false);
  });

  test('productionReply is the captured title, marked as possibly later', () => {
    const snap: TitleSnap = { ...fixture('title', 'rate-limit-done').snapshot, currentTitle: 'Webhook limits' };
    expect(title.productionReply!(snap)!.messages[0]!.text).toBe('Webhook limits\n(current title, may postdate the moment)');
    expect(title.productionReply!(fixture('title', 'rate-limit-done').snapshot)).toBeNull();
  });
});

describe('insight', () => {
  test('a fixture posts what prod builds from the same rows', () => {
    const snap: InsightSnap = fixture('insight', 'rate-limit-done').snapshot;
    expect(insightSurfaceRequest(snap)).toEqual(insightRequest({ ...selectInsightContext(snap.rows), conversation: snap.conversation, commits: snap.commits, prs: snap.prs }, snap.source));
    expect(insightSurfaceRequest(snap).prompt).toContain('Tool names seen:\nGrep, Read, Write, Edit, Bash');
  });

  test('gates: every asked field parses, or the gate names what is missing', async () => {
    const snap: InsightSnap = fixture('insight', 'rate-limit-done').snapshot;
    const good = await replayWith(insight, snap, '```json\n{"headline": "Rate limited billing webhooks per sender", "turns": [{"ask": "Add rate limiting", "did": ["Added a Redis token bucket"]}], "summary": "Done.", "outcome_type": "progress", "themes": ["webhooks"], "confidence": 0.8}\n```');
    expect(good.gates).toEqual({ parse: true });
    const partial = await replayWith(insight, snap, '{"headline": "x", "summary": "y", "themes": ["z"]}');
    expect(partial.gates).toEqual({ parse: false });
    expect(insight.gates(snap, partial.out)[0]!.evidence.summary).toContain('turns, confidence');
    expect((await replayWith(insight, snap, 'not json')).gates).toEqual({ parse: false });
    expect((await replayWith(insight, snap, 'null')).gates).toEqual({ parse: false });
    expect(insight.productionReply!(snap)).toBeNull();
  });
});

describe('call-summary', () => {
  test('a fixture posts what prod builds from the same lines', () => {
    const snap: CallSummarySnap = fixture('call-summary', 'webhook-limits-huddle').snapshot;
    const source = callSummarySource(snap.lines, snap.kind)!;
    expect(callSummarySurfaceRequest(snap)).toEqual(callSummaryRequest(source, { kind: 'huddle', started_at: snap.started_at, ended_at: snap.ended_at, rolling: false }));
  });

  test('under 40 words: no call, an empty pass on every gate', async () => {
    const snap: CallSummarySnap = fixture('call-summary', 'too-short-to-summarize').snapshot;
    const r = await replayWith(callSummary, snap, 'unused');
    expect(r.out.calls).toHaveLength(0);
    expect(r.gates).toEqual({ 'skip-honored': true });
    expect(routeGates(callSummaryMeta, r.out).every((g) => g.pass)).toBe(true);
    expect(fixture('call-summary', 'too-short-to-summarize').judge).toBeNull();
  });

  test('gates: a summary passes; a long call keeps its tail; no JSON fails parse', async () => {
    const snap: CallSummarySnap = fixture('call-summary', 'webhook-limits-huddle').snapshot;
    const good = await replayWith(callSummary, snap, '{"title": "Webhook limits", "summary": "Ship Thursday.", "action_items": ["Iris: email the reseller"]}');
    expect(good.gates).toEqual({ 'skip-honored': true, 'tail-rule': true, parse: true });
    expect((await replayWith(callSummary, snap, 'no json')).gates.parse).toBe(false);
    const long: CallSummarySnap = { ...snap, lines: Array.from({ length: 1500 }, (_, i) => ({ speaker: 'Mara', text: `line ${i} of a very long call about webhook limits` })) };
    expect((await replayWith(callSummary, long, '{"summary": "s", "action_items": []}')).gates['tail-rule']).toBe(true);
  });

  test("owners-credited: a label's owners must be exactly the owners the items name first", async () => {
    const kase = fixture('call-summary', 'huddle-credit-owners');
    const snap: CallSummarySnap = kase.snapshot;
    const owners = async (items: string[]) => {
      const r = await replayWith(callSummary, snap, JSON.stringify({ title: 't', summary: 's', action_items: items }));
      return byId(callSummary.gates(snap, r.out, kase.label))['owners-credited'];
    };
    expect(await owners(['Lucia: write the migration script', 'Ravi: write the rollback runbook', 'Lucia (with Priya): check the new terms', 'Dana: send the customer email Thursday'])).toBe(true);
    expect(await owners(['Ravi: write the migration script', 'Ravi: write the rollback runbook', 'Lucia: check the new terms', 'Dana: send the customer email Thursday'])).toBe(false);
    expect(await owners(['Lucia: write the migration script', 'Ravi: write the rollback runbook', 'Lucia: check the new terms', 'Dana: send the customer email Thursday', 'Priya: review the terms'])).toBe(false);
  });

  test('a call snapshot maps cast call --json the way prod reads segments', () => {
    const snap = callSnapshot({
      _id: 'c1',
      room_key: 'channel:general',
      status: 'ended',
      started_at: 1000,
      ended_at: 61_000,
      title: 'T',
      summary: 'S',
      action_items: ['A: do it'],
      segments: [
        { seq: 2, speaker_name: 'B', text: 'second', at: 3 },
        { seq: 1, speaker_name: 'A', text: 'first', at: 2 },
      ],
    });
    expect(snap.lines.map((l) => `${l.speaker}: ${l.text}`)).toEqual(['A: first', 'B: second']);
    expect(snap).toMatchObject({ kind: 'huddle', started_at: 1000, ended_at: 61_000, rolling: false });
    expect(callSummary.productionReply!(snap)!.messages[0]!.text).toBe('T\nS\n- A: do it');
  });
});
