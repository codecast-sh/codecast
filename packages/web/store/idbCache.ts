import Dexie from "dexie";
import type { Patch } from "mutative";

class CacheDB extends Dexie {
  sessions!: Dexie.Table<any, string>;
  dismissedSessions!: Dexie.Table<any, string>;
  tasks!: Dexie.Table<any, string>;
  docs!: Dexie.Table<any, string>;
  plans!: Dexie.Table<any, string>;
  meta!: Dexie.Table<{ key: string; value: any }, string>;

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
  }
}

const db = new CacheDB();

const COLLECTION_TABLES: Record<string, Dexie.Table<any, string>> = {
  sessions: db.sessions,
  dismissedSessions: db.dismissedSessions,
  tasks: db.tasks,
  docs: db.docs,
  plans: db.plans,
};

const META_KEYS = new Set([
  "clientState",
  "messages",
  "pagination",
  "conversations",
  "drafts",
  "recentProjects",
  "collapsedSections",
  "sidebarNavExpanded",
  "teams",
  "teamMembers",
  "teamUnreadCount",
  "favorites",
  "bookmarks",
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
      const fullReplace = patches.some(
        (p) => String((p.path as any[])[0]) === key && p.path.length === 1,
      );
      if (fullReplace) {
        const data = state[key];
        if (data && typeof data === "object") {
          table
            .clear()
            .then(() => table.bulkPut(Object.values(data)))
            .catch(() => {});
        }
      } else {
        const puts: any[] = [];
        const deletes: string[] = [];
        for (const patch of patches) {
          const path = patch.path as (string | number)[];
          if (String(path[0]) !== key || path.length < 2) continue;
          const docId = String(path[1]);
          if (patch.op === "remove" && path.length === 2) {
            deletes.push(docId);
          } else {
            const doc = state[key]?.[docId];
            if (doc) puts.push(doc);
          }
        }
        if (puts.length > 0) table.bulkPut(puts).catch(() => {});
        if (deletes.length > 0) table.bulkDelete(deletes).catch(() => {});
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

    for (const [key, table] of Object.entries(COLLECTION_TABLES)) {
      const rows = await table.toArray();
      if (rows.length > 0) {
        const map: Record<string, any> = {};
        for (const row of rows) map[row._id] = row;
        result[key] = map;
        hasData = true;
      }
    }

    const metaRows = await db.meta.toArray();
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

