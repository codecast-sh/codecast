// Public types for the local-first engine.
//
// Everything the engine needs to know about an application's data model arrives
// through PlatformConfig. The engine itself knows only two vocabulary words:
// a "collection" (an id-keyed map of rows, each row carrying `_id`) and a
// "singleton" (one object under a store key).

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type PersistenceKind = "collection" | "meta";
export type DispatchTableKind = "collection" | "singleton";
export type HydrationPhase = "critical" | "deferred";
export type HydrationMerge = "shape" | "fill";

export type RegistryEntry = {
  persistence?: {
    kind: PersistenceKind;
    key: string;
  };
  // Boot hydration is automatic for every persisted key — registering a
  // persistence entry IS the permission to load AND save. This field only
  // tunes it, never gates it:
  //   phase "critical" (default) — applied in the first hydrate pass, before
  //     first paint; "deferred" — applied a tick later (heavy list-view data).
  //   merge "shape" (default) — objects union (cache as floor, live wins
  //     per key), arrays fill only an empty slot, scalars replace; "fill" —
  //     only lands while the store slot is still null (live-synced singletons
  //     a stale cache must never clobber).
  //   "manual" — the hydration caller consumes the cached value with bespoke
  //     logic (excluded from the derived apply lists).
  hydration?: { phase?: HydrationPhase; merge?: HydrationMerge } | "manual";
  localFirst?: boolean;
  dispatchTable?: {
    table: string;
    kind: DispatchTableKind;
    // When set, ONLY these fields dispatch — for a store key that is a
    // client-side projection of another table, where most fields are
    // server-derived enrichment that must never be patched back, but a few
    // user-gesture fields are real server state.
    fields?: readonly string[];
  };
  dispatchFieldTable?: string;
  // Per-row validity for a persisted collection. Rows failing this are dropped
  // (and removed from disk) at cache hydration. Guards against foreign
  // documents persisted under the wrong collection, which would otherwise
  // linger in the never-pruned cache forever as phantoms.
  validRow?: (row: any) => boolean;
  // Fields on a localFirst collection that auto pending protection must skip.
  // For an append-stream field (a row's comment list) the optimistic local
  // value contains stub content the server echo can never match, so a field
  // lock would freeze the field forever; instead the optimistic write renders
  // until the server's authoritative set reconciles it. Stale locks on these
  // fields are also dropped at cache hydration.
  unprotectedFields?: readonly string[];
};

// ---------------------------------------------------------------------------
// Pending protection + outbox
// ---------------------------------------------------------------------------

export type PendingEntry = {
  type: "exclude" | "include" | "field";
  value?: any;
  ts?: number;
  // Exact hidden timestamp expected from a hide/unhide reconcile. This is
  // intentionally distinct from `ts`, which is only the local lock freshness
  // clock and may be sampled a millisecond later by the middleware.
  hideAck?: number;
  // An exclude planted by a scope revocation purge carries the scope key it
  // was purged for, so a rejoin can lift exactly those (the rows are gone, so
  // nothing else can name them).
  scope?: string;
};

export type OutboxEntry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
  // Failed boot replays so far; entries are given up on at
  // MAX_OUTBOX_BOOT_ATTEMPTS unless they are must-deliver.
  attempts?: number;
  operationSchemaVersion?: number;
  // Present on repeated-write actions (see outboxCoalesceKeys): the outbox
  // keeps at most one row per key, newest wins.
  coalesceKey?: string;
};

// ---------------------------------------------------------------------------
// Sync recipes
// ---------------------------------------------------------------------------

export type MergePolicy = "replace" | "local_wins" | "set_union" | "deep_merge";
export type MergeFn = (local: any, server: any, initialized: boolean) => any;
export interface MergeSpecMap { [key: string]: MergePolicy | MergeSpecMap | MergeFn }
export type MergeSpec = MergePolicy | MergeSpecMap | MergeFn;

