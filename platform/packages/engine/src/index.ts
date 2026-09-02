// @platform/engine — the local-first store engine.
//
// The engine owns the mechanics: optimistic writes with pending protection, a
// durable dispatch outbox that survives reloads, identity-preserving sync, IDB
// persistence with boot hydration, and the render-cost tools (wake signatures,
// coarse clocks) that keep a live app off the main thread. It knows nothing
// about any application's entities — everything domain-shaped arrives through
// PlatformConfig.

export { createLocalFirstStore, type LocalFirstStore } from "./store";
export { createPersistence, unionHydrate, hydrateMergeValue } from "./persistence";
export type { Persistence, PersistenceHooks, StoreLike } from "./persistence";

export {
  action,
  sync,
  asyncAction,
  receiptAsyncAction,
  mutativeMiddleware,
  groupPatchesByTable,
  generateAutoPending,
  outboxCoalesceKeyFor,
  isPermanentDispatchError,
  isParkedDispatchError,
  makeIsMustDeliverEntry,
  makeOutboxFailureDisposition,
  defaultIsServerId,
  CommandReceiptRejectedError,
  DispatchNotWiredError,
  StaleDispatchBindingError,
  UnsupportedOutboxOperationSchemaError,
  MAX_OUTBOX_BOOT_ATTEMPTS,
  OUTBOX_MAX_REPLAY_AGE_MS,
  STORAGE_WATCHDOG_MS,
  STORAGE_WATCHDOG_MAX_TIMER_LAG_MS,
  STORAGE_WATCHDOG_RECHECK_MS,
  CURRENT_OUTBOX_OPERATION_SCHEMA_VERSION,
  type MiddlewareOptions,
  type GroupPatchesContext,
} from "./middleware";

export { applySyncTable, applySyncRecord } from "./syncProtocol";
export { createSyncEngine, applyMerge, rekeyPending, type SyncEngine } from "./syncEngine";

export { deriveRegistryMaps, type RegistryMaps } from "./registry";

export {
  createIdbCache,
  expireExcludeTombstones,
  PERSISTENCE_AVAILABLE,
  DEFAULT_EXCLUDE_TOMBSTONE_TTL_MS,
  type IdbCache,
  type PlatformCache,
  type DetailRecord,
} from "./idbCache";
export { createKVCache, type KVStore } from "./kvCache";
export { diffCollection, type CollectionDiff } from "./idbCollectionDiff";
export { partitionCacheRetention, type CacheRetentionPolicy } from "./cacheRetention";

export { stableRefId, rowSigExcluding, makeCollectionSig } from "./wakeSig";

export {
  pushUndo,
  performUndo,
  performRedo,
  showUndoToast,
  canUndo,
  canRedo,
  setUndoNotifier,
  _resetUndoStacks,
  type UndoEntry,
  type UndoNotifier,
} from "./undoStack";

export { makeUseTrackedStore, useCoarseNow, useSyncRefresh, type TrackedStoreSource } from "./react";

export {
  createClientSync,
  SyncOrderError,
  type ClientSync,
  type ClientSyncOptions,
  type DeltaPage,
  type DeltaSubscription,
  type SyncPhase,
  type SyncSession,
  type SyncTransport,
} from "./binding";

export type {
  PlatformConfig,
  PlatformStoreInternals,
  RegistryEntry,
  SyncOpts,
  PendingEntry,
  OutboxEntry,
  MergeSpec,
  MergeSpecMap,
  MergePolicy,
  MergeFn,
  ReceiptContinuations,
  ViewGuard,
  ViewGuardChange,
  DetailTableConfig,
  PersistenceKind,
  DispatchTableKind,
  HydrationPhase,
  HydrationMerge,
  DispatchFn,
  IDBWriteFn,
  OutboxEnqueueFn,
  OutboxRemoveFn,
  OutboxLoadFn,
  MaybePromise,
} from "./types";

export { rowsToCamel, patchesToSnake } from "./case";
export {
  extractReplicationUpdates,
  snapshotEntries,
  createFollowerInbox,
  type ReplicationUpdate,
  type ReplicationMessage,
  type FollowerInbox,
  type FollowerInboxResult,
} from "./replication";
export {
  createReplicationHost,
  createReplicationFollower,
  type ReplicationChannel,
  type ReplicationHost,
  type ReplicationFollower,
  type ApplyUpdatesFn,
} from "./replicationRuntime";
