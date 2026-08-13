// The capability library's local-first store layer: what every machine on the
// fleet actually has installed, and the browsed catalog cache behind the
// library page.
//
// TWO SLICES, DELIBERATELY DIFFERENT SHAPES
//
//   capabilityState    a synced collection — one row per (device, client, scope)
//                      carrying that machine's inventory as a JSON string.
//   capabilityCatalog  a bounded meta blob — the last browsed page of the PUBLIC
//                      catalog, cached so the library repaints instantly.
//
// The catalog is not a synced collection and must never become one. It has no
// owner and no bound on its size; mirroring thousands of public rows per user
// into Convex and then into every browser's IndexedDB is a documented way to
// dwarf both stores. It is browsed through a paginated query and cached here
// under a cap, keyed by the query it answered.
//
// WHY capabilityState IS NOT `localFirst`
//
// Local-first field protection holds an optimistic value until the server echoes
// it back identically. Every field on a capability_state row is the DAEMON'S
// OBSERVATION of a disk this browser cannot see — `entries_json`, `entries_hash`,
// `last_error`, `reported_at`. There is no user gesture that writes one, so a
// pending entry over one of these could only ever mask the truth with a guess,
// which is precisely the invisible per-machine failure the library exists to
// end. The client reads this mirror and writes bindings (a separate collection,
// phase 2); it never writes the mirror. Chat opts out for a different reason —
// unpredictable server clock stamps — but the registry shape is the same
// (store/chatSlice.ts, clientSyncRegistry.ts:123-133).
//
// WHY IT IS A COLLECTION AND NOT ONE BLOB
//
// The fleet page reads every device at once, but a machine's detail pane queries
// ONE device. As a delta-overlay collection, syncing one device's rows can never
// prune another device's mirror, and `applySyncTable`'s identity reuse keeps the
// row ref of a machine that did not change — so the parse cache below stays warm
// and the rollups stop recomputing. One replaced blob gives up both.
//
// EVERYTHING DERIVED IS DERIVED AT RENDER
//
// Drift counts and per-device rollups are computed from the rows on the way to
// the screen (`selectCapabilityIndex` and friends) and are never written back
// into the store. Field protection reconciles by `===`, so an optimistic OBJECT
// never matches the server's re-derived object and freezes forever — the trap
// lib/liveEntities exists to document. The selectors are memoized on the
// collection ref instead, which gets the cheapness without the lie.

import { makeCollectionSig, rowSigExcluding } from "./wakeSig";
import type { Capability, InstalledEntry } from "@codecast/shared/contracts";

/* ---------------------------------------------------------------------------
 * Row shapes
 * ------------------------------------------------------------------------- */

/**
 * One `capability_state` document: what one client, on one machine, in one
 * scope, reported at its last scan.
 *
 * `entries_json` is a string on purpose, and it stays a string in the store. The
 * daemon hashes it and resends only on a hash change, so `entries_hash` is a
 * faithful stand-in for the content everywhere a cheap comparison is wanted —
 * the same contract `modelInventoryValidator` already runs on
 * (`deviceSettingsShared.ts:22-30`).
 */
export type CapabilityStateRow = {
  _id: string;
  user_id?: string;
  device_id: string;
  /** An `AgentClientId` — "claude_code", "codex", … */
  client: string;
  /** "" for user scope, otherwise the project's repo identity. Never a path. */
  scope_key: string;
  entries_json: string;
  entries_hash?: string;
  /** The desired-state revision this machine has finished applying (phase 2). */
  applied_revision?: number;
  last_error?: string;
  conflicts_json?: string;
  /** `claude --version` and friends, read once per daemon boot. */
  client_version?: string;
  reported_at: number;
};

/** A public catalog row as cached for browsing. `Capability` is the shared
 *  contract shape; the stamp is ours, so a stale card can say when it was read. */
export type CapabilityCatalogEntry = Capability & { cached_at: number };

/**
 * The browsed catalog, bounded.
 *
 * `query` is part of the cache, not metadata about it: a page fetched under one
 * filter is not the answer to another, and replaying it as one is how a library
 * shows results for a search nobody typed.
 */
