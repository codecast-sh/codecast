import { describe, expect, test } from "bun:test";
import { markPendingDelivered, isControlMessage } from "./pendingMessages";

// Fake ctx.db that records patches and answers by_conversation_status lookups from a
// configurable set of "other" rows still in flight for the conversation.
const createCtx = ({
  remainingByStatus = {},
}: {
  remainingByStatus?: Record<string, any>;
}) => {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      query(_table: string) {
        let status = "";
        return {
          withIndex(_index: string, builder: (q: any) => unknown) {
            const q = {
              eq(field: string, value: string) {
                if (field === "status") status = value;
                return q;
              },
            };
            builder(q);
            return {
              async first() {
                return remainingByStatus[status] ?? null;
              },
            };
          },
        };
      },
      async patch(id: string, patch: Record<string, unknown>) {
        patches.push({ id, patch });
      },
    },
  };
  return { ctx, patches };
};

describe("markPendingDelivered", () => {
  test("promotes an injected message to delivered and clears the conversation flag when drained", async () => {
    const { ctx, patches } = createCtx({ remainingByStatus: {} });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "injected",
    });

    const msgPatch = patches.find((p) => p.id === "m1");
    expect(msgPatch?.patch.status).toBe("delivered");
    expect(typeof msgPatch?.patch.delivered_at).toBe("number");

    const convPatch = patches.find((p) => p.id === "c1");
    expect(convPatch?.patch).toEqual({ has_pending_messages: false });
  });

  test("is a no-op for an already-delivered message (delivered is terminal)", async () => {
    const { ctx, patches } = createCtx({ remainingByStatus: {} });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "delivered",
    });
    expect(patches).toHaveLength(0);
  });

  test("does NOT clear the conversation flag while another pending message remains", async () => {
    const { ctx, patches } = createCtx({
      remainingByStatus: { pending: { _id: "m2" } },
    });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "pending",
    });

    expect(patches.find((p) => p.id === "m1")?.patch.status).toBe("delivered");
    expect(patches.find((p) => p.id === "c1")).toBeUndefined();
  });

  test("does NOT clear the conversation flag while another injected message remains", async () => {
    const { ctx, patches } = createCtx({
      remainingByStatus: { injected: { _id: "m3" } },
    });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "injected",
    });

    expect(patches.find((p) => p.id === "m1")?.patch.status).toBe("delivered");
    expect(patches.find((p) => p.id === "c1")).toBeUndefined();
  });
});

describe("isControlMessage", () => {
  test("recognizes __cc_poll keystroke answers (keys and steps forms)", () => {
    expect(isControlMessage('{"__cc_poll":true,"keys":["1"],"display":"Default (recommended)"}')).toBe(true);
    expect(isControlMessage('{"__cc_poll":true,"steps":[{"key":"2"}]}')).toBe(true);
  });

  test("treats normal user text and malformed JSON as non-control", () => {
    expect(isControlMessage("https://codecast.sh/conversation/x not responding")).toBe(false);
    expect(isControlMessage("go")).toBe(false);
    expect(isControlMessage('{"__cc_poll":true}')).toBe(false); // missing keys/steps
    expect(isControlMessage("{not json")).toBe(false);
  });
});
