// The client's verbs over a transport and a cache: `call` one route for its
// answer (a start, a stop, a price), `load` an answer into the cache, and
// `invalidate` the answers a write made stale. Framework-free, so a React
// provider, a product's own store (codecast's evalsStore) and a test share
// the one implementation of when a load runs and what a failure keeps.

import type { EvalsViewRoutes } from '../contract';
import type { CachedResource, EvalsResourceCache } from './cache';
import { EvalsRequestError, evalsCalls, type EvalsArgs, type EvalsResponseOf, type EvalsTransport } from './transport';

export interface EvalsClientOptions {
  /** The transport to send on, read per call: a product connects (or reconnects) after the client exists. Null until it has one. */
  transport: () => EvalsTransport | null;
  cache: EvalsResourceCache;
  /** Every failed call, before it is thrown: where a product decides whether the whole area is unreachable (codecast: classifyEvalsFailure). */
  onFailure?(e: unknown): void;
  /** The clock a loaded answer is stamped with. */
  now?(): number;
}

export interface EvalsClient<T> {
  /** Calls one route; a failure reaches onFailure, then throws. */
  call<K extends keyof T & string>(key: K, args: EvalsArgs<T, K>): Promise<EvalsResponseOf<T, K>>;
  /** Fills the cache under the request's key. A cached answer, or a load already running, is kept unless forced; a failure keeps the last answer beside its error. */
  load<K extends keyof T & string>(key: K, args: EvalsArgs<T, K>, opts?: { force?: boolean }): Promise<void>;
  /** Drops cached answers whose key starts with a prefix ("GET /surface/settle"), or all. */
  invalidate(prefix?: string): void;
  /** The cache key a route and its args read. */
  cacheKey<K extends keyof T & string>(key: K, args: EvalsArgs<T, K>): string;
}

/** The client over route table T (the neutral routes by default; codecast passes its wider EvalsRoutes). */
export function createEvalsClient<T = EvalsViewRoutes>(o: EvalsClientOptions): EvalsClient<T> {
  const calls = evalsCalls<T>();
  const now = o.now ?? Date.now;
  const transport = () => {
    const t = o.transport();
    if (!t) throw new Error('the evals are not connected');
    return t;
  };
  const put = (key: string, value: CachedResource) => o.cache.set(key, value);

  const call: EvalsClient<T>['call'] = async (key, args) => {
    try {
      return await calls.call(transport(), key, args);
    } catch (e) {
      o.onFailure?.(e);
      throw e;
    }
  };

  return {
    call,
    cacheKey: calls.cacheKey,
    async load(key, args, opts) {
      const k = calls.cacheKey(key, args);
      const had = o.cache.get(k);
      if (had && (had.loading || (!opts?.force && had.data !== null))) return;
      put(k, { data: had?.data ?? null, error: null, status: null, loading: true, at: had?.at ?? 0 });
      try {
        const data = await call(key, args);
        put(k, { data, error: null, status: 200, loading: false, at: now() });
      } catch (e) {
        const status = e instanceof EvalsRequestError ? e.status : null;
        put(k, { data: had?.data ?? null, error: e instanceof Error ? e.message : String(e), status, loading: false, at: now() });
      }
    },
    invalidate: (prefix) => o.cache.clear(prefix ? (k) => k.startsWith(prefix) : undefined),
  };
}