export type SyncOpts = {
  kind?: "collection" | "singleton" | "list" | "scalar";
  // Skip the updated_at version bail. Replicated OPTIMISTIC rows change fields
  // without bumping updated_at, so to the version heuristic they look like
  // heartbeat no-ops and are dropped. Field-level identity reuse still applies,
  // so a genuinely unchanged row remains a no-op.
  force?: boolean;
  merge?: Record<string, MergeSpec>;
  altKey?: string;
  keepSelected?: string;
  transform?: (draft: any, result: any, incoming: any, initialized: boolean, prev?: any) => void;
  extra?: Record<string, any>;
  // When true, `incoming` is treated as a partial set of changed records:
  // missing rows in `prev` are preserved instead of being dropped. Used for
  // delta-cursor queries. Soft-deletes arrive as updated rows; hard deletes are
  // NOT supported in delta mode.
  isDelta?: boolean;
  // Perf escape hatch for applySyncTable's identity reuse: by default it compares
  // ALL scalar fields, so any per-push-churning scalar would re-render the row
  // every push. List such a field here to exclude it from the version key. Safe
  // to omit — a mistake here only costs an extra render, never a dropped update.
  ignoreFields?: string[];
  // Non-scalar fields the identity reuse must compare by CONTENT. The version
  // key skips objects and arrays (a live push re-sends every row as fresh
  // objects, so reference compare would churn every identity and content
  // compare of every nested value would cost a stringify per row per push).
  // That skip assumes a nested change always comes with a scalar change; a
  // server-joined field (a project's task counts, derived from other rows)
  // breaks the assumption and would be dropped. Name such fields here.
  deepFields?: string[];
  // Fields owned by a separate overlay channel, not the base payload. On a base
  // sync these keep their previous (overlay-set) value rather than being
  // clobbered by the base's null — so the base list and the overlay can write
  // the same rows without fighting.
  preserveFields?: string[];
  // Delta mode normally treats absence as "unchanged", so hard deletes never
  // propagate. When the payload is the COMPLETE server set for some scope, pass
  // a predicate for that scope: in-scope records absent from the payload are
  // removed via an exclude-pending entry (the deletion contract the IDB diff
  // honors). Per-call only — scope depends on what was fetched.
  pruneAbsentScope?: (record: any) => boolean;
  // Applied to `incoming` before the list/singleton equality bail. Use it to
  // quantize volatile fields (presence timestamps, streaming counters) whose
  // per-push value changes defeat the JSON compare even though nothing the UI
  // shows has changed.
  normalize?: (incoming: any) => any;
};

// ---------------------------------------------------------------------------
// Receipt continuations
// ---------------------------------------------------------------------------

/**
 * A create whose local result asks for follow-up work once the server
 * acknowledges the command (navigate somewhere, attach the new row to
 * something). `resolve` validates the intent carried by the optimistic local
 * result; `apply` performs it and returns whether it completed. Returning false
 * deliberately leaves the outbox row in place, so the next runtime observes the
 * finished world and retires the intent — that makes a crash between the effect
 * and the cleanup exactly idempotent.
 */
export type ReceiptContinuations = {
  resolve: (actionName: string, localResult: unknown) => unknown | null;
  apply: (ctx: {
    actionName: string;
    continuation: unknown;
    serverResult: unknown;
    commandId: string;
    getState: () => any;
  }) => boolean;
};

// ---------------------------------------------------------------------------
// View guard
// ---------------------------------------------------------------------------

export type ViewGuardChange = { field: string; from: any; to: any };

export type ViewGuard = {
  /** Store fields whose changes must be declared before they are applied. */
  fields: string[];
  /** Returns the fields to revert to their previous values. */
  audit: (changes: ViewGuardChange[], actionName: string) => string[];
};

// ---------------------------------------------------------------------------
// Detail tables
// ---------------------------------------------------------------------------

