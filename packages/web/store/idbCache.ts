import Dexie from "dexie";
import type { Patch } from "mutative";

export type OutboxEntry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
};

class CacheDB extends Dexie {
  sessions!: Dexie.Table<any, string>;
  tasks!: Dexie.Table<any, string>;
  docs!: Dexie.Table<any, string>;
  plans!: Dexie.Table<any, string>;
  projects!: Dexie.Table<any, string>;
  meta!: Dexie.Table<{ key: string; value: any }, string>;
  conversationMessages!: Dexie.Table<{ convId: string; messages: any[]; latestTimestamp: number; pagination: any }, string>;
  dispatchOutbox!: Dexie.Table<OutboxEntry, string>;

  constructor() {
    super("codecast-store");
    this.version(1).stores({
      sessions: "_id",
      dismissedSessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      meta: "key",
    });
    this.version(2).stores({
      sessions: "_id",
      dismissedSessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      meta: "key",
      conversationMessages: "convId",
    });
    this.version(3).stores({
      sessions: "_id",
      dismissedSessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      meta: "key",
      conversationMessages: "convId",
    });
    this.version(4).stores({
      sessions: "_id",
      dismissedSessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      meta: "key",
      conversationMessages: "convId",
      dispatchOutbox: "id, ts",
    });
    // v5: dismissedSessions table dropped — dismissal is now a field on sessions.
    this.version(5).stores({
      sessions: "_id",
      dismissedSessions: null,
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      meta: "key",
      conversationMessages: "convId",
      dispatchOutbox: "id, ts",
    });
  }
}

const db = new CacheDB();

const COLLECTION_TABLES: Record<string, Dexie.Table<any, string>> = {
  sessions: db.sessions,
  tasks: db.tasks,
  docs: db.docs,
  plans: db.plans,
  projects: db.projects,
};

const META_KEYS = new Set([
  "clientState",
  // "messages" and "pagination" are now per-conversation in the conversationMessages table
  "conversations",
  "drafts",
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

let _hydrating = false;

export function writePatchesToIDB(patches: Patch[], state: any) {
  if (_hydrating) return;

  const affectedKeys = new Set<string>();
  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length > 0) affectedKeys.add(String(path[0]));
  }

  for (const key of affectedKeys) {
    const table = COLLECTION_TABLES[key];
    if (table) {
      const data = state[key];
      if (data && typeof data === "object") {
        table
          .clear()
          .then(() => table.bulkPut(Object.values(data)))
          .catch(() => {});
      }
    } else if (META_KEYS.has(key)) {
      db.meta.put({ key, value: state[key] }).catch(() => {});
    }
  }
}

export async function loadCache(): Promise<Record<string, any> | null> {
  try {
    const result: Record<string, any> = {};
    let hasData = false;

    const collectionEntries = Object.entries(COLLECTION_TABLES);
    const [collectionResults, metaRows] = await Promise.all([
      Promise.all(collectionEntries.map(([, table]) => table.toArray())),
      db.meta.toArray(),
    ]);

    collectionEntries.forEach(([key], i) => {
      const rows = collectionResults[i];
      if (rows.length > 0) {
        const map: Record<string, any> = {};
        for (const row of rows) map[row._id] = row;
        result[key] = map;
        hasData = true;
      }
    });

    for (const row of metaRows) {
      result[row.key] = row.value;
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
    const row = await db.conversationMessages.get(convId);
    if (!row) return null;
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
  db.conversationMessages.put({ convId, messages, pagination, latestTimestamp }).catch(() => {});
}

// -- Dispatch outbox: persist server-bound mutations until acknowledged --

export function enqueueDispatch(entry: OutboxEntry) {
  db.dispatchOutbox.put(entry).catch(() => {});
}

export function removeDispatch(id: string) {
  db.dispatchOutbox.delete(id).catch(() => {});
}

export async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    return await db.dispatchOutbox.orderBy("ts").toArray();
  } catch {
    return [];
  }
}

