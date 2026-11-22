import "fake-indexeddb/auto";
import { stampCacheOwner } from "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "bun:test";
import Dexie from "dexie";

// ct-98162: on a large account the inbox draws its skeleton, then the page
// freezes for ~850 ms inside IDBTransaction.oncomplete while the local cache
// hydrates. Hydration must hand the main thread back between chunks: no
// single uninterrupted run of script longer than a long-task budget.
//
// The store's persistence boots at module eval only when `window` exists, so
// the window stand-in goes up before the store is imported (dynamically).
const hadWindow = "window" in globalThis;
(globalThis as any).window ??= { location: { pathname: "/inbox", search: "", hash: "", href: "http://localhost/inbox" }, addEventListener() {}, removeEventListener() {} };
const { _reopenForTests } = await import("../idbCache");
await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();

const NOW = Date.now();
const id = (p: string, n: number) => `${p}${String(n).padStart(32 - p.length, "0")}`;
// Sized like a large account a few months in; the block grows with row count.
const SCALE = 3;
const text = (n: number) => `row ${n} `.repeat(40);

// A large account's cache: the inbox's own rows plus the deferred lists.
async function seedLargeCache() {
  const db = Dexie.connections.find((d) => d.name === "codecast-store") as any;
  const sessions = [], conversations: Record<string, any> = {}, feed = [], tasks = [], docs = [], chat = [];
  for (let i = 0; i < 1200; i++) {
    const s = { _id: id("k", i), title: `Session ${i}`, updated_at: NOW - i * 60_000, message_count: i, project_path: "/code/x", summary: text(i), status: "idle" };
    sessions.push(s);
    conversations[s._id] = { ...s, preview: text(i) };
  }
  for (let i = 0; i < 3000 * SCALE; i++) feed.push({ _id: id("f", i), title: `Feed ${i}`, updated_at: NOW - i * 60_000, summary: text(i) });
  for (let i = 0; i < 6000 * SCALE; i++) tasks.push({ _id: id("t", i), title: `Task ${i}`, short_id: `ct-${i}`, status: "open", updated_at: NOW - i * 1000, description: text(i) });
  for (let i = 0; i < 3000 * SCALE; i++) docs.push({ _id: id("d", i), title: `Doc ${i}`, updated_at: NOW - i * 1000, content: text(i) });
  for (let i = 0; i < 6000 * SCALE; i++) chat.push({ _id: id("c", i), body: text(i), created_at: NOW - i * 1000, channel_id: "ch" });
  await db.table("sessions").bulkPut(sessions);
  await db.table("tasks").bulkPut(tasks);
  await db.table("docs").bulkPut(docs);
  await db.table("chatMessages").bulkPut(chat);
  await db.table("meta").bulkPut([
    { key: "conversations", value: conversations },
    { key: "feedConversations", value: feed },
    { key: "liveInboxIdList", value: sessions.slice(0, 600).map((s) => s._id) },
  ]);
}

const LONG_TASK_BUDGET_MS = 50;

describe("cache hydration on a large account (ct-98162)", () => {
  it(`never blocks the main thread longer than ${LONG_TASK_BUDGET_MS} ms at a stretch`, async () => {
    await seedLargeCache();
    // Heartbeat: a macrotask that re-arms itself; the gap between beats is the
    // longest stretch nothing else could run (no input, no paint).
    const gaps: string[] = []; let imported0 = performance.now();
    let last = performance.now();
    let longest = 0;
    let beating = true;
    const beat = () => {
      const t = performance.now();
      longest = Math.max(longest, t - last); if (t - last > 15) gaps.push(`${(t - last).toFixed(0)}@${(t - imported0).toFixed(0)}`);
      last = t;
      if (beating) setTimeout(beat, 0);
    };
    setTimeout(beat, 0);

    const { useInboxStore } = await import("../inboxStore");
    const imported = performance.now();
    last = imported; longest = 0; gaps.length = 0; imported0 = imported; // module evaluation is not hydration
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      const s = useInboxStore.getState() as any;
      if (Object.keys(s.tasks ?? {}).length >= 6000 * SCALE && Object.keys(s.sessions ?? {}).length >= 1200) break;
    }
    beating = false;
    const s = useInboxStore.getState() as any;
    console.log(`hydrated sessions=${Object.keys(s.sessions).length} tasks=${Object.keys(s.tasks).length} docs=${Object.keys(s.docs ?? {}).length}; longest block ${longest.toFixed(0)} ms gaps ${gaps.join(" ")}`);
    if (!hadWindow) delete (globalThis as any).window;
    expect(Object.keys(s.tasks).length).toBe(6000 * SCALE);
    expect(longest).toBeLessThanOrEqual(LONG_TASK_BUDGET_MS);
  }, 60_000);
});
