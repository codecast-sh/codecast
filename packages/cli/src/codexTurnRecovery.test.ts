import { describe, expect, test } from "bun:test";
import { codexRecoveryAction, codexResumeParams, recoverCodexTurn, settledCodexRecord, type PersistedCodexThread } from "./codexTurnRecovery.js";
import type { TurnStatus } from "./codexAppServer.js";

const record: PersistedCodexThread = { threadId: "thread", updatedAt: 1, activeTurnId: "turn", cwd: "/project", approvalPolicy: "on-request" };
const thread = (status: TurnStatus) => ({ id: "thread", status: { type: "idle" }, turns: [{ id: "turn", status, items: [] }] });

describe("Codex interrupted turn recovery", () => {
  test.each(["read-only", "workspace-write", "danger-full-access"] as const)("preserves %s across restart", sandbox => {
    const saved = JSON.parse(JSON.stringify({ ...record, sandbox }));
    expect(codexResumeParams(saved, saved.approvalPolicy)).toEqual({ threadId: "thread", cwd: "/project", approvalPolicy: "on-request", sandbox });
    expect(codexResumeParams(settledCodexRecord(saved, "turn"), "never").sandbox).toBe(sandbox);
  });

  test("does not infer unrestricted access from an old never-approve registration", () => {
    expect(codexResumeParams({ ...record, approvalPolicy: "never" }, "never").sandbox).toBeUndefined();
  });

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