export type CapabilityCatalogCache = {
  entries: Record<string, CapabilityCatalogEntry>;
  /** Slugs newest-delivery-first. This is the eviction order. */
  recent: string[];
  query: string;
  fetchedAt: number;
};

/** How many public catalog rows may sit in the cache (and therefore on disk).
 *  A browse page is ~25 rows, so this holds roughly a dozen pages of scrollback
 *  and nothing like a mirror of the catalog. */
export const CAPABILITY_CATALOG_CACHE_MAX = 300;

export const EMPTY_CAPABILITY_CATALOG: CapabilityCatalogCache = {
  entries: {},
  recent: [],
  query: "",
  fetchedAt: 0,
};

/* ---------------------------------------------------------------------------
 * Freshness
 * ------------------------------------------------------------------------- */

/**
 * How long a machine's report stays believable.
 *
 * The daemon writes on a content change and, failing that, once an hour to prove
 * it is alive. Two missed liveness writes is the point where "this machine has
 * no skills installed" stops being a fact and becomes a guess, and a fleet page
 * must say so rather than render an empty machine as an accurate one.
 */
export const CAPABILITY_REPORT_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Staleness takes `now` as an argument instead of reading the clock, because it
 * is TIME-driven: no field changes when a report ages out, so nothing in the
 * store or in a wake signature can wake the view. The caller passes the value
 * from `useCoarseNow`, which is what actually re-renders on the tick.
 */
export function isCapabilityReportStale(
  row: Pick<CapabilityStateRow, "reported_at"> | null | undefined,
  now: number,
): boolean {
  if (!row || typeof row.reported_at !== "number") return true;
  return now - row.reported_at > CAPABILITY_REPORT_STALE_MS;
}

/* ---------------------------------------------------------------------------
 * Slice data
 * ------------------------------------------------------------------------- */

export type CapabilitySliceData = {
  capabilityState: Record<string, CapabilityStateRow>;
  capabilityCatalog: CapabilityCatalogCache;
};

export type CapabilitySliceActions = {
  /** Fold one page of a paginated catalog browse into the cache. Named rather
   *  than routed through `syncTable`, because a page is a fragment: a singleton
   *  merge would drop everything the reader already scrolled past. */
  cacheCapabilityCatalogPage: (query: string, page: readonly Capability[]) => void;
  /** Drop the cache. The library's "refresh" gesture, and the escape hatch when
   *  a cached page is provably behind the server. */
  clearCapabilityCatalogCache: () => void;
};

export type CapabilitySliceState = CapabilitySliceData & CapabilitySliceActions;

/** What a capability action may touch. Narrow on purpose: this slice owns two
 *  keys and reads nothing else. */
type CapabilityDraft = CapabilitySliceData;

/** The store's `sync` decorator, as a parameter. See `createCapabilitySlice`. */
export type SliceWriterDecorator = <T extends (...args: any[]) => any>(fn: T) => T;

/**
 * Build the slice. `decorate` is `sync` from store/mutativeMiddleware — passed
 * in rather than imported, and that is load-bearing rather than fussy.
 *
 * `mutativeMiddleware` reads `DISPATCH_TABLE_MAP` from `clientSyncRegistry` at
 * MODULE INIT (`mutativeMiddleware.ts:165`). If this file imported the
 * middleware, then `clientSyncRegistry` importing the registry fragment below
 * would close a cycle — clientSyncRegistry → capabilities → mutativeMiddleware →
 * clientSyncRegistry — and the middleware's body would run while
 * clientSyncRegistry's had not, dereferencing a `const` still in its temporal
 * dead zone. That is an import-time crash, not a subtle bug. The chat slice
 * dodges the same cycle by hand-copying its registry entries into
 * clientSyncRegistry.ts; one parameter buys a single source of truth instead.
 *
 * A test passes the identity function: `sync` only tags the function it is given.
 */
