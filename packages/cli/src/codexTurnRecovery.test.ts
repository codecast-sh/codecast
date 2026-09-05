import { describe, expect, test } from "bun:test";
import { applyPolicyInPlace, codexRecoveryAction, codexResumeParams, recoverCodexTurn, registerPolicyPersistenceHandlers, settledCodexRecord, type PersistedCodexThread } from "./codexTurnRecovery.js";
import { CodexAppServer, CodexPolicyInvalidationFailed, sandboxResumeParams, type SandboxPolicy, type TurnStatus } from "./codexAppServer.js";

const record: PersistedCodexThread = { threadId: "thread", updatedAt: 1, activeTurnId: "turn", cwd: "/project", approvalPolicy: "on-request" };
const thread = (status: TurnStatus) => ({ id: "thread", status: { type: "idle" }, turns: [{ id: "turn", status, items: [] }] });

describe("Codex interrupted turn recovery", () => {
  test("continues an interrupted turn with persisted intent", async () => {
    let saved = JSON.parse(JSON.stringify(record));
    const requests: unknown[] = [];
    expect(await recoverCodexTurn({
      record: saved,
      thread: thread("interrupted"),
      save: next => { saved = next; },
      start: async input => {
        expect(saved.recoveryAttempts).toBe(1);
        requests.push(input);
        return { turn: { id: "next", status: "inProgress", items: [] } };
      },
    })).toBe("continue");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ threadId: "thread", input: [{ type: "text" }] });
    expect(saved.approvalPolicy).toBe("on-request");
  });

  test.each(["completed", "failed"] as TurnStatus[])("clears stale recovery intent for %s", async status => {
    let saved = record;
    await recoverCodexTurn({ record, thread: thread(status), save: next => { saved = next; }, start: async () => { throw new Error("must not start"); } });
    expect(saved.activeTurnId).toBeUndefined();
  });

  test("never restarts an explicitly stopped turn or a legacy history without intent", () => {
    expect(codexRecoveryAction(settledCodexRecord(record, "turn"), thread("interrupted"))).toBe("none");
    expect(codexRecoveryAction({ threadId: "thread", updatedAt: 1 }, thread("interrupted"))).toBe("none");
  });

  test("an older completion cannot clear a newer active turn", () => {
    expect(settledCodexRecord(record, "older")).toBe(record);
  });

  test("does not replay a turn if a later user turn already exists", () => {
    const snapshot = thread("interrupted");
    snapshot.turns.push({ id: "new-user-turn", status: "completed", items: [] });
    expect(codexRecoveryAction(record, snapshot)).toBe("settled");
  });

  test("never duplicates active work, including an accepted request whose reply timed out", async () => {
    let saved = record;
    await expect(recoverCodexTurn({ record, thread: thread("interrupted"), save: next => { saved = next; }, start: async () => { throw new Error("RPC timed out after acceptance"); } })).rejects.toThrow("timed out");
    expect(saved.activeTurnId).toBe("turn");
    const live = { ...thread("inProgress"), status: { type: "active", activeFlags: ["waitingOnApproval"] } };
    expect(codexRecoveryAction(saved, live)).toBe("active");
  });

  test("bounds repeated failures across daemon restarts", () => {
    expect(codexRecoveryAction({ ...record, recoveryAttempts: 3 }, thread("interrupted"))).toBe("exhausted");
  });

  test("retains intent when history inspection is incomplete", () => {
    expect(() => codexRecoveryAction(record, { id: "thread" })).toThrow("inspect");
    expect(record.activeTurnId).toBe("turn");
  });
});

