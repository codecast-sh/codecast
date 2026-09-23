// One boot of the web cache per process, driven by SCENARIO: seeds the disk
// the way a previous run left it and a token the way the browser holds it,
// then boots hydration through the real loadCache and reports what a window
// would see. Module singletons (the Dexie instance, the ownership memo, the
// principal tracker) are why each scenario is its own process.
import { expect } from "bun:test";
import "fake-indexeddb/auto";

const { AUTH_JWT_STORAGE_KEY, issueFakeToken: issue, mapStorage } = await import("./fakeAuthToken");
const local = mapStorage();
(globalThis as any).localStorage = local;

const { default: Dexie } = await import("dexie");
const { COLLECTION_INDEXES } = await import("../../clientSyncRegistry");

const scenario = process.env.SCENARIO!;
// The token the browser holds when the cache module boots: in localStorage
// for every scenario but the two that leave it empty.
if (!["signed-out-residue", "durable-only-token"].includes(scenario)) local.setItem(AUTH_JWT_STORAGE_KEY, issue("userA"));
// Booting the cache module also boots the principal tracker, which reads the
// token above the way a real window does at module load. The database opens
// lazily, so the seed below still lands first.
const cache = await import("../../idbCache");
const { CACHE_SCHEMA_VERSION, loadCache, loadOutbox, _cacheOwnerForTests, enqueueDispatch, writePatchesToIDB } = cache;
const ROW = { _id: "a".repeat(32), session_id: "sess", updated_at: Date.now(), title: "cached row" };

// Seed the disk BEFORE the cache module boots, with the schema it expects.
async function seed(opts: { owner?: string | null; rows?: boolean; outbox?: boolean }) {
  const db = new Dexie("codecast-store");
  db.version(CACHE_SCHEMA_VERSION).stores({ ...COLLECTION_INDEXES, meta: "key", conversationMessages: "convId, latestTimestamp", conversationUserMessages: "convId", dispatchOutbox: "id" });
  await db.open();
  if (opts.owner !== undefined) await db.table("meta").put({ key: "currentUser", value: opts.owner ? { _id: opts.owner, email: "x@y" } : null });
  if (opts.rows) {
    await db.table("sessions").put(ROW);
    await db.table("meta").put({ key: "clientState", value: { ui: { theme: "dark" } } });
  }
  if (opts.outbox) await db.table("dispatchOutbox").put({ id: "o1", action: "x", args: [], patches: [], result: null, ts: 1 });
  db.close();
}
async function seedDurableToken(principalId: string) {
  const req = indexedDB.open("codecast-auth", 1);
  await new Promise<void>((resolve, reject) => {
    req.onupgradeneeded = () => req.result.createObjectStore("tokens");
    req.onsuccess = () => {
      const tx = req.result.transaction("tokens", "readwrite");
      tx.objectStore("tokens").put(issue(principalId), AUTH_JWT_STORAGE_KEY);
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}
async function diskRows() {
  const db = new Dexie("codecast-store");
  // A purged cache is a deleted database, which is the strongest "zero rows".
  if (!(await Dexie.exists("codecast-store"))) return { sessions: 0, meta: 0, outbox: 0 };
  await db.open();
  const has = (name: string) => db.tables.some((t) => t.name === name);
  const out = {
    sessions: has("sessions") ? await db.table("sessions").count() : 0,
    meta: has("meta") ? await db.table("meta").count() : 0,
    outbox: has("dispatchOutbox") ? await db.table("dispatchOutbox").count() : 0,
  };
  db.close();
  return out;
}

if (scenario === "fresh") {
  // nothing on disk
} else if (scenario === "known-owner") {
  await seed({ owner: "userA", rows: true, outbox: true });
} else if (scenario === "legacy-unknown-owner") {
  await seed({ rows: true, outbox: true });
} else if (scenario === "foreign-owner") {
  await seed({ owner: "userB", rows: true, outbox: true });
} else if (scenario === "signed-out-residue") {
  await seed({ owner: "userA", rows: true, outbox: true });
} else if (scenario === "durable-only-token") {
  await seed({ owner: "userA", rows: true });
  await seedDurableToken("userA");
} else if (scenario === "write-guard-race") {
  await seed({ owner: "userA", rows: true });
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

const hydrated = await loadCache(["sessions", "clientState", "currentUser"]);
const owner = _cacheOwnerForTests();
const outbox = await loadOutbox();

switch (scenario) {
  case "fresh":
    expect(hydrated).toBeNull();
    expect(owner).toBe("userA");
    expect(await diskRows()).toEqual({ sessions: 0, meta: 0, outbox: 0 });
    // Writes for the signed-in account land.
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: { [ROW._id]: ROW } }] as any, { sessions: { [ROW._id]: ROW }, pending: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect((await diskRows()).sessions).toBe(1);
    break;
  case "known-owner":
    // The offline boot: the cache renders, and the parked write survives.
    expect(hydrated?.sessions?.[ROW._id]?.title).toBe("cached row");
    expect(hydrated?.clientState?.ui?.theme).toBe("dark");
    expect(owner).toBe("userA");
    expect(outbox.map((o) => o.id)).toEqual(["o1"]);
    expect((await diskRows()).sessions).toBe(1);
    break;
  case "legacy-unknown-owner":
  case "foreign-owner":
    expect(hydrated).toBeNull();
    expect(owner).toBe("userA");
    expect(outbox).toEqual([]);
    expect(await diskRows()).toEqual({ sessions: 0, meta: 0, outbox: 0 });
    break;
  case "signed-out-residue":
    expect(hydrated).toBeNull();
    expect(owner).toBeNull();
    expect(outbox).toEqual([]);
    expect(await diskRows()).toEqual({ sessions: 0, meta: 0, outbox: 0 });
    // Nobody is signed in: nothing may be written either.
    await enqueueDispatch({ id: "o2", action: "x", args: [], patches: [], result: null, ts: 2 });
    expect((await diskRows()).outbox).toBe(0);
    break;
  case "durable-only-token":
    // localStorage was wiped; the durable tier still names the owner.
    expect(hydrated?.sessions?.[ROW._id]?.title).toBe("cached row");
    expect(owner).toBe("userA");
    break;
  case "write-guard-race": {
    expect(hydrated?.sessions?.[ROW._id]?.title).toBe("cached row");
    // A sibling signed in as someone else; this window's storage event has not
    // arrived yet. The stored JWT already names userB, so writes must refuse.
    local.setItem(AUTH_JWT_STORAGE_KEY, issue("userB"));
    await enqueueDispatch({ id: "o2", action: "x", args: [], patches: [], result: null, ts: 2 });
    const next = { [ROW._id]: { ...ROW, title: "changed" } };
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: next }] as any, { sessions: next, pending: {} });
    await new Promise((r) => setTimeout(r, 20));
    const db = new Dexie("codecast-store");
    await db.open();
    expect((await db.table("sessions").get(ROW._id))?.title).toBe("cached row");
    expect(await db.table("dispatchOutbox").count()).toBe(0);
    db.close();
    // And once the token names the owner again, writes resume.
    local.setItem(AUTH_JWT_STORAGE_KEY, issue("userA"));
    await enqueueDispatch({ id: "o3", action: "x", args: [], patches: [], result: null, ts: 3 });
    expect((await loadOutbox()).map((o) => o.id)).toEqual(["o3"]);
    break;
  }
}
console.log(`${scenario} verified`);
