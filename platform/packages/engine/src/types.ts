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
  // How the key syncs, where the registry says: a local-first list or
  // singleton protects its rows and fields by diffing the slice (see
  // generateAutoPending), and `rowKey` names a list row's identity field.
  sync?: { kind?: "collection" | "singleton" | "list" | "scalar"; rowKey?: string };
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
  // This lock's own identity (newLockId), set when an action plants it.
  // Writes in one millisecond can repeat a value on one cell (an undo walk
  // replays its steps in one loop), so (ts, value) cannot tell their locks
  // apart; a refusal or an undo finds its own lock by this (sameLock).
  lock?: string;
  // Exact hidden timestamp expected from a hide/unhide reconcile. This is
  // intentionally distinct from `ts`, which is only the local lock freshness
  // clock and may be sampled a millisecond later by the middleware.
  hideAck?: number;
  // A field lock's record of the server values it hid, oldest first and
  // bounded (lockSaw). A refused write's rollback reads it: a displaced lock
  // whose own value is here was already echoed and is not brought back, and
  // the newest value is what the server holds (releaseActionFieldLocks).
  seen?: unknown[];
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
  // The window that enqueued the row (outboxOwner.ts). While that window is
  // alive, only it delivers the row; absent on rows from older builds.
  owner?: string;
  operationSchemaVersion?: number;
  // Present on repeated-write actions (see outboxCoalesceKeys): the outbox
  // keeps at most one row per key, newest wins.
  coalesceKey?: string;
  // The field locks the action planted, with what each replaced, so a
  // permanent refusal can lift them and put the prior values back
  // (releaseActionFieldLocks). Absent when the action protected no field.
  locks?: ActionFieldLock[];
  // Outbox ids this row must not overtake (an undo after the write it
  // reverses). A drain holds the row while one of them is still undelivered.
  after?: string[];
};

