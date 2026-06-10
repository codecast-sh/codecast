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
  test("preserves live codex text/tool/text ordering for streamed items", () => {
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

    expect(messages).toHaveLength(3);
    expect(messages[0]?.uuid).toBe("msg-1");
    expect(messages[0]?.content).toContain("Tracing the existing flow.");
    expect(messages[0]?.content).toContain("1. Read code");
    expect(messages[1]?.uuid).toBe("cmd-1");
    expect(messages[1]?.toolCalls?.[0]?.id).toBe("cmd-1");
    expect(messages[1]?.toolResults?.[0]?.toolUseId).toBe("cmd-1");
    expect(messages[2]?.uuid).toBe("msg-2");
    expect(messages[2]?.content).toBe("Patch is in progress.");
    expect(messages[0]!.timestamp).toBeLessThan(messages[1]!.timestamp);
    expect(messages[1]!.timestamp).toBeLessThan(messages[2]!.timestamp);
  });

  // Regression: ct-36429. A `userMessage` item is a turn BOUNDARY in the agent-output
  // stream, not a message source: it flushes any buffered assistant text so the next
  // turn starts a fresh bubble, but is NOT itself emitted here. The user's prompt is
  // recorded durably at DELIVERY time (see buildCodexUserTurnMessage / deliverMessage),
  // mirroring how Claude's JSONL sync records the user turn. Emitting it here too would
  // double-record the prompt if a resumed thread ever replays it. This pins that contract
  // so the boundary-flush isn't "fixed" into a duplicate-producing emit.
  test("treats userMessage as a turn boundary, not a message source", () => {
    const items = [
      { type: "agentMessage", id: "a1", text: "first turn reply", phase: "commentary" },
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "second prompt" }] },
      { type: "agentMessage", id: "a2", text: "second turn reply", phase: "commentary" },
    ] as any[];

    const messages = threadItemsToMessages(items);

    // The userMessage flushes "first turn reply" and opens a fresh bubble for the next
    // reply, but is not itself emitted: two assistant messages, zero user messages.
    expect(messages.map((m) => m.role)).toEqual(["assistant", "assistant"]);
    expect(messages[0]?.content).toBe("first turn reply");
    expect(messages[1]?.content).toBe("second turn reply");
  });
});
