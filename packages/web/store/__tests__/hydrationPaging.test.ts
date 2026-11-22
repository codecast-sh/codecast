import "fake-indexeddb/auto";
import { stampCacheOwner } from "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "bun:test";
import Dexie from "dexie";

// ct-98162: hydration reads each table a page at a time, with a task between
// pages, so a large cache never blocks the page for long. Spreading the read
// over many tasks must lose nothing: the paged load holds exactly what one
// read of the whole table gave, a write made while it runs is kept, and a
// clear or purge in the middle lands nothing.
//
// The store's persistence boots at module eval only when `window` exists, so
// the window stand-in goes up before the store is imported (dynamically).
(globalThis as any).window ??= { location: { pathname: "/inbox", search: "", hash: "", href: "http://localhost/inbox" }, addEventListener() {}, removeEventListener() {} };
const { _reopenForTests, loadCache, purgeLocalCache } = await import("../idbCache");
const { partitionSessionRetention } = await import("../cacheRetention");
const { collectionRowHydrator, collectionRowValidator } = await import("../clientSyncRegistry");
await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();

const NOW = Date.now();
const id = (p: string, n: number) => `${p}${String(n).padStart(32 - p.length, "0")}`;
const db = () => Dexie.connections.find((d) => d.name === "codecast-store") as any;
// Sizes off the 1,000-row page: a partial last page, and an exact multiple.
const SESSIONS = 2_500, TASKS = 3_000, DOCS = 1_234;

async function seed() {
  const sessions = Array.from({ length: SESSIONS }, (_, i) => ({ _id: id("k", i), title: `Session ${i}`, updated_at: NOW - i * 3_600_000, message_count: i, project_path: "/code/x", status: "idle" }));
  await db().table("sessions").bulkPut(sessions);
  await db().table("tasks").bulkPut(Array.from({ length: TASKS }, (_, i) => ({ _id: id("t", i), title: `Task ${i}`, short_id: `ct-${i}`, status: "open", updated_at: NOW - i * 1000, comments: [{ body: "heavy" }] })));
  await db().table("docs").bulkPut(Array.from({ length: DOCS }, (_, i) => ({ _id: id("d", i), title: `Doc ${i}`, updated_at: NOW - i * 1000, content: `body ${i}` })));
  await db().table("meta").bulkPut([{ key: "liveInboxIdList", value: sessions.slice(0, 600).map((s) => s._id) }]);
}

// The load as it was before paging: one read of the whole table, retention
// over every row, then the registry's validator and hydrator per row.
async function unpagedLoad(key: string): Promise<Record<string, any>> {
  let rows = await db().table(key).toArray();
  if (key === "sessions") {
    const live = (await db().table("meta").get("liveInboxIdList"))?.value;
    rows = partitionSessionRetention(rows, live, undefined, Date.now()).keep;
  }
  const valid = collectionRowValidator(key);
  const hydrate = collectionRowHydrator(key);
  const out: Record<string, any> = {};
  for (const row of rows) {
    if (valid && !valid(row)) continue;
    out[row._id] = hydrate ? hydrate(row, { pending: {} }) : row;
  }
  return out;
}

const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
};

describe("paged cache hydration loses nothing (ct-98162)", () => {
  it("holds exactly the rows one whole-table read gives", async () => {
    await seed();
    const paged = await loadCache(["sessions", "tasks", "docs"]);
    for (const key of ["sessions", "tasks", "docs"]) {
      const expected = await unpagedLoad(key);
      expect(Object.keys(expected).length).toBeGreaterThan(0);
      expect(paged?.[key]).toEqual(expected);
    }
    expect(Object.keys(paged!.tasks)).toHaveLength(TASKS);
    expect(Object.keys(paged!.docs)).toHaveLength(DOCS);
  });

  it("keeps a write made while hydration is still reading", async () => {
    const { useInboxStore } = await import("../inboxStore");
    const tasks = () => Object.keys((useInboxStore.getState() as any).tasks ?? {}).length;
    // The "Loading" status in the report is DashboardLayout's AppLoader, held
    // while clientStateInitialized is false. Over a populated cache it lifts
    // as soon as the inbox's own rows are in, while the deferred tables are
    // still being read.
    await until(() => useInboxStore.getState().clientStateInitialized, "the boot loader to lift");
    expect(Object.keys(useInboxStore.getState().sessions).length).toBeGreaterThan(0);
    expect(tasks()).toBe(0);
    const target = id("t", TASKS - 1);
    const live = { _id: target, title: "Written while hydrating", short_id: `ct-${TASKS - 1}`, status: "done", updated_at: NOW + 1 };
    useInboxStore.getState().syncTable("tasks", [live] as any, { isDelta: true } as any);
    await until(() => tasks() >= TASKS, "the tasks to hydrate");
    const row = (useInboxStore.getState() as any).tasks[target];
    expect(row.title).toBe("Written while hydrating");
    expect(row.status).toBe("done");
    expect(tasks()).toBe(TASKS);
  });

  it("lands nothing when the store is cleared while hydration is reading", async () => {
    const { useInboxStore, clearProtectedInboxMemory, rebootPersistence } = await import("../inboxStore");
    clearProtectedInboxMemory();
    rebootPersistence();
    await until(() => Object.keys(useInboxStore.getState().sessions).length > 0, "the critical rows");
    clearProtectedInboxMemory();
    await new Promise((r) => setTimeout(r, 300));
    const s = useInboxStore.getState() as any;
    expect(Object.keys(s.sessions)).toHaveLength(0);
    expect(Object.keys(s.tasks ?? {})).toHaveLength(0);
    expect(Object.keys(s.docs ?? {})).toHaveLength(0);
  });

  // A purge deletes the database under the read: the pages still to come
  // fail, so nothing of the purged account's is returned to hydrate.
  it("returns nothing from a read a purge started under", async () => {
    const read = loadCache(["tasks", "docs"]);
    // The first page of each table is in, the rest are not.
    await new Promise((r) => setTimeout(r, 0));
    const purged = purgeLocalCache({ reason: "test" });
    const result = await read;
    await purged;
    expect(result).toBeNull();
  });

  it("lifts the boot loader over a genuinely empty cache too", async () => {
    const { useInboxStore, clearProtectedInboxMemory, rebootPersistence } = await import("../inboxStore");
    clearProtectedInboxMemory();
    expect(useInboxStore.getState().clientStateInitialized).toBe(false);
    rebootPersistence();
    await until(() => useInboxStore.getState().clientStateInitialized, "the boot loader to lift");
    expect(Object.keys(useInboxStore.getState().sessions)).toHaveLength(0);
  });
});
