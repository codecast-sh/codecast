import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { MESSAGE_PAGE_SIZE } from "../cacheRetention";
import Dexie from "dexie";
import { _reopenForTests, flushConversationMessages, loadConversationMessages, setHydrating } from "../idbCache";

await _reopenForTests({ indexedDB, IDBKeyRange });
setHydrating(false);

// The cache keeps one page of messages per conversation, the newest. A phone
// that persisted whole transcripts held a 24 MB row for one conversation,
// rewrote it on every push, and parsed 78 MB of rows at boot.

const CONV = "conv_tail_cap_aaaaaaaaaaaaaaaaaaaaa";
const msg = (n: number) => ({ _id: `m${n}`, role: "assistant", content: `row ${n}`, timestamp: n }) as any;
const many = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1));

// The web cache coalesces writes; read the committed row once the newest
// write landed. (Reading through loadConversationMessages while a write is
// pending hands back the store's own array, whose draft proxies are revoked.)
async function settled(firstId: string) {
  const table = (Dexie.connections.find((db) => db.name === "codecast-store") as any).conversationMessages;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const row = await table.get(CONV);
    if (row?.messages[0]?._id === firstId || Date.now() > deadline) return row;
    await Bun.sleep(10);
  }
}

describe("persisted message tail", () => {
  beforeEach(() => {
    useInboxStore.setState({ messages: { [CONV]: [] }, pendingMessages: { [CONV]: [] }, pagination: {}, pending: {} });
  });

  it("persists only the newest page and marks older rows as loadable", async () => {
    useInboxStore.getState().setMessages(CONV, many(MESSAGE_PAGE_SIZE + 50), { hasMoreAbove: false, initialized: true });
    expect(useInboxStore.getState().messages[CONV]).toHaveLength(MESSAGE_PAGE_SIZE + 50);
    flushConversationMessages();
    const cached = await loadConversationMessages(CONV);
    expect(cached?.messages).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(cached?.messages[0]._id).toBe("m51");
    expect(cached?.messages[MESSAGE_PAGE_SIZE - 1]._id).toBe(`m${MESSAGE_PAGE_SIZE + 50}`);
    expect(cached?.pagination.hasMoreAbove).toBe(true);
  });

  it("persists a short conversation whole, with its own pagination", async () => {
    useInboxStore.getState().setMessages(CONV, many(3), { hasMoreAbove: false, initialized: true });
    flushConversationMessages();
    const cached = await loadConversationMessages(CONV);
    expect(cached?.messages.map((m) => m._id)).toEqual(["m1", "m2", "m3"]);
    expect(cached?.pagination.hasMoreAbove).toBe(false);
  });

  it("applies the cap on the merge and tail paths too", async () => {
    const st = useInboxStore.getState();
    st.setMessages(CONV, many(MESSAGE_PAGE_SIZE), { hasMoreAbove: false, initialized: true });
    st.mergeMessages(CONV, [msg(MESSAGE_PAGE_SIZE + 1)], "append");
    flushConversationMessages();
    expect((await settled("m2"))?.messages[0]._id).toBe("m2");
    st.applyTailMessages(CONV, MESSAGE_PAGE_SIZE + 1, [msg(MESSAGE_PAGE_SIZE + 2)], MESSAGE_PAGE_SIZE + 2);
    flushConversationMessages();
    const cached = await settled("m3");
    expect(cached?.messages).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(cached?.messages[0]._id).toBe("m3");
    expect(cached?.pagination.hasMoreAbove).toBe(true);
  });
});
