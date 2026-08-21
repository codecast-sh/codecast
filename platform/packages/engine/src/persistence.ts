import { createIdbCache, PERSISTENCE_AVAILABLE, type PlatformCache } from "./idbCache";
import { deriveRegistryMaps, type RegistryMaps } from "./registry";
import type { PlatformConfig } from "./types";

// Cache-as-floor hydration merge for id-keyed collections. Persisted rows are
// the base; whatever live data already landed in the store wins per id. A
// windowed live payload must never empty-gate out the full cached collection:
// that race (live fills the store before the deferred hydration runs) is what
// makes lists collapse to the live window on every load and stream back in.
// Union-merge backfills the omitted rows while keeping live freshness; genuine
// deletions are reconciled by an authoritative snapshot, not by hydration.
export function unionHydrate<T extends Record<string, unknown>>(
  idbVal: T | undefined,
  liveVal: T | undefined,
): T {
  return { ...(idbVal ?? {}), ...(liveVal ?? {}) } as T;
}

// How one cached value re-enters the store over whatever live sync already
// wrote, per the registry's merge strategy. "fill" keys (live-synced
// singletons) only land while the slot is still null; everything else merges
// by shape — objects union (cache as floor, live wins per key), arrays fill
// only an empty slot, scalars replace.
export function hydrateMergeValue(
  key: string,
  val: unknown,
  cur: unknown,
  mergeStrategy: (key: string) => "shape" | "fill",
): { apply: boolean; value?: unknown } {
  if (mergeStrategy(key) === "fill") {
    return cur == null ? { apply: true, value: val } : { apply: false };
  }
  if (Array.isArray(val)) {
    return (cur as unknown[] | undefined)?.length === 0
      ? { apply: true, value: val }
      : { apply: false };
  }
  if (typeof val === "object") {
    return {
      apply: true,
      value: unionHydrate(val as Record<string, unknown>, cur as Record<string, unknown> | undefined),
    };
  }
  return { apply: true, value: val };
}

export type StoreLike = {
  getState: () => any;
  setState: (partial: any, replace?: boolean) => void;
};

export type PersistenceHooks = {
  /** Durable writes are stuck or failing (healthy=false) / committing again. */
  onStorageHealth?: (healthy: boolean, elapsedMs: number) => void;
  /** Rewrite the cached blob in place before any of it lands. */
  transformCached?: (cached: Record<string, any>) => void;
  /** Runs right after the critical apply — the place to consume "manual" keys. */
  onCritical?: (cached: Record<string, any>) => void;
  /** Runs right after the deferred apply, before write-through re-opens. */
  onDeferred?: (cached: Record<string, any>) => void;
};

export type Persistence = {
  available: boolean;
  cache: PlatformCache | null;
  maps: RegistryMaps;
  /** Wire write-through + outbox and replay the cache into the store. */
  hydrate: () => Promise<boolean>;
};

export function createPersistence(
  config: PlatformConfig,
  store: StoreLike,
  hooks?: PersistenceHooks,
  maps: RegistryMaps = deriveRegistryMaps(config.registry),
  // An explicit cache (e.g. the KV/SQLite cache on native) bypasses the
  // IndexedDB availability check — the caller vouches for its environment.
  cacheImpl?: PlatformCache,
): Persistence {
  if (!cacheImpl && !PERSISTENCE_AVAILABLE) {
    return { available: false, cache: null, maps, hydrate: async () => false };
  }
  const cache = cacheImpl ?? createIdbCache(config, maps);

  async function hydrate(): Promise<boolean> {
    const internals = store.getState();
    internals._setIDBWrite(cache.writePatchesToIDB);
    internals._setOutbox(cache.enqueueDispatch, cache.removeDispatch, cache.loadOutbox);
    internals._setStorageHealth?.((healthy: boolean, elapsedMs: number) => {
      hooks?.onStorageHealth?.(healthy, elapsedMs);
    });

    cache.setHydrating(true);
    const cached = await cache.loadCache();
    if (!cached) {
      cache.setHydrating(false);
      return true;
    }

    const apply = (pick: string[]) => {
      const state = store.getState();
      const updates: Record<string, any> = {};
      for (const key of pick) {
        const val = cached[key];
        if (val == null) continue;
        const cur = state[key];
        const merge = hydrateMergeValue(key, val, cur, maps.hydrationMergeStrategy);
        if (merge.apply) updates[key] = merge.value;
      }
      if (Object.keys(updates).length > 0) store.setState(updates);
    };

    hooks?.transformCached?.(cached);

    // Critical path: everything needed for first paint. Derived from the
    // registry — a persisted key hydrates here unless it opted into the
    // deferred phase or "manual" handling, so a new key can never silently
    // skip hydration.
    apply(maps.hydrationCriticalKeys);
    hooks?.onCritical?.(cached);

    // Deferred: list views + secondary data hydrate just after first paint.
    // setTimeout, NOT requestAnimationFrame: rAF is paused in background tabs,
    // so with write-through gated on it a backgrounded tab would never finish
    // hydrating and never re-enable IDB writes (stuck hydrating flag). With the
    // user running many tabs, most are backgrounded — they must still hydrate
    // and persist. setTimeout fires (throttled) even when hidden.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    apply(maps.hydrationDeferredKeys);
    hooks?.onDeferred?.(cached);
    // Re-enable IDB write-through only AFTER the deferred collections land.
    // If a live delta arrives while write-through is open but the store still
    // holds just the windowed payload, diffCollection would diff that window
    // against the full on-disk shadow and delete every cached row outside it —
    // pruning the shared IndexedDB before the union merge brings it back.
    // Post-hydration the store holds the full union, so delta overlays never
    // drop rows; write-through then deletes only on a real removal or an
    // authoritative snapshot.
    cache.setHydrating(false);
    return true;
  }

  return { available: true, cache, maps, hydrate };
}
