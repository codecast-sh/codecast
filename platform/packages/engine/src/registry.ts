import type {
  HydrationMerge,
  HydrationPhase,
  RegistryEntry,
  DispatchTableKind,
} from "./types";

// Everything the engine derives from an application's registry. The registry
// itself is supplied by the app; this module only turns it into the lookup maps
// the middleware, the persistence layer and the hydration boot need.
export type RegistryMaps = {
  collectionStoreKeys: string[];
  metaStoreKeys: string[];
  protectedCollectionKeys: string[];
  hydrationCriticalKeys: string[];
  hydrationDeferredKeys: string[];
  dispatchTableMap: Record<string, { table: string; kind: DispatchTableKind; fields?: readonly string[] }>;
  dispatchFieldTableMap: Record<string, { table: string }>;
  hydrationMergeStrategy: (key: string) => HydrationMerge;
  isPersistedStoreKey: (key: string) => boolean;
  isProtectedSyncCollection: (key: string) => boolean;
  isUnprotectedField: (key: string, field: string) => boolean;
  collectionRowValidator: (key: string) => ((row: any) => boolean) | undefined;
};

export function deriveRegistryMaps(
  registry: Record<string, RegistryEntry>,
): RegistryMaps {
  const entries = Object.entries(registry);

  const collectionStoreKeys = entries
    .filter(([, entry]) => entry.persistence?.kind === "collection")
    .map(([key]) => key);

  const metaStoreKeys = entries
    .filter(([, entry]) => entry.persistence?.kind === "meta")
    .map(([key]) => key);

  const protectedCollectionKeys = entries
    .filter(([, entry]) => entry.localFirst)
    .map(([key]) => key);

  // Boot-hydration apply lists, derived so a persisted key can never silently
  // skip hydration: every persisted key lands in exactly one of critical /
  // deferred / manual.
  const hydratedEntries = entries.filter(
    ([, entry]) => entry.persistence && entry.hydration !== "manual",
  );

  const phaseOf = (entry: RegistryEntry): HydrationPhase | undefined =>
    (entry.hydration as { phase?: HydrationPhase } | undefined)?.phase;

  const hydrationCriticalKeys = hydratedEntries
    .filter(([, entry]) => phaseOf(entry) !== "deferred")
    .map(([key]) => key);

  const hydrationDeferredKeys = hydratedEntries
    .filter(([, entry]) => phaseOf(entry) === "deferred")
    .map(([key]) => key);

  const dispatchTableMap = Object.fromEntries(
    entries.flatMap(([key, entry]) => (entry.dispatchTable ? [[key, entry.dispatchTable]] : [])),
  ) as RegistryMaps["dispatchTableMap"];

  const dispatchFieldTableMap = Object.fromEntries(
    entries.flatMap(([key, entry]) =>
      entry.dispatchFieldTable ? [[key, { table: entry.dispatchFieldTable }]] : [],
    ),
  ) as RegistryMaps["dispatchFieldTableMap"];

  const protectedKeys = new Set(protectedCollectionKeys);

  const unprotectedFieldSets = new Map<string, Set<string>>(
    entries.flatMap(([key, entry]) =>
      entry.unprotectedFields?.length ? [[key, new Set(entry.unprotectedFields)] as const] : [],
    ),
  );

  return {
    collectionStoreKeys,
    metaStoreKeys,
    protectedCollectionKeys,
    hydrationCriticalKeys,
    hydrationDeferredKeys,
    dispatchTableMap,
    dispatchFieldTableMap,
    hydrationMergeStrategy(key: string): HydrationMerge {
      const hydration = registry[key]?.hydration;
      if (hydration && hydration !== "manual" && hydration.merge) return hydration.merge;
      return "shape";
    },
    isPersistedStoreKey(key: string): boolean {
      return !!registry[key]?.persistence;
    },
    isProtectedSyncCollection(key: string): boolean {
      return protectedKeys.has(key);
    },
    isUnprotectedField(key: string, field: string): boolean {
      return unprotectedFieldSets.get(key)?.has(field) ?? false;
    },
    collectionRowValidator(key: string) {
      return registry[key]?.validRow;
    },
  };
}
