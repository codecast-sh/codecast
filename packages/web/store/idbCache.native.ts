// expo-sqlite's kv-store default export is an AsyncStorage-compatible, SQLite-backed
// key-value store (getItem/setItem/removeItem + multiGet). It is durable and survives
// app restart — the RN replacement for the web Dexie engine. Metro resolves this
// .native file (and its mobile-only expo-sqlite dep) for the native bundle; the web
// bundler and tsconfig never touch it.
import Storage from "expo-sqlite/kv-store";
import type { Patch } from "mutative";

export type OutboxEntry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
};

// Mirrors COLLECTION_TABLES in idbCache.ts — collections keyed by _id.
const COLLECTION_TABLES = new Set(["sessions", "tasks", "docs", "plans", "projects"]);

// Mirrors META_KEYS in idbCache.ts — single-blob meta values.
const META_KEYS = new Set([
  "clientState",
  // "messages" and "pagination" are now per-conversation in the conversationMessages store
  "conversations",
  "drafts",
  // The user's outbound optimistic/queued/failed messages. Must persist so a
  // reload mid-send can never drop a user message — they only leave this map
  // once the server confirms them (pruned by client_id in setMessages).
  "pendingMessages",
  "pending",
  "recentProjects",
  "collapsedSections",
  "sidebarNavExpanded",
  "teams",
  "teamMembers",
  "teamUnreadCount",
  "favorites",
  "bookmarks",
  "tabs",
  "activeTabId",
  "sidePanelOpen",
  "sidePanelSessionId",
  "sidePanelUserClosed",
]);

// KV key prefixes namespace the flat store so reads can reconstruct the same
// shape Dexie's per-table layout produces.
const COLLECTION_PREFIX = "col:";
const META_PREFIX = "meta:";
const CONVMSG_PREFIX = "convmsg:";
const OUTBOX_KEY = "dispatchOutbox";

let _hydrating = false;

export const PERSISTENCE_AVAILABLE = true;

// A top-level store key is durable iff it maps to a dedicated collection or is
// whitelisted as a meta blob. Keys that satisfy neither are silently dropped on
// write — the class of bug that lost pending user messages.
export function isPersistedStoreKey(key: string): boolean {
  return COLLECTION_TABLES.has(key) || META_KEYS.has(key);
}

export function writePatchesToIDB(patches: Patch[], state: any) {
  if (_hydrating) return;

  const affectedKeys = new Set<string>();
  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length > 0) affectedKeys.add(String(path[0]));
  }

  for (const key of affectedKeys) {
    if (COLLECTION_TABLES.has(key)) {
      const data = state[key];
      if (data && typeof data === "object") {
        Storage.setItem(COLLECTION_PREFIX + key, JSON.stringify(Object.values(data))).catch(() => {});
      }
    } else if (META_KEYS.has(key)) {
      Storage.setItem(META_PREFIX + key, JSON.stringify(state[key])).catch(() => {});
    }
  }
}

export async function loadCache(): Promise<Record<string, any> | null> {
  try {
    const result: Record<string, any> = {};
    let hasData = false;

    const collectionKeys = [...COLLECTION_TABLES];
    const metaKeys = [...META_KEYS];
    const pairs = await Storage.multiGet([
      ...collectionKeys.map((k) => COLLECTION_PREFIX + k),
      ...metaKeys.map((k) => META_PREFIX + k),
    ]);
    const byKey = new Map(pairs);

    for (const key of collectionKeys) {
      const raw = byKey.get(COLLECTION_PREFIX + key);
      if (raw == null) continue;
      const rows = JSON.parse(raw) as any[];
      if (rows.length > 0) {
        const map: Record<string, any> = {};
        for (const row of rows) map[row._id] = row;
        result[key] = map;
        hasData = true;
      }
    }

    for (const key of metaKeys) {
      const raw = byKey.get(META_PREFIX + key);
      if (raw == null) continue;
      result[key] = JSON.parse(raw);
      hasData = true;
    }

    return hasData ? result : null;
  } catch {
    return null;
  }
}

export function setHydrating(v: boolean) {
  _hydrating = v;
}

// -- Per-conversation message cache --

export async function loadConversationMessages(convId: string): Promise<{ messages: any[]; pagination: any; latestTimestamp: number } | null> {
  try {
    const raw = await Storage.getItem(CONVMSG_PREFIX + convId);
    if (raw == null) return null;
    const row = JSON.parse(raw);
    return { messages: row.messages, pagination: row.pagination, latestTimestamp: row.latestTimestamp };
  } catch {
    return null;
  }
}

export function writeConversationMessages(convId: string, messages: any[], pagination: any) {
  if (_hydrating) return;
  const latestTimestamp = messages.length > 0
    ? Math.max(...messages.map((m: any) => m.timestamp || 0))
    : 0;
  Storage.setItem(CONVMSG_PREFIX + convId, JSON.stringify({ messages, pagination, latestTimestamp })).catch(() => {});
}

// -- Dispatch outbox: persist server-bound mutations until acknowledged --
// Stored as a single JSON array. Each mutation is a read-modify-write on that
// blob, so concurrent enqueue/remove calls must be serialized — otherwise two
// in-flight calls read the same stale array and the second clobbers the first.
// We chain every mutation onto a single tail promise to enforce ordering.

async function readOutbox(): Promise<OutboxEntry[]> {
  const raw = await Storage.getItem(OUTBOX_KEY);
  if (raw == null) return [];
  return JSON.parse(raw) as OutboxEntry[];
}

let _outboxQueue: Promise<unknown> = Promise.resolve();

function mutateOutbox(transform: (entries: OutboxEntry[]) => OutboxEntry[]) {
  _outboxQueue = _outboxQueue
    .then(() => readOutbox())
    .then((entries) => Storage.setItem(OUTBOX_KEY, JSON.stringify(transform(entries))))
    .catch(() => {});
}

export function enqueueDispatch(entry: OutboxEntry) {
  mutateOutbox((entries) => [...entries.filter((e) => e.id !== entry.id), entry]);
}

export function removeDispatch(id: string) {
  mutateOutbox((entries) => entries.filter((e) => e.id !== id));
}

export async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    // Drain queued writes first so the read reflects every prior enqueue/remove.
    await _outboxQueue;
    return (await readOutbox()).sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}
