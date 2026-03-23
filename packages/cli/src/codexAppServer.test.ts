import { describe, expect, test } from "bun:test";
import { approvalResultForMethod, threadItemsToMessages } from "./codexAppServer.js";

describe("approvalResultForMethod", () => {
  test("returns a decision for command execution approvals", () => {
    expect(approvalResultForMethod("item/commandExecution/requestApproval", true)).toEqual({
      decision: "accept",
    });
    expect(approvalResultForMethod("item/commandExecution/requestApproval", false)).toEqual({
      decision: "decline",
    });
  });

  test("echoes requested permissions for permission approvals", () => {
    expect(
      approvalResultForMethod("item/permissions/requestApproval", true, {
        permissions: { workspaceWrite: true, network: false },
      }),
    ).toEqual({
      permissions: { workspaceWrite: true, network: false },
      scope: "session",
    });
  });
});

describe("threadItemsToMessages", () => {
  test("keeps a stable assistant uuid as a turn grows", () => {
    const items = [
      { type: "agentMessage", id: "msg-1", text: "Tracing the existing flow.", phase: "commentary" },
      { type: "plan", id: "plan-1", text: "1. Read code\n2. Patch daemon" },
      {
        type: "commandExecution",
        id: "cmd-1",
        command: "rg foo",
        cwd: "/tmp",
        status: "completed",
        aggregatedOutput: "match",
      },
      { type: "agentMessage", id: "msg-2", text: "Patch is in progress.", phase: "commentary" },
    ] as any[];

    const messages = threadItemsToMessages(items);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.uuid).toBe("msg-1");
    expect(messages[0]?.content).toContain("Tracing the existing flow.");
    expect(messages[0]?.content).toContain("Patch is in progress.");
    expect(messages[0]?.toolCalls?.[0]?.id).toBe("cmd-1");
    expect(messages[0]?.toolResults?.[0]?.toolUseId).toBe("cmd-1");
  });
});
