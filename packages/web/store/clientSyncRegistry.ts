export type PersistenceKind = "collection" | "meta";
export type DispatchTableKind = "collection" | "singleton";
export type HydrationPhase = "critical" | "deferred";
export type HydrationMerge = "shape" | "fill";

export type ClientSyncRegistryEntry = {
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
  //   "manual" — the hydration block consumes the cached value with bespoke
  //     logic (excluded from the derived apply lists).
  hydration?: { phase?: HydrationPhase; merge?: HydrationMerge } | "manual";
  localFirst?: boolean;
  dispatchTable?: {
    table: string;
    kind: DispatchTableKind;
  };
  dispatchFieldTable?: string;
  // Per-row validity for a persisted collection. Rows failing this are dropped
  // (and removed from disk) at cache hydration and refused by detail-record
  // writes. Guards against foreign documents persisted under the wrong
  // collection — e.g. a conversation once stored as a task by a table-blind
  // webGetTaskDetail lingers in the never-pruned cache forever as a phantom
  // task that 404s when opened.
  validRow?: (row: any) => boolean;
};

export const CLIENT_SYNC_REGISTRY = {
  sessions: {
    persistence: { kind: "collection", key: "sessions" },
    localFirst: true,
  },
  conversations: {
    persistence: { kind: "meta", key: "conversations" },
    localFirst: true,
    dispatchTable: { table: "conversations", kind: "collection" },
  },
  tasks: {
    persistence: { kind: "collection", key: "tasks" },
    hydration: { phase: "deferred" },
    localFirst: true,
    // Real tasks always carry a ct- short_id (required by schema, asserted by
    // webGetTaskDetail's lookup guard). Conversations masquerading as tasks
    // carry a session short id (jx…) or none.
    validRow: (row: any) => typeof row?.short_id === "string" && row.short_id.startsWith("ct-"),
  },
  docs: {
    persistence: { kind: "collection", key: "docs" },
    hydration: { phase: "deferred" },
    localFirst: true,
  },
  plans: {
    persistence: { kind: "collection", key: "plans" },
    hydration: { phase: "deferred" },
    localFirst: true,
  },
  projects: {
    persistence: { kind: "collection", key: "projects" },
    hydration: { phase: "deferred" },
    localFirst: true,
  },
  buckets: {
    persistence: { kind: "collection", key: "buckets" },
    localFirst: true,
    // Field edits (rename / archive / color / sort) dispatch as generic patches.
    dispatchTable: { table: "inbox_buckets", kind: "collection" },
  },
  // Server writes flow through the assignSessionToBucket side effect (upsert by
  // user+conversation), not patches — so no dispatchTable here. localFirst keeps
  // optimistic assignments protected until the server row syncs back.
  bucketAssignments: {
    persistence: { kind: "collection", key: "bucketAssignments" },
    localFirst: true,
  },
  // Teammate comments. Creates/deletes/agent-asks flow through dispatch side
  // effects (comments.addComment / deleteComment / askAgentInThread); content
  // edits ride the generic patch path, so dispatchTable enables those.
  comments: {
    persistence: { kind: "collection", key: "comments" },
    hydration: { phase: "deferred" },
    localFirst: true,
    dispatchTable: { table: "comments", kind: "collection" },
  },
  notifications: {
    localFirst: true,
  },
  clientState: {
    persistence: { kind: "meta", key: "clientState" },
    dispatchTable: { table: "client_state", kind: "singleton" },
  },
  // This client's own last-focused conversation — the boot-restore source.
  // Local-only on purpose (no dispatchTable): the per-user synced pointer
  // (clientState.current_conversation_id) is writable by every client and kept
  // poisoning the desktop's restore; this key never leaves the device.
  // Hydrated manually: the restore block also reseeds currentSessionId from it.
  lastFocusedConversationId: {
    persistence: { kind: "meta", key: "lastFocusedConversationId" },
    hydration: "manual",
  },
  _lastViewedAt: {
    persistence: { kind: "meta", key: "_lastViewedAt" },
  },
  // Recently-visited rail (sessions, chip views, pages) — device-local on
  // purpose: what you opened on this machine is this machine's history.
  recentVisits: {
    persistence: { kind: "meta", key: "recentVisits" },
  },
  _seenUpToAt: {
    persistence: { kind: "meta", key: "_seenUpToAt" },
  },
  _seenMessageCount: {
    persistence: { kind: "meta", key: "_seenMessageCount" },
  },
  pendingMessages: {
    persistence: { kind: "meta", key: "pendingMessages" },
  },
  pending: {
    persistence: { kind: "meta", key: "pending" },
  },
  drafts: {
    persistence: { kind: "meta", key: "drafts" },
  },
  queuedMessages: {
    persistence: { kind: "meta", key: "queuedMessages" },
  },
  recentProjects: {
    persistence: { kind: "meta", key: "recentProjects" },
    hydration: { phase: "deferred" },
  },
  collapsedSections: {
    persistence: { kind: "meta", key: "collapsedSections" },
    hydration: { phase: "deferred" },
  },
  sidebarNavExpanded: {
    persistence: { kind: "meta", key: "sidebarNavExpanded" },
    hydration: { phase: "deferred" },
  },
  teams: {
    persistence: { kind: "meta", key: "teams" },
  },
  teamMembers: {
    persistence: { kind: "meta", key: "teamMembers" },
  },
  teamUnreadCount: {
    persistence: { kind: "meta", key: "teamUnreadCount" },
    // Live-synced; a stale cached count must not clobber a fresh one.
    hydration: { merge: "fill" },
  },
  feedConversations: {
    persistence: { kind: "meta", key: "feedConversations" },
  },
  feedHasMore: {
    persistence: { kind: "meta", key: "feedHasMore" },
  },
  feedCursors: {
    persistence: { kind: "meta", key: "feedCursors" },
  },
  syncMeta: {
    persistence: { kind: "meta", key: "syncMeta" },
  },
  docProjectPaths: {
    persistence: { kind: "meta", key: "docProjectPaths" },
    hydration: { phase: "deferred" },
  },
  favorites: {
    persistence: { kind: "meta", key: "favorites" },
    hydration: { phase: "deferred" },
  },
  bookmarks: {
    persistence: { kind: "meta", key: "bookmarks" },
    hydration: { phase: "deferred" },
  },
  tabs: {
    persistence: { kind: "meta", key: "tabs" },
    dispatchFieldTable: "client_state",
  },
  activeTabId: {
    persistence: { kind: "meta", key: "activeTabId" },
    dispatchFieldTable: "client_state",
  },
  sidePanelOpen: {
    persistence: { kind: "meta", key: "sidePanelOpen" },
  },
  sidePanelSessionId: {
    persistence: { kind: "meta", key: "sidePanelSessionId" },
  },
  sidePanelUserClosed: {
    persistence: { kind: "meta", key: "sidePanelUserClosed" },
  },
  // The signed-in user record. Persisted so the separate palette window — which
  // hydrates from IDB and runs no live query of its own — can read
  // currentUser.available_skills and show project/personal skills in the compose
  // popup's slash menu (otherwise it would have only built-in commands).
  currentUser: {
    persistence: { kind: "meta", key: "currentUser" },
    // Singleton record, not a collection: never union stale cached fields into
    // a freshly-synced user — only fill a still-empty slot (palette/cold start).
    hydration: { merge: "fill" },
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;

export type ClientSyncStoreKey = keyof typeof CLIENT_SYNC_REGISTRY;
export type ClientSyncCollectionStoreKey = {
  [K in ClientSyncStoreKey]: (typeof CLIENT_SYNC_REGISTRY)[K] extends { readonly persistence: { readonly kind: "collection" } } ? K : never
}[ClientSyncStoreKey];
export type ClientSyncMetaStoreKey = {
  [K in ClientSyncStoreKey]: (typeof CLIENT_SYNC_REGISTRY)[K] extends { readonly persistence: { readonly kind: "meta" } } ? K : never
}[ClientSyncStoreKey];

const registryEntries = Object.entries(CLIENT_SYNC_REGISTRY) as Array<
  [ClientSyncStoreKey, ClientSyncRegistryEntry]
>;

export const COLLECTION_STORE_KEYS = registryEntries
  .filter(([, entry]) => entry.persistence?.kind === "collection")
  .map(([key]) => key) as ClientSyncCollectionStoreKey[];

export const META_STORE_KEYS = registryEntries
  .filter(([, entry]) => entry.persistence?.kind === "meta")
  .map(([key]) => key) as ClientSyncMetaStoreKey[];

export const PROTECTED_COLLECTION_KEYS = registryEntries
  .filter(([, entry]) => entry.localFirst)
  .map(([key]) => key);

// Boot-hydration apply lists, derived so a persisted key can never silently
// skip hydration (the bug class of ct-34920 and the buckets label pop-in):
// every persisted key lands in exactly one of critical / deferred / manual.
const hydratedEntries = registryEntries.filter(
  ([, entry]) => entry.persistence && entry.hydration !== "manual"
);

export const HYDRATION_CRITICAL_KEYS = hydratedEntries
  .filter(([, entry]) => (entry.hydration as { phase?: HydrationPhase } | undefined)?.phase !== "deferred")
  .map(([key]) => key);

export const HYDRATION_DEFERRED_KEYS = hydratedEntries
  .filter(([, entry]) => (entry.hydration as { phase?: HydrationPhase } | undefined)?.phase === "deferred")
  .map(([key]) => key);

export function hydrationMergeStrategy(key: string): HydrationMerge {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  const hydration = entry?.hydration;
  if (hydration && hydration !== "manual" && hydration.merge) return hydration.merge;
  return "shape";
}

export const DISPATCH_TABLE_MAP: Record<string, { table: string; kind: DispatchTableKind }> = Object.fromEntries(
  registryEntries.flatMap(([key, entry]) =>
    entry.dispatchTable ? [[key, entry.dispatchTable]] : []
  )
);

export const DISPATCH_FIELD_TABLE_MAP: Record<string, { table: string }> = Object.fromEntries(
  registryEntries.flatMap(([key, entry]) =>
    entry.dispatchFieldTable ? [[key, { table: entry.dispatchFieldTable }]] : []
  )
);

export function isPersistedClientStoreKey(key: string): boolean {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  return !!entry?.persistence;
}

export function isProtectedSyncCollection(key: string): boolean {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  return !!entry?.localFirst;
}

export function collectionRowValidator(key: string): ((row: any) => boolean) | undefined {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  return entry?.validRow;
}
