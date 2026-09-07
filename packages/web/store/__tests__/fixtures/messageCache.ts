import { expect } from "bun:test";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const cache = await import("../../idbCache");
const { ensureHydrated, useInboxStore } = await import("../../inboxStore");
const now = Date.now();
const message = (id: string) => ({ _id: id, role: "user", content: id, timestamp: now });
const pagination = { initialized: true, hasMore: false };
await cache.enqueueDispatch({ id: "seed", action: "seed", args: [], patches: [], result: null, ts: now });
const db = new Dexie("codecast-store");
await db.open();
await db.table("conversationMessages").put({ convId: "cached", messages: [message("disk")], pagination, latestTimestamp: now });
await db.table("conversationUserMessages").put({ convId: "cached", userMessages: [message("disk")] });
const puts: string[] = [];
const original = IDBObjectStore.prototype.put;
let firstWriteTurnCount = 0;
let probeArmed = false;
IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
  if (this.name === "conversationMessages" || this.name === "conversationUserMessages") {
    puts.push(args[0].convId);
    if (probeArmed) {
      probeArmed = false;
      setTimeout(() => { firstWriteTurnCount = puts.length; }, 0);
    }
  }
  return original.apply(this, args);
};
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 1000 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
};

expect(await ensureHydrated("cached")).toBe(true);
expect(useInboxStore.getState().messages.cached.map((m) => m._id)).toEqual(["disk"]);
expect(useInboxStore.getState().userMessages.cached.map((m) => m._id)).toEqual(["disk"]);
cache.flushConversationMessages();
await new Promise((resolve) => setTimeout(resolve, 5));
expect(puts).toEqual([]);

useInboxStore.getState().setMessages("cached", [message("disk"), message("live")] as any);
expect((await cache.loadConversationMessages("cached"))?.messages.map((m) => m._id)).toEqual(["disk", "live"]);
cache.flushConversationMessages();
await waitFor(() => puts.length === 1);
expect((await db.table("conversationMessages").get("cached")).messages.map((m: any) => m._id)).toEqual(["disk", "live"]);

puts.length = 0;
probeArmed = true;
for (let i = 0; i < 12; i++) cache.writeConversationMessages(`batch-${i}`, [message(`m-${i}`)], pagination);
await waitFor(() => puts.length === 12);
expect(firstWriteTurnCount).toBeGreaterThan(0);
expect(firstWriteTurnCount).toBeLessThan(12);

puts.length = 0;
for (let i = 0; i < 4; i++) cache.writeConversationMessages(`hide-${i}`, [message(`h-${i}`)], pagination);
cache.flushConversationMessages();
await waitFor(() => puts.length === 4);
IDBObjectStore.prototype.put = original;
db.close();
console.log("hydration, live writes, read-your-writes, yielding and close flush verified");