export function createCapabilitySlice(decorate: SliceWriterDecorator): CapabilitySliceState {
  const sync = decorate;
  return {
    capabilityState: {},
    // A fresh object, not the shared EMPTY_CAPABILITY_CATALOG: the store slot is
    // a mutative draft and the shared constant is also a comparison value, so
    // handing the store the same reference invites one to be edited through the
    // other.
    capabilityCatalog: { ...EMPTY_CAPABILITY_CATALOG, entries: {}, recent: [] },

    // `sync` and not `action`: the catalog is a read-through cache of a public
    // query. Dispatching it back to the server would be echoing the server its
    // own answer.
    cacheCapabilityCatalogPage: sync(function (
      this: CapabilityDraft,
      query: string,
      page: readonly Capability[],
    ) {
      const rows = Array.isArray(page) ? page : [];
      const cache = this.capabilityCatalog ?? EMPTY_CAPABILITY_CATALOG;
      const changingQuery = cache.query !== query;

      const entries: Record<string, CapabilityCatalogEntry> = changingQuery
        ? {}
        : { ...cache.entries };
      const recent: string[] = changingQuery ? [] : cache.recent.slice();
      const now = Date.now();

      const arriving: string[] = [];
      for (const row of rows) {
        // Identity validation lives in the shared contract's parseCapabilitySlug
        // and runs at INGEST, server side. The store does not re-litigate a slug
        // it was handed; it only refuses a row it cannot key, because a row with
        // no key would be unaddressable and unevictable.
        const slug = (row as Capability | undefined)?.slug;
        if (typeof slug !== "string" || slug === "") continue;
        entries[slug] = { ...(row as Capability), cached_at: now };
        arriving.push(slug);
      }

      if (arriving.length === 0 && !changingQuery) {
        // An empty page under the same query changes nothing a reader can see.
        // Bailing keeps the meta blob's ref stable, so subscribers do not wake
        // and the whole cache is not re-written to disk.
        return;
      }

      // Newest delivery first, each slug once. Re-visiting a page refreshes its
      // rows' position, which is what makes the cap an LRU rather than a
      // first-300-wins.
      const arrivingSet = new Set(arriving);
      const nextRecent = arriving.concat(recent.filter((s) => !arrivingSet.has(s)));
      if (nextRecent.length > CAPABILITY_CATALOG_CACHE_MAX) {
        for (const slug of nextRecent.splice(CAPABILITY_CATALOG_CACHE_MAX)) {
          delete entries[slug];
        }
      }

      this.capabilityCatalog = { entries, recent: nextRecent, query, fetchedAt: now };
    }),

    clearCapabilityCatalogCache: sync(function (this: CapabilityDraft) {
      this.capabilityCatalog = { ...EMPTY_CAPABILITY_CATALOG };
    }),
  };
}

/* ---------------------------------------------------------------------------
 * Sync registration
 * ------------------------------------------------------------------------- */

/**
 * Spread into `SYNC_REGISTRY` (store/inboxStore.ts).
 *
 * Delta overlay, like every other big id-keyed collection: a push only ADDs and
 * UPDATEs. The machine detail pane queries one device, and a device-scoped push
 * must never prune the other machines' mirrors out of the cache.
 *
 * No `altKey`: nothing here is optimistically created, so there is no stub to
 * supersede. No `ignoreFields` either — `reported_at` is the one churny scalar,
 * and excluding it from the identity compare would freeze the row's own "last
 * reported" stamp at whatever it read when some other field last moved. The
 * churn is handled one layer up instead, in the wake signature, which is where
 * it costs nothing to be exactly right.
 *
 * Only `capabilityState` appears here. `capabilityCatalog` is written by the
 * named action above, never by `syncTable`, so it needs no registry entry — the
 * same arrangement `recentVisits` and the other meta blobs use.
 */
export const CAPABILITY_SYNC_REGISTRY = {
  capabilityState: { isDelta: true },
};

/**
 * Sync options for a push that is the COMPLETE set of rows for a known group of
 * devices — what a full reconcile crawl of the fleet returns.
 *
 * Delta mode treats absence as "unchanged", so without this a scope row never
 * goes away: delete a project checkout and its row would sit in the cache
 * forever, reporting skills for a directory that no longer exists. The predicate
 * bounds the prune to the devices actually crawled, so a partial payload can
 * still never gut another machine's mirror.
 */
