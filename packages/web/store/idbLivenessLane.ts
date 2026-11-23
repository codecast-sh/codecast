import type Dexie from "dexie";
import { COLLECTION_LIVE_FIELDS, META_LIVE_FIELDS } from "./clientSyncRegistry";

// The liveness lane. A row whose change since it last reached disk touches
// only its collection's liveFields waits here, and so does syncMeta. With
// ~60 working agents, nine in ten session-row writes were liveness ticks;
// each rewrote the whole row, and the desktop app's browser process spent a
// core compacting the 700 MB IndexedDB they landed in (2026-11-21). One flush
// writes the waiting rows and syncMeta in one transaction, so the persisted
// sync cursors never pass a row change that is not on disk: a page killed
// before the flush replays the sync log from the older cursor and loses
// nothing. Rows with any other change still go to disk at once.
export const LIVENESS_FLUSH_MS = 60_000;
const livenessRows = new Map<string, Set<string>>();
let livenessSyncMeta = false;
let livenessState: any = null;
let livenessTimer: ReturnType<typeof setTimeout> | null = null;
// Meta keys with liveFields: what each last handed to disk, and which wait.
const lastPersistedMeta = new Map<string, any>();
const livenessMeta = new Set<string>();

// What the flush writes through: idbCache's database, tables and row shadow.
export type LivenessLaneDeps = {
  db: Dexie & { meta: Dexie.Table<{ key: string; value: any }, string> };
  tables: Record<string, Dexie.Table<any, string>>;
  lastPersisted: Map<string, Map<string, any>>;
  writable: () => boolean;
  flushMeta: () => void;
};
let lane: LivenessLaneDeps | null = null;

export function connectLivenessLane(deps: LivenessLaneDeps) {
  lane = deps;
}

function scheduleLivenessFlush(state: any) {
  livenessState = state;
  if (!livenessTimer) livenessTimer = setTimeout(flushLivenessWrites, LIVENESS_FLUSH_MS);
}

/** Content equality for synced values. A push hands back fresh nested objects
 *  even where nothing in them changed, so a reference compare is not enough. */
function sameValue(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(b, key) || !sameValue(a[key], b[key])) return false;
  return true;
}

/** Whether `next` differs from the row on disk only in `live` fields. */
function onlyLiveFieldsChanged(onDisk: any, next: any, live: ReadonlySet<string>): boolean {
  if (!onDisk || !next || onDisk === next) return false;
  for (const field in next) if (next[field] !== onDisk[field] && !live.has(field) && !sameValue(next[field], onDisk[field])) return false;
  for (const field in onDisk) if (!(field in next) && !live.has(field)) return false;
  return true;
}

// A meta key's live paths as a tree: `null` marks a live field, a nested
// tree the live fields inside it ("people.counts" → people → counts).
type LiveTree = Map<string, LiveTree | null>;
const META_LIVE: Record<string, { tree: LiveTree; rowKeyAt: (path: string) => string }> = Object.fromEntries(
  Object.entries(META_LIVE_FIELDS).map(([key, { fields, rowKey }]) => {
    const tree: LiveTree = new Map();
    for (const path of fields) {
      const parts = path.split(".");
      let node = tree;
      parts.forEach((part, i) => {
        if (i === parts.length - 1) { node.set(part, null); return; }
        let next = node.get(part);
        if (!next) node.set(part, (next = new Map()));
        node = next;
      });
    }
    const rowKeyAt = typeof rowKey === "string" ? () => rowKey : (path: string) => rowKey[path] ?? "_id";
    return [key, { tree, rowKeyAt }];
  })
);

/**
 * How a meta value moved from what is on disk: "same", "live" (only live
 * paths changed, list rows matched by their path's row key in any order), or
 * "durable". `path` is where this value sits ("people.sessions").
 */
function liveChange(onDisk: any, next: any, tree: LiveTree, rowKeyAt: (path: string) => string, path = ""): "same" | "live" | "durable" {
  if (onDisk === next) return "same";
  if (Array.isArray(onDisk) && Array.isArray(next)) {
    if (onDisk.length !== next.length) return "durable";
    const rowKey = rowKeyAt(path);
    const idOf = (row: any) => (row && typeof row === "object" ? row[rowKey] ?? row._id : undefined);
    const byId = new Map<unknown, any>();
    for (const row of onDisk) {
      const id = idOf(row);
      if (id === undefined || byId.has(id)) return "durable";
      byId.set(id, row);
    }
    let moved: "same" | "live" = "same";
    for (let i = 0; i < next.length; i++) {
      const id = idOf(next[i]);
      if (id === undefined || !byId.has(id)) return "durable";
      const row = liveChange(byId.get(id), next[i], tree, rowKeyAt, path);
      if (row === "durable") return "durable";
      if (row === "live" || onDisk[i] !== next[i]) moved = "live";
    }
    return moved;
  }
  if (!onDisk || !next || typeof onDisk !== "object" || typeof next !== "object" || Array.isArray(onDisk) || Array.isArray(next)) {
    return "durable";
  }
  let moved: "same" | "live" = "same";
  for (const field of new Set([...Object.keys(onDisk), ...Object.keys(next)])) {
    if (onDisk[field] === next[field]) continue;
    if (!tree.has(field)) {
      if (sameValue(onDisk[field], next[field])) continue;
      return "durable";
    }
    const inner = tree.get(field);
    if (inner) {
      const sub = liveChange(onDisk[field], next[field], inner, rowKeyAt, path ? `${path}.${field}` : field);
      if (sub === "durable") return "durable";
      if (sub === "same") continue;
    }
    moved = "live";
  }
  return moved;
}

