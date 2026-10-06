// What one EvalsProvider hands the views below it. A leaf, so the provider,
// the hooks and the defaults can all read it without importing each other.
// Nothing here is a singleton: each provider makes its own value.

import { createContext } from 'react';
import type { CachedResource, EvalsClient, EvalsResourceCache, EvalsTransport, PollPolicy } from '../client';
import type { EvalsHost } from './host';

/** The provider's cache, which also lists what it holds: the search box resolves everything a page has loaded. */
export interface TrackedCache extends EvalsResourceCache {
  /** Every answer held, by cache key. The same object until an answer changes. */
  loaded(): Record<string, CachedResource>;
  /** Calls `fn` whenever any answer changes. */
  subscribeAll(fn: () => void): () => void;
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

/** A cache that records the keys written through it, over any cache (the memory cache, or a product's own store). */
export function trackCache(inner: EvalsResourceCache): TrackedCache {
  const keys = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: Record<string, CachedResource> | null = null;
  const changed = () => {
    snapshot = null;
    for (const fn of [...listeners]) fn();
  };
  return {
    get: (key) => inner.get(key),
    set(key, value) {
      keys.add(key);
      inner.set(key, value);
      changed();
    },
    subscribe: (key, fn) => inner.subscribe(key, fn),
    clear(pred) {
      inner.clear(pred);
      for (const k of [...keys]) if (!pred || pred(k)) keys.delete(k);
      changed();
    },
    loaded() {
      if (!snapshot) {
        const out: Record<string, CachedResource> = {};
        for (const k of keys) {
          const v = inner.get(k);
          if (v) out[k] = v;
        }
        snapshot = out;
      }
      return snapshot;
    },
    subscribeAll(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