export function capabilityStateSyncOpts(deviceIds: Iterable<string>) {
  const scope = new Set<string>();
  for (const id of deviceIds) scope.add(String(id));
  return {
    isDelta: true,
    pruneAbsentScope: (row: any) => scope.has(String(row?.device_id)),
  };
}

/**
 * Spread into `CLIENT_SYNC_REGISTRY` (store/clientSyncRegistry.ts).
 *
 * Deferred on both keys: the fleet page is never the first paint, and the header
 * of a cold boot must not wait on a machine inventory.
 *
 * `validRow` is the guard against a foreign document persisted under this key —
 * the cache never prunes, so one mis-tabled row lives forever and renders as a
 * machine with no name. A real row is addressed by its device and its client;
 * anything missing either is not one.
 *
 * No `dispatchTable` and no `localFirst`, for the reason in this file's header:
 * the client never writes a machine's report.
 */
export const CAPABILITY_CLIENT_SYNC_REGISTRY = {
  capabilityState: {
    persistence: { kind: "collection", key: "capabilityState" },
    hydration: { phase: "deferred" },
    validRow: (row: any) =>
      typeof row?.device_id === "string" && row.device_id !== "" &&
      typeof row?.client === "string" && row.client !== "",
  },
  capabilityCatalog: {
    persistence: { kind: "meta", key: "capabilityCatalog" },
    hydration: { phase: "deferred" },
  },
} as const;

/**
 * The Dexie object stores this slice needs, for the next `store/idbCache.ts`
 * version block. A registered collection with no table is not a partial
 * failure — `MISSING_COLLECTION_TABLES` catches it, and until someone reads that
 * log the whole cache degrades for the key.
 *
 * The secondary index on `device_id` is what lets a machine's pane read its own
 * rows off disk without scanning every row the client has ever cached.
 */
export const CAPABILITY_IDB_STORES = {
  capabilityState: "_id, device_id",
} as const;

/* ---------------------------------------------------------------------------
 * Wake signatures
 * ------------------------------------------------------------------------- */

/**
 * Fields left OUT of the signature, and why each one is safe to leave out:
 *
 *   reported_at   A liveness stamp. It is the one field that can move on its own
 *                 — the daemon rewrites it to prove the machine is alive even
 *                 when the inventory is byte-identical, and if that gate ever
 *                 regresses it moves at heartbeat rate across every device. It
 *                 changes nothing structural, so it wakes nobody here. Anything
 *                 rendering an age off it (a relative clock, the stale banner) is
 *                 TIME-driven and pairs this with `useCoarseNow`, which is what
 *                 makes it tick. Note it is deliberately still compared for row
 *                 identity (see CAPABILITY_SYNC_REGISTRY), so the value the view
 *                 reads on that tick is the true one.
 *
 *   entries_json  Summarized losslessly by `entries_hash`, so folding in the
 *                 whole blob would rebuild a multi-kilobyte string per row per
 *                 push to learn nothing new. When a row carries no hash — an
 *                 older daemon — the raw string goes in instead: a degraded
 *                 path should cost more, never show less.
 *
 * Everything else is in, `_id` included, so a row appearing or disappearing
 * flips the signature.
 */
const CAPABILITY_STATE_SIG_DENY: ReadonlySet<string> = new Set(["reported_at", "entries_json"]);

/** One machine's row, for a pane watching a single device. */
export function capabilityStateRowSig(row: CapabilityStateRow | null | undefined): string {
  if (!row) return "none";
  const base = rowSigExcluding(row as unknown as Record<string, any>, CAPABILITY_STATE_SIG_DENY);
  return row.entries_hash ? base : base + "raw:" + row.entries_json + ";";
}

/**
 * The whole collection, for an always-mounted surface: the fleet page's header
 * count, a sidebar "N machines drifting" badge. Subscribe to this instead of
 * `s.capabilityState` and a liveness restamp across the fleet is inert.
 */
