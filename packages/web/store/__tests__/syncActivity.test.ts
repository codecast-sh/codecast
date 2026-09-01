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
import { INBOX_FACT_FIELDS } from "@codecast/shared/contracts";

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
  it("syncTable on sessions and sessionDecisions bumps the apply sequence when a row changed", () => {
    expect(lastSyncApplyMono()).toBe(Number.NEGATIVE_INFINITY);
    useInboxStore.getState().syncTable("sessions", [{ _id: A, session_id: "s", agent_type: "claude_code", updated_at: 1 } as InboxSession]);
    expect(syncApplySeq()).toBe(1);
    expect(Number.isFinite(lastSyncApplyMono())).toBe(true);
    useInboxStore.getState().syncTable("sessionDecisions", [{ _id: "d".repeat(32), conversation_id: A, status: "pending", created_at: 1 }]);
    expect(syncApplySeq()).toBe(2);
  });

  it("a value-identical re-push is not catch-up: it leaves the clock alone", () => {
    // A busy account re-emits the sessions window every few seconds (liveness
    // heartbeats re-run the query); the facts ride the overlay, so the base
    // channel's rows are byte-identical. Stamping those kept the compare gated
    // on not_quiescent forever.
    const row = { _id: A, session_id: "s", agent_type: "claude_code", status: "active", title: "t" } as InboxSession;
    useInboxStore.getState().syncTable("sessions", [row]);
    expect(syncApplySeq()).toBe(1);
    useInboxStore.getState().syncTable("sessions", [{ ...row }]);
    useInboxStore.getState().syncTable("sessions", [{ ...row }]);
    expect(syncApplySeq()).toBe(1);
    // An empty push on an empty collection is a no-op too.
    useInboxStore.getState().syncTable("sessionDecisions", []);
    expect(syncApplySeq()).toBe(1);
    // A real field change stamps again.
    useInboxStore.getState().syncTable("sessions", [{ ...row, title: "renamed" }]);
    expect(syncApplySeq()).toBe(2);
  });

  it("a heartbeat re-push of the base channel (facts null, overlay owns them) leaves the clock alone", () => {
    const row = { _id: A, session_id: "s", agent_type: "claude_code", status: "active", title: "t" } as InboxSession;
    useInboxStore.getState().syncTable("sessions", [row]);
    useInboxStore.getState().applyInboxLivenessPayload("mine", {
      liveness: { [A]: { agent_status: "working", is_idle: false, updated_at: 5, message_count: 3 } },
      projection: { v: 2, epoch: 60_000, tally: null, set_digest: null, truncated: [] },
    } as any);
    const seq = syncApplySeq();
    // The base channel re-emits with the facts blank (server strips them).
    const stripped: any = { ...row };
    for (const f of INBOX_FACT_FIELDS) stripped[f] = null; // stripInboxLiveness, server side
    useInboxStore.getState().syncTable("sessions", [stripped]);
    expect(syncApplySeq()).toBe(seq);
    expect((useInboxStore.getState().sessions[A] as any).updated_at).toBe(5);
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
