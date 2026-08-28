import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { describe, it, expect } from "bun:test";
import {
  loadConversationMessages,
  writeConversationMessages,
  writeConversationUserMessages,
  flushConversationMessages,
  _reopenForTests,
} from "../idbCache";

// bun has no IndexedDB, and the Dexie singleton may already have failed to
// open in another test file: bind it to fake-indexeddb and reopen.
await _reopenForTests({ indexedDB, IDBKeyRange });

// The message navigator (MessageBrowserPopover) reads the complete
// getUserMessages list from the store. That list used to live only in memory,
// so every reload and every post-eviction reopen showed a skeleton until the
// query answered. It is now persisted beside the message pages and restored
// by ensureHydrated; these tests pin the disk round-trip.

const cid = (n: number) => `k${String(n).padStart(31, "0")}`;
const um = (id: string, ts: number) => ({ _id: id, role: "user" as const, content: `msg ${id}`, timestamp: ts });

describe("conversation user-message cache", () => {
  it("round-trips the navigator list beside the message pages", async () => {
    const conv = cid(1);
    writeConversationMessages(conv, [{ _id: "m1", role: "assistant", content: "hi", timestamp: 10 }], { hasMoreAbove: false });
    writeConversationUserMessages(conv, [um("u1", 5), um("u2", 9)]);
    flushConversationMessages();
    const cached = await loadConversationMessages(conv);
    expect(cached?.messages.map((m) => m._id)).toEqual(["m1"]);
    expect(cached?.userMessages?.map((m) => m._id)).toEqual(["u1", "u2"]);
  });

  it("serves the navigator list even before any message page was persisted", async () => {
    const conv = cid(2);
    writeConversationUserMessages(conv, [um("u1", 5)]);
    const cached = await loadConversationMessages(conv);
    expect(cached?.messages).toEqual([]);
    expect(cached?.userMessages?.map((m) => m._id)).toEqual(["u1"]);
  });

  it("returns no list for a conversation that never persisted one", async () => {
    const conv = cid(3);
    writeConversationMessages(conv, [{ _id: "m1", role: "assistant", content: "hi", timestamp: 10 }], {});
    flushConversationMessages();
    const cached = await loadConversationMessages(conv);
    expect(cached?.messages.length).toBe(1);
    expect(cached?.userMessages).toBeUndefined();
    expect(await loadConversationMessages(cid(4))).toBeNull();
  });
});
