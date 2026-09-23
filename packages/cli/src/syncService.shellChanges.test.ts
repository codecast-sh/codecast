import { expect, test } from "bun:test";
import { SyncService } from "./syncService.js";

test("message sync queues shell references without reading or attaching file contents", async () => {
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
  const enqueued: unknown[] = [];
  const sent: any[] = [];
  (sync as any).shellChangeSync = { enqueue: (...args: unknown[]) => enqueued.push(args) };
  (sync as any).client = { mutation: async (_name: string, args: any) => {
    sent.push(args);
    return { inserted: args.messages.length, ids: ["m"] };
  } };
  (sync as any).throttle = async () => {};
  const toolResults = [{ toolUseId: "toolu_large", content: "ok" }];
  await sync.addMessages({ conversationId: "conv", messages: [{
    messageUuid: "uuid", role: "human", content: "", timestamp: 1, toolResults,
  }] });
  expect(enqueued).toEqual([["conv", "uuid", toolResults]]);
  expect(sent[0].messages[0].file_changes).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(1000);
});

test("reconciled messages still enqueue shell diffs after a timed-out message upload", async () => {
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
  const enqueued: unknown[] = [];
  (sync as any).shellChangeSync = { enqueue: (...args: unknown[]) => enqueued.push(args) };
  (sync as any).client = { query: async () => ["uuid"], mutation: async () => { throw new Error("must not send again"); } };
  (sync as any).throttle = async () => {};
  await sync.addMessages({ conversationId: "conv", reconcileRemoteExisting: true, messages: [{
    messageUuid: "uuid", role: "human", content: "", timestamp: 1, toolResults: [{ toolUseId: "toolu_x", content: "ok" }],
  }] });
  expect(enqueued).toHaveLength(1);
});
