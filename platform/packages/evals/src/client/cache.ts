// Where a page keeps the answers it read. Eval data can be private (a
// product's real conversations), so the cache lives in memory only: the
// interface has no way to persist, hydrate or export, and the memory cache
// touches no storage. A reload reads the handler again. A product may back
// the interface with its own store (codecast: evalsStore), which holds the
// same line in its own guard test.

/** One cached answer, keyed by its request (evalsRequestKey). */
export interface CachedResource<T = unknown> {
  data: T | null;
  error: string | null;
  /** The HTTP status of the last answer, or of the last failure (404 for an unknown id). */
  status: number | null;
  loading: boolean;
  at: number;
}

/** Memory-only by contract: get, set, list, follow and drop; nothing persists. */
export interface EvalsResourceCache {
  get(key: string): CachedResource | undefined;
  set(key: string, value: CachedResource): void;
  /** The key of every answer held, whoever wrote it: a cache that outlives one mount still lists what an earlier mount read. */
  keys(): string[];
  /** Calls `fn` whenever the answer under `key` changes; returns the unsubscribe. */
  subscribe(key: string, fn: () => void): () => void;
  /** Calls `fn` whenever any answer changes; returns the unsubscribe. */
  subscribeAll(fn: () => void): () => void;
  /** Drops the answers whose key passes `pred`, or every answer. */
  clear(pred?: (key: string) => boolean): void;
}

/** A cache in this provider's memory alone: two providers never share one, and nothing outlives the page. */
export function memoryResourceCache(): EvalsResourceCache {
  const entries = new Map<string, CachedResource>();
  const listeners = new Map<string, Set<() => void>>();
  const everyone = new Set<() => void>();
  const notify = (key: string) => {
    for (const fn of [...(listeners.get(key) ?? [])]) fn();
    for (const fn of [...everyone]) fn();
  };
  return {
    get: (key) => entries.get(key),
    set(key, value) {
      entries.set(key, value);
      notify(key);
    },
    keys: () => [...entries.keys()],
    subscribeAll(fn) {
      everyone.add(fn);
      return () => {
        everyone.delete(fn);
      };
    },
    subscribe(key, fn) {
      const set = listeners.get(key) ?? listeners.set(key, new Set()).get(key)!;
      set.add(fn);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(key);
      };
    },
    clear(pred) {
      const gone = [...entries.keys()].filter((k) => !pred || pred(k));
      for (const k of gone) entries.delete(k);
      for (const k of gone) notify(k);
    },
  };
}
