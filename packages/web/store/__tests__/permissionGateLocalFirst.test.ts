import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// Approving a tool permission and answering a workflow gate are presses whose
// result must show on the press: the card leaves, the run reads as running.
// Both collections are localFirst, so a push computed before the write
// committed cannot bring the old state back, and both ride same-named
// dispatch side effects to the real mutations.
const CONV = "jx7conv00000000000000000000000aa";
const P1 = "jx7perm00000000000000000000000p1";
const P2 = "jx7perm00000000000000000000000p2";
const RUN = "jx7run000000000000000000000000r1";

const perm = (id: string) => ({ _id: id, conversation_id: CONV, tool_name: "Bash", status: "pending", created_at: Date.now() });
const run = (status: string) => ({ _id: RUN, workflow_id: "wf", status });
// The feeder's options: each push is the complete pending set for CONV.
const permOpts = { pruneAbsentScope: (row: any) => row?.conversation_id === CONV };

describe("permission and gate answers are local-first", () => {
  const owner = {};
  let calls: Array<{ action: string; args: any[] }>;

  beforeEach(() => {
    calls = [];
    useInboxStore.setState({ pendingPermissions: {}, workflowRuns: {}, questionResolutions: {}, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      return null;
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  it("drops the permission card on the press and dispatches resolvePermission", () => {
    useInboxStore.getState().syncTable("pendingPermissions", [perm(P1), perm(P2)], permOpts as any);
    useInboxStore.getState().resolvePermission(P1, "approved");
    const rows = (useInboxStore.getState() as any).pendingPermissions;
    expect(rows[P1]).toBeUndefined();
    expect(rows[P2]).toBeTruthy();
    expect(calls.map((c) => [c.action, c.args])).toEqual([["resolvePermission", [P1, "approved"]]]);
  });

  it("keeps the card gone when a stale pending push arrives", () => {
    useInboxStore.getState().syncTable("pendingPermissions", [perm(P1)], permOpts as any);
    useInboxStore.getState().resolvePermission(P1, "denied");
    useInboxStore.getState().syncTable("pendingPermissions", [perm(P1)], permOpts as any);
    expect((useInboxStore.getState() as any).pendingPermissions[P1]).toBeUndefined();
  });

  it("marks the session's question resolved only when the last request is answered", () => {
    useInboxStore.getState().syncTable("pendingPermissions", [perm(P1), perm(P2)], permOpts as any);
    useInboxStore.getState().resolvePermission(P1, "approved");
    expect((useInboxStore.getState() as any).questionResolutions[CONV]).toBeUndefined();
    useInboxStore.getState().resolvePermission(P2, "approved");
    expect((useInboxStore.getState() as any).questionResolutions[CONV]).toBeTruthy();
  });

  it("flips a paused run to running on the press and dispatches respondToGate", () => {
    useInboxStore.getState().syncTable("workflowRuns", [run("paused")], { isDelta: true } as any);
    useInboxStore.getState().respondToGate(RUN, "A");
    expect((useInboxStore.getState() as any).workflowRuns[RUN].status).toBe("running");
    expect(calls.map((c) => [c.action, c.args])).toEqual([["respondToGate", [RUN, "A"]]]);
  });

  it("holds running over a stale paused push, then follows the server once it agrees", () => {
    useInboxStore.getState().syncTable("workflowRuns", [run("paused")], { isDelta: true } as any);
    useInboxStore.getState().respondToGate(RUN, "A");
    useInboxStore.getState().syncTable("workflowRuns", [run("paused")], { isDelta: true } as any);
    expect((useInboxStore.getState() as any).workflowRuns[RUN].status).toBe("running");
    useInboxStore.getState().syncTable("workflowRuns", [run("running")], { isDelta: true } as any);
    useInboxStore.getState().syncTable("workflowRuns", [run("completed")], { isDelta: true } as any);
    expect((useInboxStore.getState() as any).workflowRuns[RUN].status).toBe("completed");
  });
});