// Restart preservation. Measured against codex-cli 0.153.3 on a live disposable
// restart (see live-restart-probe): a cold thread/resume naming only
// `workspace-write` came back with empty writableRoots and networkAccess false,
// losing both. The same resume carrying the `config` overrides came back with
// the exact original policy. thread/resume cannot take a SandboxPolicy, so the
// config map is the only channel the protocol offers for the fine-grained values.
describe("Codex restart policy preservation", () => {
  const WORKSPACE: SandboxPolicy = {
    type: "workspaceWrite", writableRoots: ["/Users/x/proj", "/tmp/extra"], networkAccess: true,
    excludeTmpdirEnvVar: false, excludeSlashTmp: true,
  };

  // Every field fails closed. An absent exclude flag must mean "exclude": the
  // opposite default would hand back a writable /tmp or $TMPDIR the recorded
  // policy never granted.
  test("malformed or absent workspace fields fail closed", () => {
    const partial = { type: "workspaceWrite" } as unknown as SandboxPolicy;
    expect(sandboxResumeParams(partial)).toEqual({
      sandbox: "workspace-write",
      config: {
        "sandbox_workspace_write.writable_roots": [],
        "sandbox_workspace_write.network_access": false,
        "sandbox_workspace_write.exclude_tmpdir_env_var": true,
        "sandbox_workspace_write.exclude_slash_tmp": true,
      },
    });
  });

  test("a non-array roots field does not become a broader grant", () => {
    const junk = { type: "workspaceWrite", writableRoots: "/etc" } as unknown as SandboxPolicy;
    const out = sandboxResumeParams(junk);
    expect(out.config?.["sandbox_workspace_write.writable_roots"]).toEqual([]);
  });

  // KNOWN GAP, reported rather than papered over: readOnly carries networkAccess
  // but thread/resume has no channel to restore it, so a read-only thread that
  // had network comes back without it. Narrower, never broader.
  test("read-only network access is not preserved, and fails closed", () => {
    expect(sandboxResumeParams({ type: "readOnly", networkAccess: true })).toEqual({ sandbox: "read-only" });
    expect(sandboxResumeParams({ type: "readOnly", networkAccess: false })).toEqual({ sandbox: "read-only" });
  });

  test("workspace-write roots and network are carried through config", () => {
    expect(sandboxResumeParams(WORKSPACE)).toEqual({
      sandbox: "workspace-write",
      config: {
        "sandbox_workspace_write.writable_roots": ["/Users/x/proj", "/tmp/extra"],
        "sandbox_workspace_write.network_access": true,
        "sandbox_workspace_write.exclude_tmpdir_env_var": false,
        "sandbox_workspace_write.exclude_slash_tmp": true,
      },
    });
  });

  test("the coarse modes need no config", () => {
    expect(sandboxResumeParams({ type: "dangerFullAccess" })).toEqual({ sandbox: "danger-full-access" });
    expect(sandboxResumeParams({ type: "readOnly", networkAccess: false })).toEqual({ sandbox: "read-only" });
  });

  // NEGATIVE CONTROL for the old behaviour: a record with no recorded policy
  // must not acquire one. The previous code derived a full-access sandbox from
  // approvalPolicy "never", which widened any thread that was really restricted.
  test("an unknown prior sandbox stays unspecified rather than guessed", () => {
    expect(sandboxResumeParams(undefined)).toEqual({});
    expect(sandboxResumeParams(null)).toEqual({});
    const legacy: PersistedCodexThread = { threadId: "t", updatedAt: 1, cwd: "/p", approvalPolicy: "never" };
    const params = codexResumeParams(legacy, "never");
    expect(params.sandbox).toBeUndefined();
    expect((params as { config?: unknown }).config).toBeUndefined();
  });

  test("externalSandbox is not reproduced, since the protocol cannot express it", () => {
    expect(sandboxResumeParams({ type: "externalSandbox", networkAccess: "enabled" })).toEqual({});
  });

  test("a recorded policy restores the thread exactly on resume", () => {
    const saved: PersistedCodexThread = { threadId: "t", updatedAt: 1, cwd: "/p", approvalPolicy: "never", sandboxPolicy: WORKSPACE };
    const params = codexResumeParams(saved, "never");
    expect(params.sandbox).toBe("workspace-write");
    expect((params as { config?: Record<string, unknown> }).config?.["sandbox_workspace_write.writable_roots"])
      .toEqual(["/Users/x/proj", "/tmp/extra"]);
    expect((params as { config?: Record<string, unknown> }).config?.["sandbox_workspace_write.network_access"]).toBe(true);
  });


});

