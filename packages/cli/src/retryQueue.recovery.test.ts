import { describe, it, expect } from "bun:test";
import { RetryQueue } from "./retryQueue.js";

// A backlog that backed off while the backend was down drains fast once one op
// succeeds, in order, and without pardoning an op that keeps failing. Split out
// of retryQueue.test.ts for its max-lines cap.
describe("RetryQueue recovery", () => {
  it("collapses backed-off backlog and drains it fast once one op succeeds (recovery)", async () => {
    // Regression: under backend saturation, ops time out and back off
    // exponentially (capped at minutes for network errors). Once the backend
    // recovers, the FIRST successful op proves it is reachable, so every other
    // queued op that is still parked on a stale backoff delay must collapse to
    // ~immediate instead of waiting out minutes — otherwise those conversations
    // stay frozen on the web long after recovery.
    //
    // Use a large backoff window so a NON-collapsed queue could not possibly
    // drain within the test's wait; if it drains, the collapse happened.
    const q = new RetryQueue({
      initialDelayMs: 10,
      maxDelayMs: 5 * 60 * 1000, // 5 min — same order as the production network cap
      maxAttempts: 50,
      concurrency: 5, // let all conversations attempt and back off in parallel
      onLog: () => {},
    });

    let backendUp = false;
    const succeeded: string[] = [];
    q.setExecutor(async (op) => {
      const convId = op.params.conversationId as string;
      // Network-style failure: backoff caps at 5 min and grows fast — exactly
      // the regime that froze conversations for minutes after recovery.
      if (!backendUp) throw new Error("fetch failed: unable to connect");
      succeeded.push(convId);
      return true;
    });

    // One op per conversation; each fails its first attempt and backs off.
    for (const c of ["a", "b", "c", "d"]) {
      q.add("addMessages", { conversationId: c, messages: [{ messageUuid: `${c}0` }] });
    }

    // Let the first failing round run so every op is genuinely backed off, then
    // stamp the long backoff the production network path would accrue (capped at
    // 5 min). A non-collapsed queue parked this far out cannot drain in the wait
    // budget below.
    await new Promise((r) => setTimeout(r, 120));
    expect(q.getQueueSize()).toBe(4);
    const farOff = Date.now() + 5 * 60 * 1000;
    for (const op of q.getPendingOperations()) {
      expect(op.attempts).toBeGreaterThan(0); // really failed and backed off
      op.nextRetryAt = farOff;
    }

    // Backend recovers. Model the queue reaching its next scheduled retry by
    // bringing exactly ONE op due (its backoff timer fires) and re-arming. That
    // single success is the proof-of-recovery that must collapse the OTHER three
    // ops' still-stale 5-min backoff to immediate. Without the collapse, those
    // three stay parked for minutes and the queue can't drain within the budget.
    backendUp = true;
    q.getPendingOperations()[0].nextRetryAt = Date.now();
    q.start(); // re-arm at the now-due earliest op (next-scheduled-retry firing)

    const drained = await q.waitForCompletion(1500);
    expect(drained).toBe(true);
    expect(q.getQueueSize()).toBe(0);
    expect(succeeded.sort()).toEqual(["a", "b", "c", "d"]);
    q.stop();
  });

  it("preserves order within a conversation when collapsing backlog on recovery", async () => {
    // The recovery collapse only changes WHEN ops run, never their relative
    // order. Per-conversation serialization (activeKeys) must still drain a
    // conversation's messages in enqueue order through a down→up transition.
    const q = new RetryQueue({
      initialDelayMs: 10,
      maxDelayMs: 5 * 60 * 1000,
      maxAttempts: 50,
      concurrency: 5,
      onLog: () => {},
    });

    let backendUp = false;
    const order: string[] = [];
    q.setExecutor(async (op) => {
      if (!backendUp) throw new Error("fetch failed: unable to connect");
      const msgs = op.params.messages as Array<{ messageUuid: string }>;
      for (const m of msgs) order.push(m.messageUuid);
      return true;
    });

    // Real conversation: enqueues coalesce in order into one chunked op. A second
    // conversation gives us an op to succeed first and trigger the collapse.
    q.add("addMessages", { conversationId: "real", messages: [{ messageUuid: "r1" }, { messageUuid: "r2" }] });
    q.add("addMessages", { conversationId: "real", messages: [{ messageUuid: "r3" }] });
    q.add("addMessages", { conversationId: "other", messages: [{ messageUuid: "o0" }] });

    // Both conversations fail their first attempt, then stamp the long network
    // backoff so only the recovery collapse can drain them in the budget.
    await new Promise((r) => setTimeout(r, 120));
    const farOff = Date.now() + 5 * 60 * 1000;
    for (const op of q.getPendingOperations()) {
      expect(op.attempts).toBeGreaterThan(0);
      op.nextRetryAt = farOff;
    }

    // Recover: bring one op due, the success collapses the rest.
    backendUp = true;
    q.getPendingOperations()[0].nextRetryAt = Date.now();
    q.start();

    const drained = await q.waitForCompletion(1500);
    expect(drained).toBe(true);
    // "real" messages drained in enqueue order, regardless of the recovery collapse.
    const realOrder = order.filter((u) => u.startsWith("r"));
    expect(realOrder).toEqual(["r1", "r2", "r3"]);
    q.stop();
  });

  it("recovery collapse preserves attempts so a persistently-failing op still hits maxAttempts", async () => {
    // Regression: collapseBackoffOnRecovery used to zero `attempts` on every
    // remaining op when one succeeded. A non-network op that keeps failing while
    // OTHER ops intermittently succeed would have its attempt count reset on each
    // success → it would NEVER reach maxAttempts and would be pardoned forever,
    // so the queue could never shed a permanently-bad op. The collapse must only
    // pull nextRetryAt forward, never reset attempts: the failing op's real attempt
    // count is preserved and the maxAttempts drop still fires.
    const logs2: string[] = [];
    const q = new RetryQueue({
      initialDelayMs: 1000, // long enough that ops stay parked between manual nudges
      maxDelayMs: 60_000,
      maxAttempts: 3,
      concurrency: 5,
      onLog: (m) => logs2.push(m),
    });

    let okShouldSucceed = false;
    q.setExecutor(async (op) => {
      if (op.params.conversationId === "bad") {
        throw new Error("Server error 500"); // non-network → counts toward maxAttempts
      }
      return okShouldSucceed; // "ok" drains only when we arm it, triggering a collapse
    });

    q.add("addMessages", { conversationId: "bad", messages: [{ messageUuid: "x1" }] });

    // Drive two failure rounds with an intervening "recovery" collapse between each.
    // If the collapse zeroed attempts, the bad op would never accumulate toward the
    // maxAttempts=3 drop no matter how many rounds run.
    for (let round = 0; round < 4; round++) {
      // Make the bad op due and process it (it fails, attempts++).
      const bad = q.getPendingOperations().find((o) => o.params.conversationId === "bad");
      if (!bad) break;
      bad.nextRetryAt = Date.now() - 1;
      q.start();
      await new Promise((r) => setTimeout(r, 60));

      // Simulate the backend recovering for an UNRELATED conversation: enqueue an
      // "ok" op, let it succeed, which fires collapseBackoffOnRecovery over the
      // still-parked bad op. Under the old code this reset bad.attempts to 0.
      okShouldSucceed = true;
      q.add("addMessages", { conversationId: `ok${round}`, messages: [{ messageUuid: `o${round}` }] });
      q.getPendingOperations()
        .filter((o) => String(o.params.conversationId).startsWith("ok"))
        .forEach((o) => { o.nextRetryAt = Date.now() - 1; });
      q.start();
      await new Promise((r) => setTimeout(r, 60));
      okShouldSucceed = false;
    }

    // The bad op was dropped at maxAttempts — not pardoned into perpetuity.
    expect(q.hasPendingConversation("bad")).toBe(false);
    expect(logs2.some((l) => l.startsWith("Max retries reached. DROPPED: addMessages"))).toBe(true);
    q.stop();
  });
});
