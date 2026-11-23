import { describe, expect, test } from "bun:test";
import { isConversationRetired } from "./daemon.js";
import { SyncService, resetLifecycleQueryLatch } from "./syncService.js";
import type { ConversationLifecycle } from "./syncService.js";

// A CLOSED conversation (the person's Close) is not retired, but the daemon
// never brings it back on its own: only a message or trigger reaching it does.
const authoritative = (over: Partial<ConversationLifecycle> = {}): ConversationLifecycle =>
  ({ status: "active", hideStateKnown: true, source: "lifecycle", ...over });
const degraded = (over: Partial<ConversationLifecycle> = {}): ConversationLifecycle =>
  ({ status: "active", hideStateKnown: false, source: "status-fallback", ...over });
const TRUSTING = { trustStatusFallback: true };
const STRICT = { trustStatusFallback: false };

describe("a closed conversation and the daemon's retired gate", () => {
  test("a closed conversation is not brought back on its own", () => {
    // The server reports `closed` only for the person's Close, and only while
    // no message waits for it (a waiting message is a wake, never held back).
    expect(isConversationRetired(authoritative({ inboxDismissedAt: 1, closed: true }), STRICT)).toBe(true);
    expect(isConversationRetired(authoritative({ inboxDismissedAt: 1, closed: false }), STRICT)).toBe(false);
  });

  test("a closed session read through the status-only fallback is not brought back by heartbeat reconstitution", () => {
    expect(isConversationRetired(degraded({ status: "active", closed: true }), TRUSTING)).toBe(true);
    // Every other path still refuses to act on the degraded read either way.
    expect(isConversationRetired(degraded({ status: "active", closed: true }), STRICT)).toBe(false);
  });

  test("the devices fallback carries a close, so a degraded read never revives a closed session", async () => {
    resetLifecycleQueryLatch();
    const svc = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    (svc as any).client = {
      query: async (name: string) => {
        if (name === "conversations:getConversationLifecycle") throw new Error("connect ECONNREFUSED 127.0.0.1:443");
        return { status: "active", closed: true };
      },
    };
    const got = await svc.getConversationLifecycle("conv-1", "sess-1");
    expect(got).toMatchObject({ status: "active", closed: true, source: "status-fallback" });
    expect(isConversationRetired(got, TRUSTING)).toBe(true);
  });
});
