import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";
import {
  __resetSyncActivityForTests,
  beginSyncInflight,
  lastSyncApplyMono,
  syncApplySeq,
  syncInflightCount,
} from "../syncActivity";
import { createRecoveryController } from "../../hooks/useRecoveryPoll";

// The quiescence inputs of the digest compare (sync-convergence C6 gate 4):
// row-channel applies stamp the activity clock, catch-up operations count as
// in flight while they run. Both are read by evaluateInboxCompare; this pins
// the writers.

const A = "a".repeat(32);

beforeEach(() => {
  __resetSyncActivityForTests();
  useInboxStore.setState({ sessions: {}, sessionDecisions: {}, currentUser: null } as any);
});

describe("row applies stamp the activity clock", () => {
  it("syncTable on sessions and sessionDecisions bumps the apply sequence", () => {
    expect(lastSyncApplyMono()).toBe(Number.NEGATIVE_INFINITY);
    useInboxStore.getState().syncTable("sessions", [{ _id: A, session_id: "s", agent_type: "claude_code", updated_at: 1 } as InboxSession]);
    expect(syncApplySeq()).toBe(1);
    expect(Number.isFinite(lastSyncApplyMono())).toBe(true);
    useInboxStore.getState().syncTable("sessionDecisions", []);
    expect(syncApplySeq()).toBe(2);
  });

  it("the user doc and other churn channels do not count as catch-up", () => {
    useInboxStore.getState().syncTable("currentUser", { _id: "u".repeat(32), name: "me" });
    expect(syncApplySeq()).toBe(0);
  });
});

describe("in-flight catch-up operations", () => {
  it("beginSyncInflight counts until released, and a release is idempotent", () => {
    const a = beginSyncInflight("range");
    const b = beginSyncInflight("crawl");
    expect(syncInflightCount()).toBe(2);
    a();
    a();
    expect(syncInflightCount()).toBe(1);
    b();
    expect(syncInflightCount()).toBe(0);
  });

  it("a recovery poll is in flight for exactly the duration of its fetch", async () => {
    let resolveFetch: () => void = () => {};
    const c = createRecoveryController({
      getLastSync: () => 0,
      staleMs: 1,
      now: () => 10_000,
      fetchAndApply: () => new Promise<void>((r) => { resolveFetch = r; }),
    });
    const p = c.tick();
    expect(syncInflightCount()).toBe(1);
    resolveFetch();
    await p;
    expect(syncInflightCount()).toBe(0);
  });
});
