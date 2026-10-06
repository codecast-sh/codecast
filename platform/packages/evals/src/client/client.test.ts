import { afterEach, describe, expect, it } from 'bun:test';
import type { EvalsBridgeRequest, Route } from '../contract';
import { memoryResourceCache } from './cache';
import { EVALS_STALL_MS, quietTooLong, rowLiveness } from './liveness';
import { followChanges, hasNews, mergeById, nextSeqCursor, poll, type Visibility } from './polling';
import { createEvalsClient } from './resources';
import { callEvals, encodeEvalsQuery, evalsCacheKey, evalsCalls, evalsRequest, evalsUrlPath, EvalsRequestError, httpTransport, localTransport } from './transport';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('requests', () => {
  it('fills and encodes params, flattens the query, keeps a body', () => {
    expect(evalsRequest('GET /run/:id', { params: { id: 'a b/c' } })).toEqual({ method: 'GET', path: '/run/a%20b%2Fc', query: {} });
    expect(evalsRequest('GET /commit/:sha', { params: { sha: 'abc1234' }, query: { surface: 'title', whole: true } }).query).toEqual({ surface: 'title', whole: '1' });
    expect(encodeEvalsQuery({ a: undefined, b: null, c: false, d: 3 })).toEqual({ c: '0', d: '3' });
    expect(() => evalsRequest('GET /run/:id', { params: { id: '' } })).toThrow('missing :id');
  });

  it('keys a request by method, path and sorted query, so argument order never splits the cache', () => {
    expect(evalsCacheKey('GET /surface/:id', { params: { id: 'settle' }, query: { model: 'm', cadence: 'nightly' } })).toBe('GET /surface/settle?cadence=nightly&model=m');
    expect(evalsCacheKey('GET /overview', {})).toBe('GET /overview');
  });

  it('a product types its own routes through the same calls', () => {
    type Own = { 'POST /bisect': Route<Record<string, never>, Record<string, never>, { id: string }, { surface: string }> };
    const own = evalsCalls<Own>();
    expect(own.request('POST /bisect', { body: { surface: 'title' } })).toEqual({ method: 'POST', path: '/bisect', query: {}, body: { surface: 'title' } });
  });

  it('puts a request under a base', () => {
    expect(evalsUrlPath({ path: '/surface/x', query: { a: '1' } }, '/evals/')).toBe('/evals/surface/x?a=1');
    expect(evalsUrlPath({ path: '/health' }, 'http://127.0.0.1:4555/api')).toBe('http://127.0.0.1:4555/api/health');
  });
});

describe('transports', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('a local transport answers with a copy, so a page cannot edit what the handler keeps', async () => {
    const kept = { rows: [{ id: 'r1' }] };
    const t = localTransport(async () => ({ status: 200, body: kept }));
    const got = (await t.send({ method: 'GET', path: '/x' })).body as typeof kept;
    got.rows[0]!.id = 'changed';
    expect(kept.rows[0]!.id).toBe('r1');
    expect(t.kind).toBe('local');
  });

  it('a call throws the error body on a non-2xx answer', async () => {
    const t = localTransport(async () => ({ status: 404, body: { error: 'no run x', reason: 'not-found' } }));
    const err = await callEvals(t, 'GET /run/:id', { params: { id: 'x' } }).catch((e) => e);
    expect(err).toBeInstanceOf(EvalsRequestError);
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: 'no run x', reason: 'not-found' });
  });

  it('http sends the method, JSON body, headers and credentials, and reads a body-less failure as an error body', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return seen.length === 1 ? new Response(JSON.stringify({ ok: 1 }), { status: 200 }) : new Response('<html>', { status: 502 });
    }) as typeof fetch;
    const t = httpTransport('http://127.0.0.1:9/evals', { headers: { Authorization: 'Bearer t' }, credentials: 'include' });
    expect(await t.send({ method: 'POST', path: '/bisect', query: { a: '1' }, body: { surface: 's' } })).toEqual({ status: 200, body: { ok: 1 } });
    expect(seen[0]!.url).toBe('http://127.0.0.1:9/evals/bisect?a=1');
    expect(seen[0]!.init).toEqual({ method: 'POST', body: '{"surface":"s"}', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, credentials: 'include' });
    expect(await t.send({ method: 'GET', path: '/health' })).toEqual({ status: 502, body: { error: 'evals: 502 with no JSON body' } });
  });
});

