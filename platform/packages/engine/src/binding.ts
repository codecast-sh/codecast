// The client sync runtime binding: the ordered boot protocol between a
// local-first store and its server transport.
//
// The order is a contract, not a convention:
//   1. hydrate()  — wire write-through + outbox, replay the cache into the
//                   store (critical keys, a paint, then deferred keys)
//   2. connect()  — bind the dispatch function (the middleware drains the
//                   persisted outbox the moment it binds), then open the
//                   delta subscriptions
//   3. refresh()  — on focus / reconnect, publish online state and re-drive
//                   the outbox
//
// hydrate-before-connect is enforced, not commented: connect() throws
// SyncOrderError until hydrate() has settled. Binding dispatch first would
// drain an outbox whose durable rows are not loaded yet, and write-through
// opening against a store still holding only a live window would prune the
// on-disk shadow (see persistence.ts). The transport is injected, so this
// module knows nothing about Convex — only the delta page shape
// { rows, nextSince, hasMore } and the `since` paging argument.

import { createPersistence, type PersistenceHooks, type StoreLike } from "./persistence";
import type { PlatformCache } from "./idbCache";
import type { DispatchFn, PlatformConfig, PlatformStoreInternals } from "./types";

/** One page of a delta query: rows plus the watermark to page from. */
export type DeltaPage = {
  rows?: unknown[] | null;
  nextSince?: unknown;
  hasMore?: boolean;
};

/**
 * The server transport, injected by the app. `subscribe` opens a live
 * subscription and returns its unsubscribe; `query` is the one-shot form used
 * to page while a delta page reports hasMore. Query references are opaque to
 * the engine and handed back unchanged.
 */
export type SyncTransport = {
  subscribe: (
    query: unknown,
    args: Record<string, unknown>,
    onPage: (page: DeltaPage) => void,
  ) => () => void;
  query: (query: unknown, args: Record<string, unknown>) => Promise<DeltaPage | null | undefined>;
};

export type DeltaSubscription = {
  /** Store collection the rows land in (first argument to applyRows). */
  storeKey: string;
  /** Opaque query reference for the transport. */
  query: unknown;
  /** Scoped subscriptions open only while a scope is set (see setScope). */
  scoped?: boolean;
};

/** Everything a signed-in connection needs; a new session epochs the dispatch binding. */
export type SyncSession = {
  transport: SyncTransport;
  /** Sends one dispatch envelope to the server (bound via _setDispatch). */
  dispatch: DispatchFn;
  subscriptions: readonly DeltaSubscription[];
  /** Args merged into every subscription and paging query (e.g. { token }). */
  baseArgs?: Record<string, unknown>;
};

export type ClientSyncOptions = {
  config: PlatformConfig;
  /** The store; getState() must expose PlatformStoreInternals. */
  store: StoreLike;
  /** Land one page of delta rows in the store (e.g. a syncTable action). */
  applyRows: (storeKey: string, rows: unknown[]) => void;
  /** Called once hydrate settles — success or failure, the wait is over. */
  onHydrated?: () => void;
  /** Receives online state on every refresh tick. */
  setOnline?: (online: boolean) => void;
  /** Online probe; defaults to navigator.onLine (true where absent). */
  isOnline?: () => boolean;
  /** A paging query failed for a reason the app maps to auth expiry. */
  onAuthExpired?: (error: unknown) => void;
  /** Classifies paging errors for onAuthExpired. */
  isAuthError?: (error: unknown) => boolean;
  /** Any other hydrate/paging failure. */
  onError?: (context: { storeKey?: string }, error: unknown) => void;
  persistenceHooks?: PersistenceHooks;
  /** Explicit cache (native KV, tests); bypasses the IndexedDB check. */
  cache?: PlatformCache;
};

export type SyncPhase = "created" | "hydrating" | "hydrated" | "connected";

export class SyncOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncOrderError";
  }
}

export type ClientSync = {
  phase: () => SyncPhase;
  /**
   * Wire write-through + outbox and replay the cache (critical, then
   * deferred). Idempotent: every call returns the same settled promise, and
   * it never rejects — a failed read means an empty store the views must
   * show as empty, not a skeleton forever.
   */
  hydrate: () => Promise<void>;
  /** Bind dispatch, then open the delta subscriptions. Throws SyncOrderError before hydrate settles or while already connected. */
  connect: (session: SyncSession) => void;
  /** Set or clear the scope for scoped subscriptions; re-subscribes them when connected. */
  setScope: (scope: Record<string, unknown> | null) => void;
  /** Focus / reconnect tick: publish online state, and re-drive the outbox while online. */
  refresh: () => void;
  /** Close subscriptions and unbind dispatch (sign-out, account switch). */
  disconnect: () => void;
};

function defaultIsOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function createClientSync(options: ClientSyncOptions): ClientSync {
  const internals = () => options.store.getState() as PlatformStoreInternals;
  const isOnline = options.isOnline ?? defaultIsOnline;

  let phase: SyncPhase = "created";
  let hydration: Promise<void> | null = null;
  let session: SyncSession | null = null;
  let scope: Record<string, unknown> | null = null;
  let unsubscribes: Array<() => void> = [];
  // Bumped on every close of subscriptions; an in-flight paging loop from an
  // older generation must stop delivering rows.
  let generation = 0;

  const reportPageError = (storeKey: string, error: unknown) => {
    if (options.isAuthError?.(error)) options.onAuthExpired?.(error);
    else options.onError?.({ storeKey }, error);
  };

  // Follow a partial page: the server trimmed at a timestamp boundary, so ask
  // again from nextSince until the watermark stops reporting more. A watermark
  // that fails to advance stops the loop rather than spinning on it.
  async function pageThrough(
    sub: DeltaSubscription,
    args: Record<string, unknown>,
    since: unknown,
    gen: number,
  ): Promise<void> {
    const transport = session?.transport;
    if (!transport) return;
    while (gen === generation) {
      let page: DeltaPage | null | undefined;
      try {
        page = await transport.query(sub.query, { ...args, since });
      } catch (error) {
        if (gen === generation) reportPageError(sub.storeKey, error);
        return;
      }
      if (gen !== generation) return;
      if (page?.rows?.length) options.applyRows(sub.storeKey, page.rows);
      if (!page?.hasMore || page.nextSince === since) return;
      since = page.nextSince;
    }
  }

  function argsFor(sub: DeltaSubscription): Record<string, unknown> {
    return { ...(session?.baseArgs ?? {}), ...(sub.scoped ? (scope ?? {}) : {}) };
  }

  function openSubscriptions() {
    const active = session;
    if (!active) return;
    const gen = generation;
    for (const sub of active.subscriptions) {
      if (sub.scoped && !scope) continue;
      const args = argsFor(sub);
      unsubscribes.push(
        active.transport.subscribe(sub.query, args, (page) => {
          if (gen !== generation) return;
          if (page?.rows?.length) options.applyRows(sub.storeKey, page.rows);
          if (page?.hasMore) void pageThrough(sub, args, page.nextSince, gen);
        }),
      );
    }
  }

  function closeSubscriptions() {
    generation++;
    unsubscribes.forEach((u) => u());
    unsubscribes = [];
  }

  return {
    phase: () => phase,

    hydrate() {
      if (hydration) return hydration;
      phase = "hydrating";
      const persistence = createPersistence(
        options.config,
        options.store,
        options.persistenceHooks,
        undefined,
        options.cache,
      );
      hydration = persistence
        .hydrate()
        .catch((error) => {
          options.onError?.({}, error);
        })
        .then(() => {
          phase = "hydrated";
          options.onHydrated?.();
        });
      return hydration;
    },

    connect(next: SyncSession) {
      if (phase === "created" || phase === "hydrating") {
        throw new SyncOrderError(
          "connect() before hydrate() settled: the dispatch binding drains the outbox " +
            "and the delta channel feeds the store, so both must wait for the cache " +
            "replay to wire write-through and load the durable outbox rows.",
        );
      }
      if (phase === "connected") {
        throw new SyncOrderError("connect() while connected: disconnect() first.");
      }
      session = next;
      phase = "connected";
      // Dispatch first: _setDispatch drains the persisted outbox left by a
      // previous page load, so parked writes ship before live deltas overlay
      // them. The session object is the epoch owner — a new connect
      // invalidates in-flight dispatches from the old one.
      internals()._setDispatch(next.dispatch, { owner: next });
      openSubscriptions();
    },

    setScope(next: Record<string, unknown> | null) {
      scope = next;
      if (phase !== "connected") return;
      // Scoped queries re-subscribe against the new scope; unscoped ones are
      // scope-independent but share the unsubscribe list, so reopen all.
      closeSubscriptions();
      openSubscriptions();
    },

    refresh() {
      const online = isOnline();
      options.setOnline?.(online);
      if (online) internals()._drainOutbox();
    },

    disconnect() {
      closeSubscriptions();
      if (session) internals()._clearDispatch(session);
      session = null;
      if (phase === "connected") phase = "hydrated";
    },
  };
}
