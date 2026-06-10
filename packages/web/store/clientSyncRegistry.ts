export type PersistenceKind = "collection" | "meta";
export type DispatchTableKind = "collection" | "singleton";

export type ClientSyncRegistryEntry = {
  persistence?: {
    kind: PersistenceKind;
    key: string;
  };
  localFirst?: boolean;
  dispatchTable?: {
    table: string;
    kind: DispatchTableKind;
  };
  dispatchFieldTable?: string;
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
    localFirst: true,
  },
  docs: {
    persistence: { kind: "collection", key: "docs" },
    localFirst: true,
  },
  plans: {
    persistence: { kind: "collection", key: "plans" },
    localFirst: true,
  },
  projects: {
    persistence: { kind: "collection", key: "projects" },
    localFirst: true,
  },
  notifications: {
    localFirst: true,
  },
  clientState: {
    persistence: { kind: "meta", key: "clientState" },
    dispatchTable: { table: "client_state", kind: "singleton" },
  },
  _lastViewedAt: {
    persistence: { kind: "meta", key: "_lastViewedAt" },
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
  recentProjects: {
    persistence: { kind: "meta", key: "recentProjects" },
  },
  collapsedSections: {
    persistence: { kind: "meta", key: "collapsedSections" },
  },
  sidebarNavExpanded: {
    persistence: { kind: "meta", key: "sidebarNavExpanded" },
  },
  teams: {
    persistence: { kind: "meta", key: "teams" },
  },
  teamMembers: {
    persistence: { kind: "meta", key: "teamMembers" },
  },
  teamUnreadCount: {
    persistence: { kind: "meta", key: "teamUnreadCount" },
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
  },
  favorites: {
    persistence: { kind: "meta", key: "favorites" },
  },
  bookmarks: {
    persistence: { kind: "meta", key: "bookmarks" },
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