export const capabilityStateWakeSig = makeCollectionSig<CapabilityStateRow>(capabilityStateRowSig);

/* ---------------------------------------------------------------------------
 * Reading a row's inventory
 * ------------------------------------------------------------------------- */

/** What one row's `entries_json` turned out to hold. */
export type ParsedCapabilityEntries = {
  entries: InstalledEntry[];
  /** Entries the row carried that could not be read. Rendered, never swallowed:
   *  a machine reporting things we cannot show is a fact about the machine. */
  dropped: number;
  /** The payload itself was unreadable — not "this machine has nothing". */
  unreadable: boolean;
};

const EMPTY_PARSE: ParsedCapabilityEntries = { entries: [], dropped: 0, unreadable: false };
const UNREADABLE_PARSE: ParsedCapabilityEntries = { entries: [], dropped: 0, unreadable: true };

// Keyed by the ROW OBJECT, not by the string. The sync layer preserves a row's
// reference when none of its fields changed, so an unchanged machine parses
// once and every later render reads the cache; a changed machine arrives as a
// new object and re-parses. A WeakMap needs no eviction policy — the entry
// leaves when the row it belongs to does.
const parseCache = new WeakMap<object, ParsedCapabilityEntries>();

function isReadableEntry(value: any): value is InstalledEntry {
  // Shape, not membership. The store must stay total and forward compatible: a
  // kind or an observed scope the shared enum learns in a later release still
  // has to render on a machine that already reports it, so checking against
  // today's enum here would blank tomorrow's inventory. Membership is the
  // contract's job, at ingest.
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.kind === "string" && value.kind !== "" &&
    typeof value.name === "string" && value.name !== ""
  );
}

/**
 * Read one machine's inventory. Total by construction: a malformed payload from
 * some other machine's daemon yields an "unreadable" marker, never a throw —
 * one bad row must not blank the fleet.
 */
export function parseCapabilityEntries(
  row: CapabilityStateRow | null | undefined,
): ParsedCapabilityEntries {
  if (!row) return EMPTY_PARSE;
  const cached = parseCache.get(row as unknown as object);
  if (cached) return cached;

  let result: ParsedCapabilityEntries;
  const raw = row.entries_json;
  if (typeof raw !== "string" || raw === "") {
    // A row with no payload is a machine that reported an empty scope, which is
    // a real and common answer. Not the same as one we failed to read.
    result = EMPTY_PARSE;
  } else {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = undefined;
    }
    if (!Array.isArray(decoded)) {
      result = UNREADABLE_PARSE;
    } else {
      const entries: InstalledEntry[] = [];
      let dropped = 0;
      for (const item of decoded) {
        if (isReadableEntry(item)) entries.push(item);
        else dropped++;
      }
      result = { entries, dropped, unreadable: false };
    }
  }

  parseCache.set(row as unknown as object, result);
  return result;
}

/* ---------------------------------------------------------------------------
 * Derived views — computed on the way to the screen, never stored
 * ------------------------------------------------------------------------- */

/**
 * How one capability stands on one machine. The four states are the ones
 * `InstalledEntry` keeps `enabled` and `installed` separate to express:
 *
 *   active   switched on and the bytes are there
 *   broken   switched on in a settings file, bytes never downloaded
 *   off      downloaded, switched off or never declared — an offer, free to take
 *   absent   the machine reported and never mentioned it
 */
export const CAPABILITY_PRESENCE = ["active", "broken", "off", "absent"] as const;
export type CapabilityPresence = (typeof CAPABILITY_PRESENCE)[number];

// Strongest wins when one machine reports the same capability from several
// clients or several scopes (Claude Code's own scopes stack rather than
// override, so a plugin enabled at user AND project scope is observed twice).
// The question a fleet page answers is "does this machine have it working
// anywhere", so the best observation is the machine's answer.
const PRESENCE_RANK: Record<CapabilityPresence, number> = {
  active: 3,
  broken: 2,
  off: 1,
  absent: 0,
};

