import { describe, expect, test } from "bun:test";
import { clearMessageDeliveryStateForConversation, markInjectedBestEffort } from "./daemon.js";

// Regression test for the "web message reaches 'Delivering to session' then never pastes" bug
// (session fdc3bd59 / jx7174z, 2026-05-25). deliverMessage marked the pending message
// "injected" with an un-timed Convex mutation BEFORE the tmux send-keys. When Convex was jammed
// (the concurrent "sync stalled" backlog), that mutation hung indefinitely, so the local paste
// never ran and deliverMessage looped on its 180s timeout forever — the text never reached the
// agent's JSONL. The fix pastes first and marks "injected" best-effort with a hard timeout, so a
// stalled status write can never block delivery; correctness is preserved by the content-matched
// ack in addMessages (Convex) that promotes the row to "delivered" when the agent echoes it.

type StatusArg = { messageId: string; status: string; deliveredAt?: number };

describe("markInjectedBestEffort", () => {
  test("resolves within the timeout even when updateMessageStatus never settles", async () => {
    const sync = {
      // Simulates a jammed Convex: the mutation promise never resolves or rejects.
      updateMessageStatus: (_: StatusArg) => new Promise<void>(() => {}),
    };
    const start = Date.now();
    await markInjectedBestEffort(sync, "msg_hang", 50);
    const elapsed = Date.now() - start;
    // Must bail at the injected timeout, not hang. Generous upper bound for CI jitter.
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  test("marks the message injected when Convex responds promptly", async () => {
    const calls: StatusArg[] = [];
    const sync = {
      updateMessageStatus: async (arg: StatusArg) => { calls.push(arg); },
    };
    await markInjectedBestEffort(sync, "msg_ok", 5000);
    expect(calls).toEqual([{ messageId: "msg_ok", status: "injected" }]);
  });

  test("swallows a rejected status update without throwing", async () => {
    const sync = {
      updateMessageStatus: async (_: StatusArg) => { throw new Error("auth expired"); },
    };
    // Resolves (does not reject) — a failed bookkeeping write must not fail delivery.
    await expect(markInjectedBestEffort(sync, "msg_err", 5000)).resolves.toBeUndefined();
  });
});

// Regression tests for the 2026-07-13 redelivery storm (ct-38507): during a backend
// brownout, mark-injected timeouts left rows "pending" server-side while the messages
// were already in agents' panes; delivery-state clears then dropped the local dedup
// entries and the pending scanner re-sent the same messages ('gogo' processed 7x).
// The fix has two halves, both observable through clearMessageDeliveryStateForConversation:
// a confirmed entry is cleared (redelivery contract for dead panes intact), an
// unconfirmed one is preserved (redelivery blocked until the mark lands).
describe("mark-injected confirmation and dedup persistence", () => {
  test("retries until the status write lands and the entry becomes confirmed", async () => {
    let failures = 1;
    const calls: StatusArg[] = [];
    const sync = {
      updateMessageStatus: (arg: StatusArg) => {
        calls.push(arg);
        if (failures-- > 0) return new Promise<void>(() => {}); // jammed Convex
        return Promise.resolve();
      },
    };
    await markInjectedBestEffort(sync, "m_retry", 20, { conversationId: "conv_retry", retryDelaysMs: [30] });
    expect(calls.length).toBe(1); // initial attempt timed out
    await new Promise(r => setTimeout(r, 120)); // let the background retry fire
    expect(calls.length).toBe(2);
    // Confirmed on retry → a pane-death clear drops it (normal redelivery contract).
    const cleared = clearMessageDeliveryStateForConversation("conv_retry");
    expect(cleared).toEqual({ inFlight: 0, dedup: 1, preserved: 0 });
  });

  test("an unconfirmed injection survives delivery-state clears", async () => {
    const sync = {
      updateMessageStatus: (_: StatusArg) => new Promise<void>(() => {}), // never lands
    };
    await markInjectedBestEffort(sync, "m_unconfirmed", 10, { conversationId: "conv_storm", retryDelaysMs: [] });
    // The brownout clear ([HEARTBEAT-HEALTH] etc.) must NOT hand the pending scanner a duplicate.
    expect(clearMessageDeliveryStateForConversation("conv_storm")).toEqual({ inFlight: 0, dedup: 0, preserved: 1 });
    // Idempotent: repeated clears keep preserving it.
    expect(clearMessageDeliveryStateForConversation("conv_storm")).toEqual({ inFlight: 0, dedup: 0, preserved: 1 });
  });

  test("background retries are bounded by the delay schedule", async () => {
    const calls: StatusArg[] = [];
    const sync = {
      updateMessageStatus: (arg: StatusArg) => { calls.push(arg); return new Promise<void>(() => {}); },
    };
    await markInjectedBestEffort(sync, "m_bounded", 10, { conversationId: "conv_bounded", retryDelaysMs: [20, 20] });
    await new Promise(r => setTimeout(r, 200));
    expect(calls.length).toBe(3); // initial + exactly the two scheduled retries
  });

  test("a confirmed first attempt needs no retries and clears normally", async () => {
    const calls: StatusArg[] = [];
    const sync = {
      updateMessageStatus: async (arg: StatusArg) => { calls.push(arg); },
    };
    await markInjectedBestEffort(sync, "m_ok", 5000, { conversationId: "conv_ok", retryDelaysMs: [10] });
    await new Promise(r => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(clearMessageDeliveryStateForConversation("conv_ok")).toEqual({ inFlight: 0, dedup: 1, preserved: 0 });
  });
});
