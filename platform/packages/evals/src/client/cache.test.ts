/**
 * The resource cache has no persistence path. Eval answers can hold a
 * product's private conversations, so nothing in the client may write them
 * anywhere that outlives the page: the cache's whole surface is get, set,
 * keys, subscribe, subscribeAll and clear; a fresh cache starts empty whatever another held; a
 * full load through the client touches no storage the platform offers; and
 * no client source names one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import ts from 'typescript';
import { SRC, isProductSource, lineOf, parse, readTree, walk } from '../guardKit';
import { memoryResourceCache, type CachedResource, type EvalsResourceCache } from './cache';
import { createEvalsClient } from './resources';
import { localTransport } from './transport';

/** Every place a browser or a server can keep data past the page. */
const STORAGE = ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore', 'BroadcastChannel', 'openDatabase', 'IDBFactory', 'storage'] as const;

const answer = (data: unknown): CachedResource => ({ data, error: null, status: 200, loading: false, at: 1 });

describe('memoryResourceCache', () => {
  it('offers get, set, keys, subscribe, subscribeAll and clear, and nothing that could save or restore', () => {
    const cache = memoryResourceCache();
    expect(Object.keys(cache).sort()).toEqual(['clear', 'get', 'keys', 'set', 'subscribe', 'subscribeAll']);
    // The interface, as a type: a persist, load, hydrate, dump or export method would fail this line.
    const keys: Array<keyof EvalsResourceCache> = ['get', 'set', 'keys', 'subscribe', 'subscribeAll', 'clear'];
    type Exact = Exclude<keyof EvalsResourceCache, (typeof keys)[number]> extends never ? true : false;
    const exact: Exact = true;
    expect(exact).toBe(true);
  });

  it('a fresh cache starts empty: nothing carries over from another cache or an earlier page', () => {
    const first = memoryResourceCache();
    first.set('GET /overview', answer({ secret: 'a private reply' }));
    const second = memoryResourceCache();
    expect(second.get('GET /overview')).toBeUndefined();
    expect(first.get('GET /overview')?.data).toEqual({ secret: 'a private reply' });
  });

  it('tells a subscriber when its key changes or is cleared, and stops when it unsubscribes', () => {
    const cache = memoryResourceCache();
    const seen: string[] = [];
    const off = cache.subscribe('a', () => seen.push(`a:${String(cache.get('a')?.data ?? 'gone')}`));
    cache.subscribe('b', () => seen.push('b'));
    cache.set('a', answer(1));
    cache.set('b', answer(2));
    cache.clear((k) => k === 'a');
    off();
    cache.set('a', answer(3));
    expect(seen).toEqual(['a:1', 'b', 'a:gone']);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('lists every key it holds, and tells an all-keys subscriber of each change', () => {
    const cache = memoryResourceCache();
    let changes = 0;
    const off = cache.subscribeAll(() => changes++);
    cache.set('a', answer(1));
    cache.set('b', answer(2));
    expect(cache.keys().sort()).toEqual(['a', 'b']);
    cache.clear((k) => k === 'a');
    expect(cache.keys()).toEqual(['b']);
    off();
    cache.set('c', answer(3));
    expect(changes).toBe(3);
  });
});

describe('no persistence path', () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const touched: string[] = [];

  beforeEach(() => {
    touched.length = 0;
    for (const name of STORAGE) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      const trap: object = new Proxy(function () {}, {
        get: (_t, p) => (touched.push(`${name}.${String(p)}`), trap),
        apply: () => (touched.push(`${name}()`), trap),
        construct: () => (touched.push(`new ${name}`), trap),
      });
      Object.defineProperty(globalThis, name, { value: trap, configurable: true, writable: true });
    }
  });

  afterEach(() => {
    for (const [name, d] of saved) {
      if (d) Object.defineProperty(globalThis, name, d);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  });

  it('a load, a reload, a failure and an invalidate through the client touch no storage', async () => {
    const cache = memoryResourceCache();
    let fail = false;
    const client = createEvalsClient({
      transport: () => localTransport(async (req) => (fail ? { status: 500, body: { error: 'down' } } : { status: 200, body: { path: req.path, reply: 'a private reply' } })),
      cache,
    });
    await client.load('GET /overview', {});
    await client.load('GET /run/:id', { params: { id: 'r1' } });
    fail = true;
    await client.load('GET /overview', {}, { force: true });
    client.invalidate('GET /run');
    expect(cache.get(client.cacheKey('GET /overview', {}))?.data).toEqual({ path: '/overview', reply: 'a private reply' });
    expect(cache.get(client.cacheKey('GET /overview', {}))?.error).toBe('down');
    expect(cache.get(client.cacheKey('GET /run/:id', { params: { id: 'r1' } }))).toBeUndefined();
    expect(touched).toEqual([]);
  });

  it('no client source names a storage the platform offers', () => {
    const problems: string[] = [];
    for (const [path, text] of readTree(`${SRC}/client`)) {
      if (!isProductSource(path)) continue;
      walk(parse(path, text), (node) => {
        if (ts.isIdentifier(node) && (STORAGE as readonly string[]).includes(node.text)) problems.push(`${path}:${lineOf(node)} names ${node.text}`);
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'cookie') problems.push(`${path}:${lineOf(node)} reads a cookie`);
      });
    }
    expect(problems).toEqual([]);
  });
});