function presenceOf(entry: InstalledEntry): CapabilityPresence {
  if (entry.enabled) return entry.installed ? "active" : "broken";
  return entry.installed ? "off" : "absent";
}

/** One machine, summarized. */
export type DeviceCapabilityRollup = {
  deviceId: string;
  /** How many (client, scope) rows this device reported. */
  rowCount: number;
  clients: string[];
  scopeKeys: string[];
  clientVersions: Record<string, string>;
  /** Distinct capabilities, counted once per machine however many rows saw them. */
  total: number;
  active: number;
  broken: number;
  off: number;
  byKind: Record<string, number>;
  /** Distinct `last_error` strings across the device's rows. */
  errors: string[];
  /** Rows carrying a non-empty `conflicts_json`. */
  conflictRows: number;
  unreadableRows: number;
  droppedEntries: number;
  /** The NEWEST report across this device's rows — what a freshness check reads. */
  reportedAt: number;
  /** The lowest applied revision across the device's rows, or undefined when no
   *  row has one. A machine is only as converged as its furthest-behind scope. */
  appliedRevision?: number;
};

/** One capability, across the fleet. Device ids only — the caller already has
 *  the roster and resolves display names live. */
export type CapabilityDriftRow = {
  /** The slug when the machine knew one, else `<kind>:<name>`. */
  key: string;
  kind: string;
  name: string;
  slug?: string;
  description?: string;
  activeOn: string[];
  brokenOn: string[];
  offOn: string[];
  missingOn: string[];
  clients: string[];
  /** True when this capability is not in the same state everywhere it could be:
   *  either some machine has it switched on with no bytes behind it, or it is
   *  working on some machines and not on others. This is the headline the fleet
   *  page leads with — the thing you were already living with and could not see. */
  drifting: boolean;
};

export type CapabilityIndex = {
  /** Device ids that reported at all, sorted. A device with no rows is not
   *  "missing everything"; it simply has not been heard from, and counting it as
   *  drift would light the badge for every machine that is merely asleep. */
  deviceIds: string[];
  devices: Record<string, DeviceCapabilityRollup>;
  /** Sorted by key, so a list built from this does not reorder on every push. */
  drift: CapabilityDriftRow[];
  driftCount: number;
};

const EMPTY_INDEX: CapabilityIndex = { deviceIds: [], devices: {}, drift: [], driftCount: 0 };

type DriftAccumulator = {
  kind: string;
  name: string;
  slug?: string;
  description?: string;
  perDevice: Map<string, CapabilityPresence>;
  clients: Set<string>;
};