describe('the client', () => {
  const setup = (answer: (req: EvalsBridgeRequest) => { status: number; body: unknown }) => {
    const sent: string[] = [];
    const failures: unknown[] = [];
    const cache = memoryResourceCache();
    let connected = true;
    const client = createEvalsClient({
      transport: () => (connected ? localTransport(async (req) => (sent.push(req.path), answer(req))) : null),
      cache,
      onFailure: (e) => failures.push(e),
      now: () => 42,
    });
    return { client, cache, sent, failures, disconnect: () => (connected = false) };
  };

  it('loads once: a cached answer and a load in flight are kept unless forced', async () => {
    const { client, cache, sent } = setup((req) => ({ status: 200, body: { n: req.path } }));
    const first = client.load('GET /overview', {});
    void client.load('GET /overview', {});
    expect(cache.get('GET /overview')).toEqual({ data: null, error: null, status: null, loading: true, at: 0 });
    await first;
    await client.load('GET /overview', {});
    expect(sent).toEqual(['/overview']);
    expect(cache.get('GET /overview')).toEqual({ data: { n: '/overview' }, error: null, status: 200, loading: false, at: 42 });
    await client.load('GET /overview', {}, { force: true });
    expect(sent).toEqual(['/overview', '/overview']);
  });

  it('a failure keeps the last answer beside its error and status, and reaches onFailure', async () => {
    let down = false;
    const { client, cache, failures } = setup(() => (down ? { status: 404, body: { error: 'gone', reason: 'not-found' } } : { status: 200, body: 'ok' }));
    await client.load('GET /run/:id', { params: { id: 'r' } });
    down = true;
    await client.load('GET /run/:id', { params: { id: 'r' } }, { force: true });
    expect(cache.get('GET /run/r')).toEqual({ data: 'ok', error: 'gone', status: 404, loading: false, at: 42 });
    expect(failures).toHaveLength(1);
  });

  it('says it is not connected rather than sending nowhere', async () => {
    const { client, disconnect } = setup(() => ({ status: 200, body: null }));
    disconnect();
    await expect(client.call('GET /health', {})).rejects.toThrow('the evals are not connected');
  });

  it('invalidates by prefix, or everything', async () => {
    const { client, cache } = setup((req) => ({ status: 200, body: req.path }));
    await client.load('GET /surface/:id', { params: { id: 'a' } });
    await client.load('GET /surface/:id', { params: { id: 'b' } });
    await client.load('GET /overview', {});
    client.invalidate('GET /surface/a');
    expect([cache.get('GET /surface/a'), cache.get('GET /surface/b')?.data]).toEqual([undefined, '/surface/b']);
    client.invalidate();
    expect(cache.get('GET /overview')).toBeUndefined();
  });
});

describe('polling', () => {
  const screen = () => {
    let on = true;
    const fns = new Set<() => void>();
    const v: Visibility = { visible: () => on, subscribe: (fn) => (fns.add(fn), () => fns.delete(fn)) };
    return { v, set: (x: boolean) => ((on = x), fns.forEach((f) => f())), listeners: () => fns.size };
  };

  it('ticks now, pauses while hidden, ticks at once on return, and stops', async () => {
    const s = screen();
    let n = 0;
    const stop = poll(() => n++, { intervalMs: 10_000, pauseWhenHidden: true }, s.v);
    await tick();
    expect(n).toBe(1);
    s.set(false);
    await tick();
    expect(n).toBe(1);
    s.set(true);
    await tick();
    expect(n).toBe(2);
    stop();
    expect(s.listeners()).toBe(0);
    s.set(true);
    await tick();
    expect(n).toBe(2);
  });

  it('never runs a tick twice at once', async () => {
    const s = screen();
    let n = 0;
    let release!: () => void;
    const stop = poll(() => (n++, new Promise<void>((r) => (release = r))), { intervalMs: 10_000, pauseWhenHidden: false }, s.v);
    s.set(true);
    s.set(true);
    await tick();
    expect(n).toBe(1);
    release();
    await tick();
    s.set(true);
    await tick();
    expect(n).toBe(2);
    stop();
  });

  it('follows /changes from its own cursor, handing over only answers with news', async () => {
    const s = screen();
    const asked: number[] = [];
    const answers = [
      { cursor: 10, runs: [{ id: 'old' }], bisects: [] },
      { cursor: 20, runs: [], bisects: [], jobs: [] },
      { cursor: 30, runs: [], bisects: [], jobs: [{ id: 'j' }] },
    ];
    const got: unknown[] = [];
    const stop = followChanges(async (since) => (asked.push(since), answers.shift() as never), (c) => got.push(c), { intervalMs: 10_000, pauseWhenHidden: true }, s.v);
    for (let i = 0; i < 3; i++) {
      await tick();
      await tick();
      s.set(true);
    }
    stop();
    expect(asked).toEqual([0, 10, 20]);
    expect(got).toEqual([{ cursor: 30, runs: [], bisects: [], jobs: [{ id: 'j' }] }]);
    expect(hasNews({ cursor: 1, runs: [] })).toBe(false);
  });

  it('merges rows by id: replaced in place, new ones appended, the same array when nothing changed', () => {
    const a = { id: 'a', v: 1 };
    const b = { id: 'b', v: 1 };
    const prev = [a, b];
    expect(mergeById(prev, [])).toBe(prev);
    expect(mergeById(prev, [a])).toBe(prev);
    expect(mergeById(prev, [{ id: 'b', v: 2 }, { id: 'c', v: 1 }, { id: 'c', v: 3 }])).toEqual([a, { id: 'b', v: 2 }, { id: 'c', v: 3 }]);
  });

  it('steps a log cursor back one on a full page, so a repeated sequence number at the boundary is read again', () => {
    expect(nextSeqCursor([], 500, 7)).toBe(7);
    expect(nextSeqCursor([{ seq: 8 }, { seq: 9 }], 500, 7)).toBe(9);
    expect(nextSeqCursor([{ seq: 8 }, { seq: 9 }], 2, 7)).toBe(8);
  });
});

describe('liveness', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  it('a rep still waiting on its grade is live or stalled by its newest event; a finished one shows none', () => {
    expect(rowLiveness({ status: 'unscored', lastEventAt: '2026-10-05T11:59:00Z' }, now)).toBe('live');
    expect(rowLiveness({ status: 'unscored', lastEventAt: '2026-10-05T11:50:00Z' }, now)).toBe('stalled');
    expect(rowLiveness({ status: 'pass', lastEventAt: '2026-10-05T11:00:00Z' }, now)).toBeNull();
    expect(rowLiveness({ status: 'unscored' }, now)).toBeNull();
    expect(quietTooLong('2026-10-05T11:54:00Z', now)).toBe(EVALS_STALL_MS < 6 * 60_000);
  });
});
