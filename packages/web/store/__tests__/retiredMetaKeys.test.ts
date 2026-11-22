import "fake-indexeddb/auto";
import { stampCacheOwner } from "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, test } from "bun:test";
import Dexie from "dexie";
import { _reopenForTests, loadCache, RETIRED_META_KEYS, setHydrating } from "../idbCache";
import { META_STORE_KEYS } from "../clientSyncRegistry";

await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();
setHydrating(false);

const db = () => Dexie.connections.find((d) => d.name === "codecast-store") as any;

// A meta key the registry dropped was read by nothing and deleted by nothing:
// the desktop app still held a 12 MB `messages` blob months after it retired.
test("a boot drops the meta keys the registry retired and keeps the rest", async () => {
  await db().meta.bulkPut([
    { key: "messages", value: { c1: [{ _id: "m1" }] } },
    { key: "teamUnreadCount", value: 3 },
    { key: "drafts", value: { c1: "half a thought" } },
  ]);
  await loadCache(["drafts"]);
  await Bun.sleep(50);
  expect(await db().meta.get("messages")).toBeUndefined();
  expect(await db().meta.get("teamUnreadCount")).toBeUndefined();
  expect((await db().meta.get("drafts"))?.value).toEqual({ c1: "half a thought" });
});

test("no retired key is a live registry key", () => {
  const live = new Set<string>(META_STORE_KEYS);
  expect(RETIRED_META_KEYS.filter((key) => live.has(key))).toEqual([]);
});