export type DetailTableConfig = {
  /** Primary key field of the detail row (e.g. "threadId"). */
  keyField: string;
  /** Freshness stamp for cap/TTL pruning; defaults to write time. */
  latestTimestamp?: (value: any) => number;
  /** Most-recent rows to keep on disk. */
  maxRows?: number;
  /** Age past which a row is dropped. */
  ttlMs?: number;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type PlatformConfig = {
  dbName: string;
  dbVersion: number;
  registry: Record<string, RegistryEntry>;
  syncRegistry: Record<string, SyncOpts>;
  // Fields where a server-omitted value and a local null mean the same
  // acknowledgement. All other fields keep strict null/undefined semantics.
  optionalClearFields?: ReadonlySet<string>;
  // Actions carrying user-authored content that MUST reach the server.
  mustDeliverActions?: ReadonlySet<string>;
  // Must-deliver intents that cannot be named by action alone (e.g. one
  // subcommand of a generic command action carries user-authored stakes).
  // OR'd with mustDeliverActions and the receipt-envelope rule.
  mustDeliverExtra?: (entry: OutboxEntry) => boolean;
  // Repeated writes that rewrite the same logical value each time. Only
  // register actions whose args carry the COMPLETE new value for the key.
  outboxCoalesceKeys?: Record<string, (args: any[]) => string | null>;
  // Rewrite a replayed patch payload (drop values that are stale by definition
  // once they survive a reload, e.g. a "where the user is right now" pointer).
  transformReplayPatches?: (patches: any) => any;
  viewGuard?: ViewGuard;
  receiptContinuations?: ReceiptContinuations;
  // Appended (in parentheses) to the storage watchdog's unhealthy log line, so
  // an app can point at its own most likely cause (e.g. another tab of the same
  // app holding the database open across a schema upgrade).
  storageWatchdogHint?: string;
  // Fields whose numeric write stamps the exact acknowledgement value onto the
  // sibling field-pending entries of the same row.
  hideAckFields?: ReadonlySet<string>;
  // Whether an id is a real server id. Stub ids never dispatch, and are the
  // rows an altKey supersede rekeys.
  isServerId?: (id: string) => boolean;
  // Commands that predate the receipt envelope but whose server still answers
  // with a receipt; a terminal rejection there must still be interpreted.
  legacyReceiptActions?: ReadonlySet<string>;
  // Rekey the application's own referencing state when a stub row is superseded
  // by its real server row.
  rekeyExtra?: (draft: any, oldId: string, newId: string) => void;
  detailTables?: Record<string, DetailTableConfig>;
  // Age past which an exclude tombstone is dropped at hydration. Include/field
  // entries are local-first writes awaiting acknowledgement: never expired.
  excludeTombstoneTtlMs?: number;
};

// ---------------------------------------------------------------------------
// Store internals installed by the middleware
// ---------------------------------------------------------------------------

/**
 * Sends one dispatch to the server.
 *
 * `commandId` is present only for receipt-aware actions, and the middleware
 * always supplies it — it is the same id the receipt envelope in `result`
 * carries, lifted out so a transport can pass it as its own field. A server
 * that reads the envelope instead can ignore this argument.
 */
export type DispatchFn = (
  action: string,
  args: any,
  patches?: any,
  result?: any,
  commandId?: string,
) => Promise<any>;
export type MaybePromise<T> = T | Promise<T>;
export type IDBWriteFn = (patches: any[], state: any) => MaybePromise<void>;
export type OutboxEnqueueFn = (entry: OutboxEntry) => MaybePromise<void>;
export type OutboxRemoveFn = (id: string) => MaybePromise<void>;
export type OutboxLoadFn = () => Promise<OutboxEntry[]>;

export type PlatformStoreInternals = {
  _setDispatch: (fn: DispatchFn | null, options?: { owner?: object }) => void;
  _clearDispatch: (owner: object) => void;
  _drainOutbox: () => void;
  _hasBootOutboxDrained: () => boolean;
  _isDispatchWired: () => boolean;
  _setIDBWrite: (fn: IDBWriteFn | null) => void;
  _setOutbox: (
    enqueue: OutboxEnqueueFn | null,
    remove: OutboxRemoveFn | null,
    load: OutboxLoadFn | null,
  ) => void;
  _clearRuntimeBindings: () => void;
  _setDispatchError: (fn: (action: string, error: unknown, args?: unknown) => void) => void;
  _setStorageHealth: (fn: ((healthy: boolean, elapsedMs: number) => void) | null) => void;
  _setActionTee: (fn: ((actionName: string, patches: any[], state: any) => void) | null) => void;
  _dispatch: (action: string, args: any, patches?: any, result?: any) => Promise<any>;
};
