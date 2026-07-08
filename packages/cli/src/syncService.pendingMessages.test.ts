import { describe, expect, test } from "bun:test";
import { SyncService } from "./syncService.js";

function createSyncWithCapturedMutations(results: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "token" });
  (sync as any).client = {
    mutation: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return results[name];
    },
  };
  return { sync, calls };
}

describe("SyncService pending-message daemon ownership", () => {
  test("sends this daemon's device id on pending-message lifecycle mutations", async () => {
    const { sync, calls } = createSyncWithCapturedMutations();

    await sync.updateMessageStatus({ messageId: "m1", status: "injected" });
    await sync.retryMessage("m1");
    await sync.ackInjectedMessages("c1");
    await sync.resetInjectedMessages("c1");

    expect(calls.map((c) => c.name)).toEqual([
      "pendingMessages:updateMessageStatus",
      "pendingMessages:retryMessage",
      "pendingMessages:ackInjectedMessages",
      "pendingMessages:resetInjectedMessages",
    ]);
    for (const call of calls) {
      expect(typeof call.args.device_id).toBe("string");
      expect((call.args.device_id as string).length).toBeGreaterThan(0);
      expect(call.args.api_token).toBe("token");
    }
  });

  test("claims a pending message before daemon delivery", async () => {
    const claimed = {
      _id: "m1",
      conversation_id: "c1",
      from_user_id: "u",
      content: "hello",
      status: "pending",
      created_at: 1,
      retry_count: 0,
    };
    const { sync, calls } = createSyncWithCapturedMutations({
      "pendingMessages:claimPendingMessageForDelivery": claimed,
    });

    await expect(sync.claimPendingMessageForDelivery("m1")).resolves.toEqual(claimed);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("pendingMessages:claimPendingMessageForDelivery");
    expect(calls[0].args.message_id).toBe("m1");
    expect(typeof calls[0].args.device_id).toBe("string");
  });
});