function buildCapabilityIndex(collection: Record<string, CapabilityStateRow>): CapabilityIndex {
  const devices: Record<string, DeviceCapabilityRollup> = {};
  const byKey = new Map<string, DriftAccumulator>();
  // Per device, the strongest presence seen for each key — the same reduction the
  // drift table does, kept here so the rollup counts a capability once even when
  // three clients report it.
  const devicePresence = new Map<string, Map<string, CapabilityPresence>>();

  for (const id in collection) {
    const row = collection[id];
    if (!row || typeof row.device_id !== "string" || row.device_id === "") continue;
    const deviceId = row.device_id;

    let rollup = devices[deviceId];
    if (!rollup) {
      rollup = devices[deviceId] = {
        deviceId,
        rowCount: 0,
        clients: [],
        scopeKeys: [],
        clientVersions: {},
        total: 0,
        active: 0,
        broken: 0,
        off: 0,
        byKind: {},
        errors: [],
        conflictRows: 0,
        unreadableRows: 0,
        droppedEntries: 0,
        reportedAt: 0,
      };
      devicePresence.set(deviceId, new Map());
    }
    const seen = devicePresence.get(deviceId)!;

    rollup.rowCount++;
    if (typeof row.client === "string" && row.client !== "" && !rollup.clients.includes(row.client)) {
      rollup.clients.push(row.client);
    }
    const scopeKey = typeof row.scope_key === "string" ? row.scope_key : "";
    if (!rollup.scopeKeys.includes(scopeKey)) rollup.scopeKeys.push(scopeKey);
    if (row.client_version && row.client) rollup.clientVersions[row.client] = row.client_version;
    if (typeof row.reported_at === "number" && row.reported_at > rollup.reportedAt) {
      rollup.reportedAt = row.reported_at;
    }
    if (typeof row.applied_revision === "number") {
      rollup.appliedRevision =
        rollup.appliedRevision === undefined
          ? row.applied_revision
          : Math.min(rollup.appliedRevision, row.applied_revision);
    }
    if (row.last_error && !rollup.errors.includes(row.last_error)) rollup.errors.push(row.last_error);
    // "[]" is how a driver says "no conflicts"; only a payload with something in
    // it is a conflict worth a badge.
    if (row.conflicts_json && row.conflicts_json !== "[]" && row.conflicts_json !== "{}") {
      rollup.conflictRows++;
    }

    const parsed = parseCapabilityEntries(row);
    if (parsed.unreadable) rollup.unreadableRows++;
    rollup.droppedEntries += parsed.dropped;

    for (const entry of parsed.entries) {
      const key = entry.slug && entry.slug !== "" ? entry.slug : `${entry.kind}:${entry.name}`;
      const presence = presenceOf(entry);

      const prior = seen.get(key);
      if (prior === undefined || PRESENCE_RANK[presence] > PRESENCE_RANK[prior]) {
        seen.set(key, presence);
      }

      let acc = byKey.get(key);
      if (!acc) {
        acc = {
          kind: entry.kind,
          name: entry.name,
          slug: entry.slug,
          description: entry.description,
          perDevice: new Map(),
          clients: new Set(),
        };
        byKey.set(key, acc);
      }
      // First non-empty description wins; a machine that omitted it should not
      // erase one another machine reported.
      if (!acc.description && entry.description) acc.description = entry.description;
      if (!acc.slug && entry.slug) acc.slug = entry.slug;
      if (row.client) acc.clients.add(row.client);
      const priorAcross = acc.perDevice.get(deviceId);
      if (priorAcross === undefined || PRESENCE_RANK[presence] > PRESENCE_RANK[priorAcross]) {
        acc.perDevice.set(deviceId, presence);
      }
    }
  }

  for (const deviceId in devices) {
    const rollup = devices[deviceId];
    const seen = devicePresence.get(deviceId)!;
    rollup.clients.sort();
    rollup.scopeKeys.sort();
    rollup.errors.sort();
    for (const [, presence] of seen) {
      if (presence === "absent") continue;
      rollup.total++;
      if (presence === "active") rollup.active++;
      else if (presence === "broken") rollup.broken++;
      else rollup.off++;
    }
  }
  // byKind counts distinct capabilities per kind, so it has to run over the
  // deduped per-device set rather than over raw entries.
  for (const acc of byKey.values()) {
    for (const [deviceId, presence] of acc.perDevice) {
      if (presence === "absent") continue;
      const rollup = devices[deviceId];
      if (!rollup) continue;
      rollup.byKind[acc.kind] = (rollup.byKind[acc.kind] ?? 0) + 1;
    }
  }

  const deviceIds = Object.keys(devices).sort();
  const drift: CapabilityDriftRow[] = [];
  for (const key of Array.from(byKey.keys()).sort()) {
    const acc = byKey.get(key)!;
    const activeOn: string[] = [];
    const brokenOn: string[] = [];
    const offOn: string[] = [];
    const missingOn: string[] = [];
    for (const deviceId of deviceIds) {
      switch (acc.perDevice.get(deviceId) ?? "absent") {
        case "active": activeOn.push(deviceId); break;
        case "broken": brokenOn.push(deviceId); break;
        case "off": offOn.push(deviceId); break;
        default: missingOn.push(deviceId); break;
      }
    }
    drift.push({
      key,
      kind: acc.kind,
      name: acc.name,
      slug: acc.slug,
      description: acc.description,
      activeOn,
      brokenOn,
      offOn,
      missingOn,
      clients: Array.from(acc.clients).sort(),
      // A broken install is drift on its own — that is the machine whose settings
      // file says yes and whose disk says no. Otherwise drift is uneven adoption:
      // working somewhere, not working somewhere else.
      drifting: brokenOn.length > 0 || (activeOn.length > 0 && activeOn.length < deviceIds.length),
    });
  }

  return {
    deviceIds,
    devices,
    drift,
    driftCount: drift.reduce((n, row) => n + (row.drifting ? 1 : 0), 0),
  };
}