// Daemon integration regression. A policy refresh must not replace the record:
// the rehydrate loop captures a record and re-checks it by identity to detect
// that another path replaced the conversation's work, so replacing it here made
// our own refresh look like a real replacement and aborted a recovery that had
// just succeeded. A cold restart has empty live maps, the callbacks no-op, and
// identity survives, which is why only the already-registered path broke.
describe("a policy refresh leaves the lifecycle record in place", () => {
  const RESOLVED: SandboxPolicy = { type: "dangerFullAccess" };

  // Socket-free stand-in for the daemon's live and persisted maps, using the
  // production handler wiring and the production in-place update.
  const harness = (registered: boolean) => {
    const conversationId = "conv-1";
    const captured: PersistedCodexThread = {
      threadId: "thread-1", updatedAt: 1, cwd: "/p", approvalPolicy: "never", activeTurnId: "turn-1",
    };
    const live = new Map<string, string>(registered ? [["thread-1", conversationId]] : []);
    const persisted = new Map<string, PersistedCodexThread>([[conversationId, captured]]);

    const client = new CodexAppServer({ log: () => {} });
    (client as any).sendRequest = async (_m: string, p: any) =>
      ({ thread: { id: p.threadId }, model: "gpt-test", sandbox: RESOLVED });

    registerPolicyPersistenceHandlers({
      client,
      conversationForThread: (threadId) => live.get(threadId),
      // Mirrors persistThreadPolicyOnly: update in place, never replace.
      persist: (convId, threadId) => {
        applyPolicyInPlace(persisted.get(convId), threadId, client.policyForThread(threadId));
        return true;
      },
    });
    return { client, captured, persisted, conversationId };
  };

  test("an already-registered interrupted thread keeps its record identity", async () => {
    const { client, captured, persisted, conversationId } = harness(true);
    await client.threadResume({ threadId: "thread-1", cwd: "/p" });
    // The callbacks ran, so the policy is refreshed...
    expect(captured.sandboxPolicy).toEqual(RESOLVED);
    // ...and the lifecycle fields and the object itself are untouched, so the
    // rehydrate loop's identity guard still passes and recovery proceeds.
    expect(persisted.get(conversationId)).toBe(captured);
    expect(captured.activeTurnId).toBe("turn-1");
    expect(captured.cwd).toBe("/p");
  });

  test("a cold restart with empty live maps is unaffected", async () => {
    const { client, captured, persisted, conversationId } = harness(false);
    await client.threadResume({ threadId: "thread-1", cwd: "/p" });
    expect(persisted.get(conversationId)).toBe(captured);
  });

  // NEGATIVE CONTROL: a genuine replacement must still abort, including one that
  // keeps the same threadId while changing the work it describes.
  test("a same-thread lifecycle replacement is still detected", () => {
    const captured: PersistedCodexThread = { threadId: "thread-1", updatedAt: 1, activeTurnId: "turn-1" };
    const persisted = new Map<string, PersistedCodexThread>([["conv-1", captured]]);
    // What a lifecycle write does: a NEW record, same thread, different work.
    persisted.set("conv-1", { threadId: "thread-1", updatedAt: 2, activeTurnId: "turn-2" });
    expect(persisted.get("conv-1")).not.toBe(captured);
  });

  test("an in-place update refuses a record belonging to another thread", () => {
    const other: PersistedCodexThread = { threadId: "thread-2", updatedAt: 1 };
    expect(applyPolicyInPlace(other, "thread-1", RESOLVED)).toBe(false);
    expect(other.sandboxPolicy).toBeUndefined();
    expect(applyPolicyInPlace(undefined, "thread-1", RESOLVED)).toBe(false);
  });
});

// The invalidation is a durability BARRIER. persistAppServerThreadRegistrations
// used to swallow write and rename errors, so a narrowing could go on the socket
// while the on-disk record still authorized the old broader policy: crash there
// and the broader one comes back.
describe("policy invalidation is a durability barrier", () => {
  const READONLY: SandboxPolicy = { type: "readOnly", networkAccess: false };

  const barrierHarness = () => {
    const sent: string[] = [];
    const client = new CodexAppServer({ log: () => {} });
    (client as any).sendRequest = async (method: string, p: any) => {
      sent.push(method);
      return method === "turn/start"
        ? { turn: { id: "t", items: [], status: "inProgress" } }
        : { thread: { id: p.threadId ?? "thread-1" }, model: "gpt-test", sandbox: { type: "dangerFullAccess" } };
    };
    let failWrites = false;
    registerPolicyPersistenceHandlers({
      client,
      conversationForThread: () => "conv-1",
      persist: () => !failWrites,
    });
    return { client, sent, fail: () => { failWrites = true; } };
  };

  test("a narrowing is never sent when the old record cannot be cleared", async () => {
    const { client, sent, fail } = barrierHarness();
    await client.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    sent.length = 0;
    fail();
    await expect(client.turnStart({
      threadId: "thread-1", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY,
    })).rejects.toThrow(CodexPolicyInvalidationFailed);
    expect(sent).toEqual([]);                                  // nothing reached the socket
    expect(client.hasPendingPolicyChange("thread-1")).toBe(false);
    expect(client.policyForThread("thread-1")).toBeUndefined(); // and the policy is unknown
  });

  test("a resume is refused the same way", async () => {
    const { client, sent, fail } = barrierHarness();
    await client.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    sent.length = 0;
    fail();
    await expect(client.threadResume({ threadId: "thread-1", cwd: "/p" }))
      .rejects.toThrow(CodexPolicyInvalidationFailed);
    expect(sent).toEqual([]);
  });

  test("a successful clear lets the request through", async () => {
    const { client, sent } = barrierHarness();
    await client.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    sent.length = 0;
    await client.turnStart({ threadId: "thread-1", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY });
    expect(sent).toEqual(["turn/start"]);
    expect(client.policyForThread("thread-1")).toEqual(READONLY);
  });
});
