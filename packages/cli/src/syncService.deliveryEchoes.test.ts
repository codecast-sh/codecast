import { describe, expect, test } from "bun:test";
import { SyncService } from "./syncService.js";

function service(refuseEchoIds = false) {
  const calls: Array<Record<string, any>> = [];
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "token" });
  (sync as any).client = {
    mutation: async (name: string, args: Record<string, any>) => {
      if (name !== "messages:addMessages") return null;
      calls.push(args);
      if (refuseEchoIds && "echo_ids" in args) {
        throw new Error("[CONVEX M(messages:addMessages)] ArgumentValidationError: Object contains extra field `echo_ids` that is not in the validator.\n\nObject: {...}");
      }
      return { inserted: args.messages.length, ids: args.messages.map((_: unknown, i: number) => `m${i}`) };
    },
  };
  sync.setDeliveryEchoes({
    stamp: (_conversationId, messages) => messages.map((m) => (m.content === "go" ? { ...m, deliveryIds: ["pm1"] } : m)),
  });
  return { sync, calls };
}

const batch = [
  { messageUuid: "u1", role: "human" as const, content: "go", timestamp: 1 },
  { messageUuid: "a1", role: "assistant" as const, content: "going", timestamp: 2 },
];

describe("uploading echoes with their delivery ids", () => {
  test("a stamped turn carries its ids and the batch says the writer stamps", async () => {
    const { sync, calls } = service();
    await sync.addMessages({ conversationId: "c1", messages: batch });
    expect(calls).toHaveLength(1);
    expect(calls[0].echo_ids).toBe(true);
    expect(calls[0].messages.map((m: any) => m.delivery_ids ?? null)).toEqual([["pm1"], null]);
  });

  test("a server older than delivery ids gets the batch without them, from then on", async () => {
    const { sync, calls } = service(true);
    await sync.addMessages({ conversationId: "c1", messages: batch });
    await sync.addMessages({ conversationId: "c1", messages: batch });
    expect(calls.map((c) => "echo_ids" in c)).toEqual([true, false, false]);
    expect(calls.slice(1).every((c) => c.messages.every((m: any) => !("delivery_ids" in m)))).toBe(true);
  });
});