// Single-slot memo on the collection ref. The collection's identity changes only
// when some row changed (the sync layer reuses row and table refs otherwise), so
// every unrelated store mutation — a keystroke, another collection's push —
// returns the same index object, and a component holding it re-renders nothing.
let _indexRef: unknown;
let _index: CapabilityIndex = EMPTY_INDEX;

/** The one pass every derived capability view reads from. */
export function selectCapabilityIndex(
  state: Pick<CapabilitySliceData, "capabilityState">,
): CapabilityIndex {
  const collection = state?.capabilityState;
  if (!collection) return EMPTY_INDEX;
  if (collection === _indexRef) return _index;
  _index = buildCapabilityIndex(collection);
  _indexRef = collection;
  return _index;
}

/** One machine's summary, or undefined when it has never reported. */
export function selectDeviceCapabilityRollup(
  state: Pick<CapabilitySliceData, "capabilityState">,
  deviceId: string,
): DeviceCapabilityRollup | undefined {
  if (!deviceId) return undefined;
  return selectCapabilityIndex(state).devices[deviceId];
}

/** Every machine that has reported, ordered by device id so a list is stable. */
export function selectCapabilityRollups(
  state: Pick<CapabilitySliceData, "capabilityState">,
): DeviceCapabilityRollup[] {
  const index = selectCapabilityIndex(state);
  return index.deviceIds.map((id) => index.devices[id]);
}

/** Every capability the fleet knows about, sorted by key. */
export function selectCapabilityDrift(
  state: Pick<CapabilitySliceData, "capabilityState">,
): CapabilityDriftRow[] {
  return selectCapabilityIndex(state).drift;
}

/** The badge number: how many capabilities are not in the same state everywhere.
 *  Pair the subscription with `capabilityStateWakeSig`, never with the raw
 *  collection — this is exactly the always-mounted chip the churn rule is about. */
export function selectCapabilityDriftCount(
  state: Pick<CapabilitySliceData, "capabilityState">,
): number {
  return selectCapabilityIndex(state).driftCount;
}

/** One machine's rows, newest report first. */
export function selectDeviceCapabilityRows(
  state: Pick<CapabilitySliceData, "capabilityState">,
  deviceId: string,
): CapabilityStateRow[] {
  const out: CapabilityStateRow[] = [];
  const collection = state?.capabilityState;
  if (!collection || !deviceId) return out;
  for (const id in collection) {
    const row = collection[id];
    if (row?.device_id === deviceId) out.push(row);
  }
  return out.sort(
    (a, b) =>
      (b.reported_at ?? 0) - (a.reported_at ?? 0) ||
      (a.client < b.client ? -1 : a.client > b.client ? 1 : 0) ||
      (a.scope_key < b.scope_key ? -1 : a.scope_key > b.scope_key ? 1 : 0),
  );
}

/** A cached catalog page, in delivery order. Empty when the cache answers a
 *  different query — a stale filter's rows are not this query's answer. */
export function selectCachedCatalog(
  state: Pick<CapabilitySliceData, "capabilityCatalog">,
  query: string,
): CapabilityCatalogEntry[] {
  const cache = state?.capabilityCatalog;
  if (!cache || cache.query !== query) return [];
  const out: CapabilityCatalogEntry[] = [];
  for (const slug of cache.recent) {
    const entry = cache.entries[slug];
    if (entry) out.push(entry);
  }
  return out;
}

/** Test hook: the selector memo is module state, so a suite that rebuilds the
 *  same collection shape has to clear it. Mirrors `_resetChatRailMemo`. */
export function _resetCapabilityMemo(): void {
  _indexRef = undefined;
  _index = EMPTY_INDEX;
}
