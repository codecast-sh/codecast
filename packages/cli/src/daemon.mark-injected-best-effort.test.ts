import { describe, expect, test } from "bun:test";
import { markInjectedBestEffort } from "./daemon.js";

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
