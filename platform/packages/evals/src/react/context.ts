// What one EvalsProvider hands the views below it. A leaf, so the provider,
// the hooks and the defaults can all read it without importing each other.
// Nothing here is a singleton: each provider makes its own value.

import { createContext } from 'react';
import type { CachedResource, EvalsClient, EvalsResourceCache, EvalsTransport, PollPolicy } from '../client';
import type { EvalsHost } from './host';

/** The provider's cache, with what it holds as one snapshot: the search box resolves everything a page has loaded. */
export interface TrackedCache extends EvalsResourceCache {
  /** Every answer held, by cache key. The same object until an answer changes. */
  loaded(): Record<string, CachedResource>;
}

export interface EvalsContextValue {
  host: EvalsHost;
  /** Typed by the hooks that read it: the neutral routes, or a host's wider table through evalsHooks<T>(). */
  client: EvalsClient<any>;
  cache: TrackedCache;
  /** Null while the host is still finding its data (codecast: daemon discovery). */
  transport: EvalsTransport | null;
  poll: PollPolicy;
}

export const EvalsContext = createContext<EvalsContextValue | null>(null);

/**
 * Any cache with its contents as a stable snapshot. The listing reads the
 * cache itself, not what this mount wrote: a product's store outlives a
 * mount, and an answer an earlier mount loaded is a cache hit that writes
 * nothing, yet the search must still resolve it.
 */
export function trackCache(inner: EvalsResourceCache): TrackedCache {
  let snapshot: Record<string, CachedResource> = {};
  return {
    get: (key) => inner.get(key),
    set: (key, value) => inner.set(key, value),
    keys: () => inner.keys(),
    subscribe: (key, fn) => inner.subscribe(key, fn),
    subscribeAll: (fn) => inner.subscribeAll(fn),
    clear: (pred) => inner.clear(pred),
    loaded() {
      const out: Record<string, CachedResource> = {};
      let same = true;
      let n = 0;
      for (const k of inner.keys()) {
        const v = inner.get(k);
        if (!v) continue;
        out[k] = v;
        n++;
        if (snapshot[k] !== v) same = false;
      }
      if (same && n === Object.keys(snapshot).length) return snapshot;
      return (snapshot = out);
    },
  };
}