/** Write what waits in the liveness lane now (page hide, and tests). */
export function flushLivenessWrites() {
  if (livenessTimer) clearTimeout(livenessTimer);
  livenessTimer = null;
  const state = livenessState;
  livenessState = null;
  const writeSyncMeta = livenessSyncMeta && state?.syncMeta !== undefined;
  livenessSyncMeta = false;
  const waiting = [...livenessRows];
  livenessRows.clear();
  const waitingMeta = [...livenessMeta];
  livenessMeta.clear();
  if (!state || !lane || !lane.writable()) return;
  // A durable meta write still in its quiet spell goes first, so it can never land over a newer liveness value.
  lane.flushMeta();
  const metaPuts: Array<{ key: string; value: any }> = [];
  for (const key of waitingMeta) {
    const value = state[key];
    if (value === undefined || lastPersistedMeta.get(key) === value) continue;
    metaPuts.push({ key, value });
    lastPersistedMeta.set(key, value);
  }
  const writes: Array<{ table: Dexie.Table<any, string>; puts: any[] }> = [];
  for (const [key, ids] of waiting) {
    const table = lane.tables[key];
    const shadow = lane.lastPersisted.get(key);
    const data = state[key];
    if (!table || !shadow || !data) continue;
    const puts: any[] = [];
    for (const id of ids) {
      const row = Object.prototype.hasOwnProperty.call(data, id) ? data[id] : undefined;
      // Gone since (its delete was written), or already written by a later change.
      if (row === undefined || shadow.get(id) === row) continue;
      puts.push(row);
      shadow.set(id, row);
    }
    if (puts.length) writes.push({ table, puts });
  }
  if (!writes.length && !metaPuts.length && !writeSyncMeta) return;
  const { db } = lane;
  db.transaction("rw", [...writes.map((w) => w.table), db.meta], async () => {
    for (const { table, puts } of writes) await table.bulkPut(puts);
    for (const row of metaPuts) await db.meta.put(row);
    if (writeSyncMeta) await db.meta.put({ key: "syncMeta", value: state.syncMeta });
  }).catch(() => {});
}


/**
 * Splits a collection write's patched `ids`: a row whose change touches only
 * liveFields waits in the lane, and the rest are returned to be written now.
 */
export function holdLivenessRows(key: string, prevShadow: Map<string, any> | undefined, ids: Set<string> | null, data: any, state: any): Set<string> | null {
  const live = COLLECTION_LIVE_FIELDS[key];
  if (prevShadow && ids && live) {
    const now = new Set<string>();
    for (const id of ids) {
      if (onlyLiveFieldsChanged(prevShadow.get(id), data[id], live)) {
        let waiting = livenessRows.get(key);
        if (!waiting) livenessRows.set(key, (waiting = new Set()));
        waiting.add(id);
        scheduleLivenessFlush(state);
      } else {
        now.add(id);
      }
    }
    ids = now;
  }
  // This write puts the row's current value on disk, so a held (older) copy must never land over it.
  const held = livenessRows.get(key);
  if (held) {
    if (ids) for (const id of ids) held.delete(id);
    else held.clear();
  }
  return ids;
}

/** The sync cursors trail the liveness lane's rows to disk (see flushLivenessWrites). */
export function holdLivenessSyncMeta(state: any) {
  livenessSyncMeta = true;
  scheduleLivenessFlush(state);
}

/** Whether a meta key's change waits in the lane; false hands it to the durable writer now. */
export function holdLiveMeta(key: string, state: any): boolean {
  const live = META_LIVE[key];
  if (!live) return false;
  // A change in liveness fields only waits for the liveness flush; any other change takes this value now.
  if (lastPersistedMeta.has(key) && liveChange(lastPersistedMeta.get(key), state[key], live.tree, live.rowKeyAt) === "live") {
    livenessMeta.add(key);
    scheduleLivenessFlush(state);
    return true;
  }
  lastPersistedMeta.set(key, state[key]);
  livenessMeta.delete(key);
  return false;
}

/** Drop everything the lane holds: it belongs to the cache being purged. */
export function resetLivenessLane() {
  livenessRows.clear();
  livenessSyncMeta = false;
  livenessState = null;
  livenessMeta.clear();
  lastPersistedMeta.clear();
}
