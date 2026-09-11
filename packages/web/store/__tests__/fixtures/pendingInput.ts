import { expect } from "bun:test";
import { JSDOM } from "jsdom";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

const dom = new JSDOM("<!doctype html>", { url: "http://pending-input.test" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const cache = await import("../../idbCache");
const { useInboxStore, hydrateMergeValue } = await import("../../inboxStore");
const { readPendingMessageJournal } = await import("../../pendingMessageJournal");
const { followerPersistencePatches } = await import("../../followerPersistence");
for (let i = 0; i < 1000 && !useInboxStore.getState().clientStateInitialized; i++) await new Promise(resolve => setTimeout(resolve, 1));
expect(useInboxStore.getState().clientStateInitialized).toBe(true);
const state = () => useInboxStore.getState() as any;
const owner = { _id: "test-owner" };
useInboxStore.setState({ currentUser: owner } as any);
const resetWindow = () => {
  useInboxStore.setState({ currentUser: owner, pendingMessages: {}, messages: {}, sessions: {}, conversations: {} } as any);
  state()._setIDBWrite((patches: any[], value: any) => cache.writePatchesToIDB(followerPersistencePatches(patches), value));
};
const load = () => cache.loadCache(["pendingMessages"], { currentUser: owner });

resetWindow();
state().addOptimisticMessage("conversation", "first window\nexact input", undefined, "window-a");
expect(readPendingMessageJournal(localStorage).flatMap(batch => batch.writes).some(write => write.id === "window-a")).toBe(true);
const first = state().pendingMessages;
resetWindow();
state().addOptimisticMessage("conversation", "second window", [{ storage_id: "image-1" }], "window-b");
expect((await load())?.pendingMessages.conversation.map((m: any) => m._id)).toEqual(["window-a", "window-b"]);
expect(readPendingMessageJournal(localStorage)).toEqual([]);

const cached = (await load())?.pendingMessages;
const merged = hydrateMergeValue("pendingMessages", cached, state().pendingMessages).value as any;
expect(merged.conversation).toHaveLength(2);
useInboxStore.setState({ pendingMessages: merged } as any);
state().stampPendingDispatchContent("conversation", "window-b", "second window\nexpanded context");
expect((await load())?.pendingMessages.conversation[1]._dispatchContent).toBe("second window\nexpanded context");

state().setMessages("conversation", [{ _id: "server-a", client_id: "window-a", role: "user", content: "first window\nexact input", timestamp: Date.now() }]);
await cache.flushPendingMessageJournal();
useInboxStore.setState({ pendingMessages: first } as any);
state().markOptimisticAsQueued("conversation", "first window\nexact input");
expect((await load())?.pendingMessages.conversation.map((m: any) => m._id)).toEqual(["window-b"]);

resetWindow();
const originalPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
  if (this.name === "meta" && args[0]?.key?.startsWith("pendingInput:v1:")) throw new Error("injected IndexedDB failure");
  return originalPut.apply(this, args);
};
state().addOptimisticMessage("interrupted", "must survive interrupted database save", undefined, "wal-recovery");
await cache.flushPendingMessageJournal().catch(() => {});
expect(readPendingMessageJournal(localStorage).flatMap(batch => batch.writes).some(write => write.id === "wal-recovery")).toBe(true);
useInboxStore.setState({ pendingMessages: {} } as any);
IDBObjectStore.prototype.put = originalPut;
expect((await load())?.pendingMessages.interrupted[0].content).toBe("must survive interrupted database save");

const originalSetItem = dom.window.Storage.prototype.setItem;
dom.window.Storage.prototype.setItem = function (key: string, value: string) {
  if (key.startsWith("cast-pending-input:")) throw new Error("QuotaExceededError");
  return originalSetItem.call(this, key, value);
};
expect(() => state().addOptimisticMessage("quota", "do not clear this text", undefined, "quota-failed")).toThrow("could not be saved");
expect(state().pendingMessages.quota).toBeUndefined();
dom.window.Storage.prototype.setItem = originalSetItem;

resetWindow();
state().setQueuedMessagesFor("queue", ["queued before leaving", "next"]);
const queuedOnDisk = await load();
expect(queuedOnDisk?.queuedMessages.queue).toEqual(["queued before leaving", "next"]);
const queuedId = queuedOnDisk?.pendingMessages.queue[0]._clientId;
const sent = state().takeQueuedMessage("queue");
expect(sent.clientId).toBe(queuedId);
expect((await load())?.queuedMessages.queue).toEqual(["next"]);

const foreign = await cache.loadCache(["pendingMessages"], { currentUser: { _id: "different-owner" } });
expect(foreign?.pendingMessages).toEqual({});

const db = new Dexie("codecast-store");
await db.open();
await db.table("meta").put({ key: "currentUser", value: owner });
await db.table("meta").put({ key: "pendingMessages", value: { legacy: [{ _id: "old-input", _clientId: "old-input", role: "user", content: "upgrade must preserve this", timestamp: 1 }] } });
expect((await load())?.pendingMessages.legacy[0].content).toBe("upgrade must preserve this");
expect(await db.table("meta").get("pendingMessages")).toBeUndefined();
db.close();
await cache.purgeLocalCache();
expect(readPendingMessageJournal(localStorage)).toEqual([]);
expect((await load())?.pendingMessages ?? {}).toEqual({});
console.log("follower save, reload, concurrent windows, exact echo, stale replay, quota, migration and account isolation verified");
process.exit(0);
