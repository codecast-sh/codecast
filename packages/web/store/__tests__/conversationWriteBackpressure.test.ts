import { describe, expect, it } from "bun:test";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import {
  _reopenForTests,
  flushConversationMessages,
  loadConversationMessages,
  setHydrating,
  writeConversationMessages,
} from "../idbCache";

await _reopenForTests({ indexedDB, IDBKeyRange });
setHydrating(false);

async function waitFor(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Cache write did not settle");
    await Bun.sleep(5);
  }
}

function conversationTable(): Dexie.Table {
  return (Dexie.connections.find((db) => db.name === "codecast-store") as any).conversationMessages;
}

function holdWrites() {
  const table = conversationTable();
  const put = table.put;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writes: any[] = [];
  table.put = function (row: any) {
    writes.push(row);
    return Dexie.Promise.resolve(gate).then(() => put.call(table, row));
  };
  return { table, writes, release, restore: () => { table.put = put; } };
}

const message = (n: number) => ({ _id: `message-${n}`, timestamp: Date.now(), content: `revision ${n}` });

describe("conversation cache backpressure", () => {
  it("keeps only the newest waiting snapshot while a write is stalled", async () => {
    const held = holdWrites();
    const id = `backpressure-${crypto.randomUUID()}`;
    try {
      for (let n = 0; n < 25; n++) {
        writeConversationMessages(id, [message(n)], { page: n });
        flushConversationMessages();
      }
      expect(held.writes).toHaveLength(1);
      expect((await loadConversationMessages(id))?.messages[0].content).toBe("revision 24");
      held.release();
      await waitFor(async () => (await held.table.get(id))?.pagination.page === 24);
      expect(held.writes.map((row) => row.pagination.page)).toEqual([0, 24]);
    } finally {
      held.release();
      held.restore();
    }
  });

  it("serves the in-flight snapshot before its disk commit", async () => {
    const held = holdWrites();
    const id = `in-flight-${crypto.randomUUID()}`;
    try {
      writeConversationMessages(id, [message(1)], { page: 1 });
      flushConversationMessages();
      expect((await loadConversationMessages(id))?.pagination).toEqual({ page: 1 });
      held.release();
      await waitFor(async () => !!(await held.table.get(id)));
    } finally {
      held.release();
      held.restore();
    }
  });

  it("does not lose another conversation while coalescing a busy one", async () => {
    const held = holdWrites();
    const first = `first-${crypto.randomUUID()}`;
    const second = `second-${crypto.randomUUID()}`;
    try {
      writeConversationMessages(first, [message(0)], { page: 0 });
      writeConversationMessages(second, [message(1)], { page: 1 });
      flushConversationMessages();
      writeConversationMessages(first, [message(2)], { page: 2 });
      flushConversationMessages();
      expect(held.writes).toHaveLength(2);
      held.release();
      await waitFor(async () => (await held.table.get(first))?.pagination.page === 2);
      expect((await held.table.get(second)).pagination.page).toBe(1);
    } finally {
      held.release();
      held.restore();
    }
  });

  it("keeps a failed snapshot readable and retries it on the next flush", async () => {
    const table = conversationTable();
    const put = table.put;
    const id = `failed-${crypto.randomUUID()}`;
    let attempts = 0;
    table.put = function (row: any) {
      attempts++;
      return attempts === 1
        ? Dexie.Promise.reject(new Error("Storage temporarily unavailable"))
        : put.call(table, row);
    };
    try {
      writeConversationMessages(id, [message(1)], { page: 1 });
      flushConversationMessages();
      await Bun.sleep(350);
      expect(attempts).toBe(1);
      expect((await loadConversationMessages(id))?.pagination).toEqual({ page: 1 });
      flushConversationMessages();
      await waitFor(async () => !!(await table.get(id)));
      expect(attempts).toBe(2);
    } finally {
      table.put = put;
    }
  });

  it("can save a newer snapshot after serialization throws synchronously", async () => {
    const id = `serialization-${crypto.randomUUID()}`;
    const invalid = { get timestamp(): number { throw new Error("Cannot serialize snapshot"); } };
    writeConversationMessages(id, [invalid], { page: 0 });
    expect(() => flushConversationMessages()).not.toThrow();
    writeConversationMessages(id, [message(1)], { page: 1 });
    await waitFor(async () => (await conversationTable().get(id))?.pagination.page === 1);
  });
});
