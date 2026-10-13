import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anthropicBody } from '../../../convex/convex/lib/anthropic';
import { CALL_MODEL } from '../models';
import type { SurfaceRequest } from '../surface';
import { postCall } from './apiCall';
import { readCallRun } from './dryRun';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fake Messages API: answers each post with the next reply, recording what it was sent. */
function fakeApi(replies: Array<{ status: number; body: unknown }>) {
  const sent: Array<{ headers: Record<string, string>; body: unknown }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = replies[Math.min(sent.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return sent;
}

const req: SurfaceRequest = { model: CALL_MODEL, max_tokens: 400, system: 'Route the request.', prompt: 'Who owns the mailboxes?' };

describe('a call rep posted with the evals key', () => {
  test("sends prod's exact body (thinking off on the cheap model) with the evals key, and reads back like a harness run", async () => {
    const sent = fakeApi([{ status: 200, body: { content: [{ type: 'text', text: '{"handle":"infra"}' }], stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 9 } } }]);
    const run = join(mkdtempSync(join(tmpdir(), 'evals-apicall-')), 'run');
    expect(await postCall(req, run, 'sk-test')).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual(anthropicBody(req));
    expect(sent[0].body).toMatchObject({ thinking: { type: 'disabled' } });
    expect(sent[0].headers['x-api-key']).toBe('sk-test');
    const r = readCallRun(req, run, 0, 5);
    expect(r).toMatchObject({ text: '{"handle":"infra"}', outputTokens: 9, stopReason: 'end_turn', isError: false, harnessFailure: undefined });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.modelUsage[CALL_MODEL]).toMatchObject({ inputTokens: 120, outputTokens: 9 });
    expect(readFileSync(join(run, 'reply.txt'), 'utf8')).toBe('{"handle":"infra"}');
  });

  test('a rate limit is retried; a 400 is the request\'s own fault and graded, not a crash', async () => {
    const sent = fakeApi([
      { status: 429, body: { error: { message: 'rate limited' } } },
      { status: 200, body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const run = join(mkdtempSync(join(tmpdir(), 'evals-apicall-')), 'run');
    expect(await postCall(req, run, 'sk-test')).toBe(0);
    expect(sent).toHaveLength(2);

    fakeApi([{ status: 400, body: { error: { message: 'max_tokens too small' } } }]);
    const bad = join(mkdtempSync(join(tmpdir(), 'evals-apicall-')), 'run');
    expect(await postCall(req, bad, 'sk-test')).toBe(1);
    const r = readCallRun(req, bad, 1, 5);
    expect(r.isError).toBe(true);
    expect(r.harnessFailure).toBeUndefined();
  }, 30_000);

  test('a service that stays down is a harness failure, so the rep crashes instead of scoring 0', async () => {
    fakeApi([{ status: 529, body: { error: { message: 'overloaded' } } }]);
    const run = join(mkdtempSync(join(tmpdir(), 'evals-apicall-')), 'run');
    expect(await postCall(req, run, 'sk-test')).toBe(1);
    expect(readCallRun(req, run, 1, 5).harnessFailure).toContain('API error 529');
  }, 60_000);
});