/** One field lock an action planted on a localFirst row, and what it replaced. */
export type ActionFieldLock = {
  key: string;
  storeKey: string;
  recordId: string;
  field: string;
  ts: number;
  value: unknown;
  prior: unknown;
  hadPrior: boolean;
  // The planted entry's id (PendingEntry.lock), absent on older outbox rows.
  lock?: string;
  priorLock?: PendingEntry;
  // A list row the action added (include) or removed (exclude) rather than a
  // field it changed; `rowKey` names the row's identity field and `index`
  // where a removed row sat.
  membership?: "include" | "exclude";
  rowKey?: string;
  index?: number;
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
  // A local-first list's row identity, the field a lock names a row by
  // (default `_id`). Set it when optimistic rows carry a stub `_id` but share
  // a natural key with the server row (a bookmark's message_id).
  rowKey?: string;
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
// Undo
// ---------------------------------------------------------------------------

/** One action to run as part of an undo: its name, its args, and whether its draft runs. */
export type Invocation = { action: string; args: unknown[]; runDraft?: boolean }; // runDraft default true

/**
 * One store cell an action changed, with the values on either side. `field`
 * undefined is a whole row (a collection or list row added or removed) or a
 * scalar's whole value; `id` is "" for a singleton or a scalar.
 */
export type CellChange = {
  store: string;
  id: string;
  field?: string;
  before: unknown;
  after: unknown;
  hadBefore: boolean;
  hadAfter: boolean;
  kind: "protected" | "mirror" | "view";
  // How the cell is addressed in the store, and where a removed list row sat.
  shape?: "collection" | "list" | "singleton" | "scalar";
  index?: number;
};

export type UndoCtx = {
  action: string;
  args: unknown[];
  before: any; // whole states, read-only
  after: any;
  result: unknown;
  changes: readonly CellChange[];
};

export type UndoSpec = {
  /** null = do not record this call. */
  label: (ctx: UndoCtx) => string | null;
  /**
   * Overrides the store-derived server half. Derive the invocations from
   * `ctx.changes`: a partial undo asks again with the skipped rows taken out,
   * and refuses whole if an invocation still names one.
   */
  inverse?: (ctx: UndoCtx) => Invocation[] | null;
  ignoreFields?: readonly string[];
  /** Restore view fields if the view has not moved since. */
  restoreView?: boolean;
  /** Show the "<label> · Undo" toast on record. */
  toast?: boolean;
  coalesce?: boolean;
  /** A display-only history item (org); never on the stack. */
  external?: string;
  /**
   * Blind keyboard undo stops at it with a notice; only the toast and the
   * timeline may undo it. A function is asked once, when the entry is
   * recorded, so a spec can confirm only the direction that needs it.
   */
  confirm?: boolean | ((ctx: UndoCtx) => boolean);
  /**
   * How the inverse's server half stores what it restores, for a value the
   * server spells differently from the prior one (a verb that stamps a field
   * the row never had). Given the cells an undo writes, return them with
   * each such before value spelled the server's way; the replay then writes,
   * locks and compares that value, so the inverse's echo retires the lock.
   * `ctx` is the gesture as it was recorded, for a spelling that depends on
   * the row the gesture found. The writer route's counterpart is
   * `UndoWriter.clears`.
   */
  spell?: (cells: CellChange[], ctx?: UndoCtx) => CellChange[];
};

export type UndoWriter = {
  fields?: (id: string, fields: Record<string, unknown>, row: any, state: any) => Invocation[];
  restoreRow?: (id: string, row: any, state: any) => Invocation[];
  removeRow?: (id: string, row: any, state: any) => Invocation[];
  /**
   * How the server stores a field it cannot unset once set (a cleared task
   * assignee is stored as ""). An undo that takes such a field back to unset
   * restores this value instead, so the row is what the server will echo and
   * the replay's lock retires on that echo.
   */
  clears?: Readonly<Record<string, unknown>>;
};

export type UndoOutcome =
  | { ok: true; applied: number; skipped: number }
  // "already": every row is back at its before value, so there is nothing to
  // take back. A lone entry reports it as a conflict; a group child counts as
  // undone without a skipped row.
  | { ok: false; reason: "conflict" | "gone" | "expired" | "already" };

export type UndoEntry = {
  id: string;
  label: string;
  ts: number;
  status: "done" | "undone" | "conflict" | "refused" | "dropped" | "external";
  undo: () => UndoOutcome | void;
  redo: () => UndoOutcome | void;
  action?: string;
  args?: unknown[];
  changes?: CellChange[];
  planted?: Record<string, unknown>;
  children?: UndoEntry[];
  outboxIds?: string[];
  objects?: Array<{ store: string; id: string }>;
  skipped?: Array<{ store: string; id: string }>;
  external?: string;
  droppedBy?: string;
  undoneAt?: number;
  /** When a redo last put it back: the keyboard window counts from here too. */
  redoneAt?: number;
  mode: "generic" | "manual";
  /** From the spec: blind keyboard undo skips this entry with a notice. */
  confirm?: boolean;
  /** Outbox ids of this entry's own undo dispatches (a refused one puts the entry back). */
  replayOutboxIds?: string[];
  /** Which way those dispatches went: the stack the replay put the entry on. */
  replayDir?: "undo" | "redo";
};

export type UndoConfig = {
  specs: Record<string, UndoSpec>;
  replayAction: string; // codecast: "applyUndoPatches"
  writers?: Record<string, UndoWriter>; // store keys off the patch rail
  stampFields?: ReadonlySet<string>; // "updated_at": restamped Date.now(), never compared
  // Fields the server assigns when it creates a row ("created_at"): the echo
  // of an add carries the server's own value, so the row-add guard skips them.
  serverAssignedFields?: ReadonlySet<string>;
  // A row the server keeps after a delete and the sync log still delivers,
  // marked (a doc with archived_at). The guard reads it as gone, so the undo
  // of the delete still applies once the marked row has synced back.
  tombstone?: (store: string, row: unknown) => boolean;
  ignoreKeys?: ReadonlySet<string>; // never captured (clientState, tabs, pagination, ...)
  beforeReplay?: (entry: UndoEntry, dir: "undo" | "redo") => void;
  afterReplay?: (entry: UndoEntry, dir: "undo" | "redo", applied: readonly CellChange[]) => void;
  restoreView?: (draft: any, field: string, value: unknown) => void;
  keyboardWindowMs?: number; // default 300_000
  stackLimit?: number; // default 100
  historyLimit?: number; // default 200
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
  // Generic undo: any action with a spec records the cells it changed, and
  // undo writes the old values back through the same action pipeline. Absent
  // = nothing is captured.
  undo?: UndoConfig;
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
