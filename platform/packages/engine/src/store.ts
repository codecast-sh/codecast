import { create, type StoreApi, type UseBoundStore } from "zustand";
import { mutativeMiddleware, type MiddlewareOptions } from "./middleware";
import { deriveRegistryMaps, type RegistryMaps } from "./registry";
import { createSyncEngine, type SyncEngine } from "./syncEngine";
import { makeUseTrackedStore } from "./react";
import type { PlatformConfig, PlatformStoreInternals } from "./types";

export type LocalFirstStore<T> = {
  /** The zustand hook: call it with a selector, or read getState/subscribe off it. */
  useStore: UseBoundStore<StoreApi<T & PlatformStoreInternals>>;
  /** Deps-array hook bound to this store (see makeUseTrackedStore). */
  useTrackedStore: (deps: Array<(s: T & PlatformStoreInternals) => any>) => T & PlatformStoreInternals;
  /** syncTable / syncRecord / syncOverlay recipes to wrap in sync() actions. */
  syncEngine: SyncEngine;
  /** Lookup maps derived from the config's registry. */
  maps: RegistryMaps;
};

/**
 * Wire the middleware, the registry and the sync recipes into one store.
 *
 * The creator is an ordinary zustand state creator whose action functions carry
 * the decorators: action() for a local write that also dispatches to the server,
 * sync() for incoming data and local-only bookkeeping, asyncAction() when the
 * caller must await the server result, receiptAsyncAction() when the command is
 * server-deduplicated and must stay pending across a reload.
 */
export function createLocalFirstStore<T extends object>(
  config: PlatformConfig,
  creator: (set: any, get: any, api: any) => T,
  opts?: MiddlewareOptions,
): LocalFirstStore<T> {
  const maps = opts?.registryMaps ?? deriveRegistryMaps(config.registry);
  const useStore = create<T & PlatformStoreInternals>(
    mutativeMiddleware(creator, config, { ...opts, registryMaps: maps }),
  );
  return {
    useStore,
    useTrackedStore: makeUseTrackedStore<T & PlatformStoreInternals>(useStore),
    syncEngine: createSyncEngine(config),
    maps,
  };
}
