import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASK_SYSTEM_PROMPT, askTermsRequest } from '../../../../convex/convex/lib/sessionAsk';
import type { Fixture } from '../../adapters/resolver';
import { REPO_ROOT } from '../../paths';
import type { CallResult, ReplayCtx, ReplayResult, SurfaceRequest } from '../../surface';
import ask, { citationCheck, parseAskCall, type AskSnap } from './index';

const DIR = join(REPO_ROOT, 'packages', 'evals', 'fixtures', 'ask');
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ kase: f.replace(/\.json$/, ''), fixture: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture & { snapshot: AskSnap } }));

/** A ReplayCtx that answers each call with the next canned reply and records the requests. */
function scriptedCtx(replies: string[]): { ctx: ReplayCtx; calls: CallResult[] } {
  const calls: CallResult[] = [];
  const ctx = {
    dry: true,
    model: 'pinned',
    runDir: '/nonexistent',
    freeze: {} as ReplayCtx['freeze'],
    async call(req: SurfaceRequest) {
      const text = replies[calls.length] ?? '';
      const r: CallResult = { request: req, text, outputTokens: 10, stopReason: 'end_turn', modelUsage: { [req.model]: { outputTokens: 10 } }, costUsd: 0, isError: false, exitCode: 0, dir: '', realMs: 0 };
      calls.push(r);
      return r;
    },
    async agent(): Promise<never> {
      throw new Error('ask makes no agent run');
    },
  } satisfies ReplayCtx;
  return { ctx, calls };
}

async function replay(snap: AskSnap, replies: string[]) {
  const { ctx, calls } = scriptedCtx(replies);
  const out = await ask.replay(snap, ctx);
  const result: ReplayResult = { ...out, calls, agents: [] };
  return { result, calls, gates: ask.gates(snap, result) };
}

describe('parseAskCall', () => {
  test('finds the session and the question in a shell command', () => {
    expect(parseAskCall('cd /tmp; time cast read jx79tyc --ask "Does the page link to a forum?" 2>&1')).toEqual({ target: 'jx79tyc', question: 'Does the page link to a forum?' });
    expect(parseAskCall("cast read jx79tyc 1:20 --ask 'single quoted' --json")).toEqual({ target: 'jx79tyc', question: 'single quoted' });
    expect(parseAskCall('cast read jx77tbn --ask "the \\"quoted\\" word"')).toEqual({ target: 'jx77tbn', question: 'the "quoted" word' });
  });

  test('reads no id, or self, as the asking session', () => {
    expect(parseAskCall('cast read --ask "what was I asked to build?"')).toEqual({ target: null, question: 'what was I asked to build?' });
    expect(parseAskCall('cast read self --ask "x?"')).toEqual({ target: null, question: 'x?' });
  });

  test('takes the first of two asks, and ignores text with none', () => {
    expect(parseAskCall('cast read a1 --ask "first?"; cast read b2 --ask "second?"')?.question).toBe('first?');
    expect(parseAskCall('cast read jx77tbn 1:40')).toBeNull();
  });
});

describe('the ask replay', () => {
  test('every fixture sends the terms request, then an answer request over its own lines', async () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
    for (const { kase, fixture } of fixtures) {
      const { calls, gates } = await replay(fixture.snapshot, ['["retry", "cap"]', 'No citations here.']);
      expect(calls.map((c) => c.request.max_tokens)).toEqual([200, 1500]);
      expect(calls[0]!.request).toEqual(askTermsRequest(fixture.snapshot.question));
      expect(calls[1]!.request.system).toBe(ASK_SYSTEM_PROMPT);
      expect(calls[1]!.request.prompt).toContain(`Question: ${fixture.snapshot.question}`);
      expect(calls[1]!.request.prompt).toContain(`Messages: ${fixture.snapshot.rows.length} in all`);
      expect(gates.every((g) => g.pass), kase).toBe(true);
    }
  });

  test('the terms reply decides which lines match', async () => {
    const snap = fixtures.find((f) => f.kase === 'revised-retry-cap')!.fixture.snapshot;
    const withTerm = (await replay(snap, ['["MAX_WAIT_MS"]', ''])).result.extra as { matched_lines: number };
    const without = (await replay(snap, ['[]', ''])).result.extra as { matched_lines: number };
    expect(withTerm.matched_lines).toBeGreaterThan(without.matched_lines);
  });

  test('parse fails on a terms reply with no JSON array, citations-real on a line never shown', async () => {
    const snap = fixtures.find((f) => f.kase === 'revised-retry-cap')!.fixture.snapshot;
    const { gates } = await replay(snap, ['retry, cap', 'It was raised to 8 (msg 8) and later msg 4000.']);
    const byId = Object.fromEntries(gates.map((g) => [g.id, g]));
    expect(byId.parse!.pass).toBe(false);
    expect(byId['citations-real']!.pass).toBe(false);
    expect(byId['citations-real']!.evidence?.summary).toContain('msg 4000');
  });

  test('a range between two shown lines is real even where the budget left lines out; a range or line never shown is invented', () => {
    // The 2026-10-02 shapes: "msg 131–164" over a session whose 138 and 142 were cut, and "msg 89–90" where 89 was marked not shown.
    const shown = [...Array.from({ length: 34 }, (_, i) => 131 + i).filter((l) => l !== 138 && l !== 142), 90];
    expect(citationCheck('- msg 131–164: the invite was dead', shown)).toEqual({ invented: [], unshownInRanges: 2 });
    expect(citationCheck('- msg 89–90: 196 rows', shown)).toEqual({ invented: ['msg 89–90'], unshownInRanges: 0 });
    expect(citationCheck('msg 131, 133 and 400', shown).invented).toEqual(['msg 400']);
  });

  test('the judge sees the question and a selection of the session', () => {
    const snap = fixtures.find((f) => f.kase === 'deploy-token-failure')!.fixture.snapshot;
    const view = ask.describe(snap);
    expect(view[0]!.text).toContain(snap.question);
    expect(view[1]!.text).toContain('STAGING_TOKEN');
    expect(ask.productionReply?.(snap)).toBeNull();
  });
});
