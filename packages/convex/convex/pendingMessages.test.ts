import { describe, expect, test } from "bun:test";
import {
  canDaemonSeePendingMessage,
  claimPendingMessageForDaemon,
  isControlMessage,
  markPendingDelivered,
  planStuckMessageHeal,
  resetConversationPendingMessages,
  updatePendingMessageStatusForDaemon,
} from "./pendingMessages";

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

  test("is a no-op for a cancelled message (cancelled is terminal)", async () => {
    const { ctx, patches } = createCtx({ remainingByStatus: {} });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "cancelled",
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

const createOwnerCtx = (records: Record<string, any>) => {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      async get(id: string) {
        return records[id] ?? null;
      },
      async patch(id: string, patch: Record<string, unknown>) {
        patches.push({ id, patch });
        records[id] = { ...records[id], ...patch };
      },
      query(_table: string) {
        return {
          withIndex(_index: string, builder: (q: any) => unknown) {
            builder({ eq: () => ({ eq: () => {} }) });
            return {
              async first() {
                return null;
              },
            };
          },
        };
      },
    },
  };
  return { ctx, patches, records };
};

describe("daemon pending-message ownership", () => {
  test("only the owner daemon can see, claim, and mark a pending row", async () => {
    const records: Record<string, any> = {
      c1: { _id: "c1", user_id: "u1", owner_device_id: "dev-owner" },
      m1: { _id: "m1", conversation_id: "c1", from_user_id: "u1", status: "pending", retry_count: 0 },
    };
    const { ctx, patches } = createOwnerCtx(records);

    expect(canDaemonSeePendingMessage(records.m1 as any, records.c1 as any, "u1" as any, "dev-owner")).toBe(true);
    expect(canDaemonSeePendingMessage(records.m1 as any, records.c1 as any, "u1" as any, "dev-other")).toBe(false);

    await expect(claimPendingMessageForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-other")).resolves.toBeNull();
    expect(patches).toHaveLength(0);

    const skipped = await updatePendingMessageStatusForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-other", { status: "injected" });
    expect(skipped).toEqual({ updated: false, skipped: true });
    expect(patches).toHaveLength(0);

    const claimed = await claimPendingMessageForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-owner");
    expect(claimed?._id).toBe("m1");

    const updated = await updatePendingMessageStatusForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-owner", { status: "injected" });
    expect(updated).toEqual({ updated: true, skipped: false });
    expect(patches).toEqual([{ id: "m1", patch: { status: "injected" } }]);
  });

  test("legacy unowned conversations are atomically claimed before daemon delivery", async () => {
    const records: Record<string, any> = {
      c1: { _id: "c1", user_id: "u1" },
      m1: { _id: "m1", conversation_id: "c1", from_user_id: "u1", status: "pending", retry_count: 0 },
    };
    const { ctx, patches } = createOwnerCtx(records);

    const claimed = await claimPendingMessageForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-a");
    expect(claimed?._id).toBe("m1");
    expect(records.c1.owner_device_id).toBe("dev-a");
    expect(patches).toEqual([{ id: "c1", patch: { owner_device_id: "dev-a" } }]);

    await expect(claimPendingMessageForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-b")).resolves.toBeNull();
    expect(patches).toHaveLength(1);
  });

  test("terminal delivered and cancelled rows cannot be revived by daemon status updates", async () => {
    for (const status of ["delivered", "cancelled"]) {
      const records: Record<string, any> = {
        c1: { _id: "c1", user_id: "u1" },
        m1: { _id: "m1", conversation_id: "c1", from_user_id: "u1", status, retry_count: 4 },
      };
      const { ctx, patches } = createOwnerCtx(records);

      const result = await updatePendingMessageStatusForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-owner", { status: "pending" });
      expect(result).toEqual({ updated: false, skipped: true });
      expect(patches).toHaveLength(0);
      expect(records.m1.status).toBe(status);
      expect(records.c1.owner_device_id).toBeUndefined();
    }
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

// Fake ctx.db that returns a fixed by_conversation_id collection and records patches.
const createCollectCtx = (messages: Array<Record<string, any>>) => {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      query() {
        return {
          withIndex(_index: string, builder: (q: any) => unknown) {
            builder({ eq: () => ({ eq: () => {} }) });
            return { async collect() { return messages; } };
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

// Regression: a message that never reached a dead session is left as injected/failed/
// undeliverable. resumeSession/restartSession call this on reconnect so those stranded
// messages get redelivered instead of staying stuck and forcing a manual resend.
describe("resetConversationPendingMessages", () => {
  test("re-pends stranded injected/failed/undeliverable messages, leaving pending/delivered alone", async () => {
    const messages = [
      { _id: "m_injected", status: "injected", retry_count: 3, delivered_at: 123 },
      { _id: "m_failed", status: "failed", retry_count: 5 },
      { _id: "m_undeliverable", status: "undeliverable", retry_count: 12 },
      { _id: "m_pending", status: "pending", retry_count: 0 },
      { _id: "m_delivered", status: "delivered", retry_count: 1, delivered_at: 456 },
      { _id: "m_cancelled", status: "cancelled", retry_count: 1 },
    ];
    const { ctx, patches } = createCollectCtx(messages);

    const count = await resetConversationPendingMessages(ctx as any, "c1" as any);
    expect(count).toBe(3);

    for (const id of ["m_injected", "m_failed", "m_undeliverable"]) {
      const p = patches.find((x) => x.id === id);
      expect(p?.patch.status).toBe("pending");
      expect(p?.patch.retry_count).toBe(0);
      expect("delivered_at" in (p?.patch ?? {})).toBe(true);
      expect(p?.patch.delivered_at).toBeUndefined();
    }
    // Already-pending and terminal-delivered rows must not be touched.
    expect(patches.find((x) => x.id === "m_pending")).toBeUndefined();
    expect(patches.find((x) => x.id === "m_delivered")).toBeUndefined();
    expect(patches.find((x) => x.id === "m_cancelled")).toBeUndefined();
    // Conversation is re-flagged as having pending work so the inbox/daemon notice it.
    expect(patches.find((x) => x.id === "c1")?.patch).toEqual({ has_pending_messages: true });
  });

  test("no-op when nothing is stranded (does not re-flag the conversation)", async () => {
    const messages = [
      { _id: "m_pending", status: "pending", retry_count: 0 },
      { _id: "m_delivered", status: "delivered", retry_count: 1 },
    ];
    const { ctx, patches } = createCollectCtx(messages);

    const count = await resetConversationPendingMessages(ctx as any, "c1" as any);
    expect(count).toBe(0);
    expect(patches).toHaveLength(0);
  });
});

// The cron healer's decision logic. Core invariant under test: it never abandons a message
// (undeliverable is non-terminal, and there is no age ceiling) and never consumes the
// real-attempt budget for waiting time.
describe("planStuckMessageHeal", () => {
  const now = 1_000_000_000_000;
  const recent = (status: string, content = "hi", ageMs = 5 * 60_000) =>
    planStuckMessageHeal({ status, content, created_at: now - ageMs }, now);

  test("revives undeliverable — it is NOT a dead-end", () => {
    expect(recent("undeliverable").kind).toBe("repend");
  });

  test("revives failed (transient sync failure)", () => {
    expect(recent("failed").kind).toBe("repend");
  });

  test("re-pends an injected message once the ack grace has elapsed (session likely died)", () => {
    expect(recent("injected", "real text", 3 * 60_000).kind).toBe("repend");
  });

  test("leaves a freshly-injected message alone so the JSONL ack can land", () => {
    expect(recent("injected", "real text", 30_000).kind).toBe("skip");
  });

  test("acks a stale injected control message instead of re-injecting keystrokes", () => {
    const control = '{"__cc_poll":true,"keys":["2"],"display":"Commit everything together"}';
    expect(recent("injected", control, 3 * 60_000).kind).toBe("deliver_control");
  });

  test("leaves a fresh pending message to the daemon's live subscription", () => {
    // Within the in-flight grace the daemon owns delivery — the cron must not race it
    // (and must never bump retry_count for waiting time, the original pending bug).
    expect(recent("pending", "real text", 30_000).kind).toBe("skip");
  });

  test("revives an abandoned pending message — a dropped status-write left it with no backstop", () => {
    // Past the grace, a still-pending row provably never landed (a delivered message is promoted
    // to terminal "delivered" by the content-match ack), so reviving it can't duplicate delivery.
    expect(recent("pending", "real text", 3 * 60_000).kind).toBe("repend");
  });

  test("does NOT revive a pending poll-keystroke control message (re-pending could double-select)", () => {
    const control = '{"__cc_poll":true,"keys":["2"],"display":"Commit everything together"}';
    expect(recent("pending", control, 3 * 60_000).kind).toBe("skip");
  });

  test("revives stranded messages regardless of age — a message must always reach delivery", () => {
    const old = 9 * 60 * 60_000; // 9h, well past the former 1h heal window
    expect(recent("undeliverable", "hi", old).kind).toBe("repend");
    expect(recent("failed", "hi", old).kind).toBe("repend");
    expect(recent("injected", "real text", old).kind).toBe("repend");
    expect(recent("pending", "real text", old).kind).toBe("repend");
  });
});
