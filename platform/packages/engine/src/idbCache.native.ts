// Metro resolves this file for "./idbCache" on the phone. The contract and the
// retention rule are shared; the Dexie implementation stays on the web, where
// IndexedDB exists. Native persistence is the KV cache (kvCache.ts), which the
// app passes in explicitly, and PERSISTENCE_AVAILABLE is false here, so this
// stub is never reached.
import type { RegistryMaps } from "./registry";
import type { PlatformConfig } from "./types";
import type { IdbCache } from "./cacheContract";

export {
  PERSISTENCE_AVAILABLE,
  DEFAULT_EXCLUDE_TOMBSTONE_TTL_MS,
  expireExcludeTombstones,
  type DetailRecord,
  type PlatformCache,
  type IdbCache,
} from "./cacheContract";

export function createIdbCache(_config: PlatformConfig, _maps?: RegistryMaps): IdbCache {
  throw new Error("createIdbCache: IndexedDB persistence is not available on native; pass the KV cache");
}
