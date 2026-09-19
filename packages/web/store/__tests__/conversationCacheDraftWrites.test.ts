import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, it } from "bun:test";
import Dexie from "dexie";
import { useInboxStore } from "../inboxStore";
import { _reopenForTests, flushConversationMessages, setHydrating } from "../idbCache";

await _reopenForTests({ indexedDB, IDBKeyRange });
setHydrating(false);

// The store hands the cache values it read inside a draft: rows carried over
// from the previous array, and the pagination object when a merge passes it
// through. mutative revokes those proxies when the draft ends, so the deferred
// write threw on serialization and the throw was swallowed. Streamed rows never
// reached the disk cache. These tests read the committed row, not the pending
// write, so they fail if any value reaching the cache is still a draft.

const CONV = "conv_draftwrite_aaaaaaaaaaaaaaaaaaaaa";
const msg = (n: number) => ({ _id: `m${n}`, role: "assistant", content: `row ${n}`, timestamp: n }) as any;

async function committedIds(): Promise<string[] | undefined> {
  const table = (Dexie.connections.find((db) => db.name === "codecast-store") as any).conversationMessages;
  const deadline = Date.now() + 5_000;
  let row = await table.get(CONV);
  while (Date.now() < deadline) {
    await Bun.sleep(20);
    row = await table.get(CONV);
    if (row && Date.now() > deadline - 4_500) break;
  }
  return row?.messages.map((m: any) => m._id);
}

function reset() {
  useInboxStore.setState({ messages: { [CONV]: [] }, pendingMessages: { [CONV]: [] }, pagination: {}, pending: {} });
  return useInboxStore.getState();
}

it("a streamed append persists, pagination passed through the draft included", async () => {
  const st = reset();
  st.setMessages(CONV, [msg(1), msg(2)], { hasMoreAbove: false, initialized: true });
  flushConversationMessages();
  await Bun.sleep(200);
  st.mergeMessages(CONV, [msg(3)], "append");
  flushConversationMessages();
  expect(await committedIds()).toEqual(["m1", "m2", "m3"]);
});

it("a live tail that keeps earlier rows persists", async () => {
  const st = reset();
  st.setMessages(CONV, [msg(1), msg(2)], { hasMoreAbove: false, initialized: true });
  flushConversationMessages();
  await Bun.sleep(200);
  st.applyTailMessages(CONV, 2, [msg(3), msg(4)], 4);
  flushConversationMessages();
  expect(await committedIds()).toEqual(["m1", "m2", "m3", "m4"]);
});
