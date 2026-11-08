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

  it("carries a denial's reason and an always-allow to the server call", () => {
    useInboxStore.getState().syncTable("pendingPermissions", [perm(P1), perm(P2)], permOpts as any);
    useInboxStore.getState().resolvePermission(P1, "denied", { message: "run one file" });
    useInboxStore.getState().resolvePermission(P2, "approved", { remember: true });
    expect(calls.map((c) => [c.action, c.args])).toEqual([
      ["resolvePermission", [P1, "denied", { message: "run one file" }]],
      ["resolvePermission", [P2, "approved", { remember: true }]],
    ]);
  });

  it("an always-allow leaves the session's other cards to the server, which holds every rule", () => {
    const ask = (id: string, command: string, always: string) => ({ ...perm(id), session_id: "s1", rule_request: { permission: "bash", patterns: [command], always: [always] } });
    const P3 = "jx7perm00000000000000000000000p3";
    useInboxStore.getState().syncTable("pendingPermissions", [ask(P1, "npm run build", "npm run build *"), ask(P2, "npm run build --prod", "npm run build *"), ask(P3, "npm run deploy", "npm run deploy *")], permOpts as any);
    useInboxStore.getState().resolvePermission(P1, "approved", { remember: true });
    const rows = (useInboxStore.getState() as any).pendingPermissions;
    expect(rows[P2]).toBeTruthy();
    expect(rows[P3]).toBeTruthy();
    // The server's snapshot (P2 approved there) prunes it.
    useInboxStore.getState().syncTable("pendingPermissions", [ask(P3, "npm run deploy", "npm run deploy *")], permOpts as any);
    expect((useInboxStore.getState() as any).pendingPermissions[P2]).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("a denial with a reason drops the session's other cards", () => {
    const ask = (id: string) => ({ ...perm(id), session_id: "s1" });
    useInboxStore.getState().syncTable("pendingPermissions", [ask(P1), ask(P2)], permOpts as any);
    useInboxStore.getState().resolvePermission(P1, "denied", { message: "not now" });
    expect((useInboxStore.getState() as any).pendingPermissions[P2]).toBeUndefined();
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
