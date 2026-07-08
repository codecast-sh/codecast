import { describe, expect, test } from "bun:test";
import { extractPendingToolUseFromTail } from "./daemon.js";

// Regression: a completed tool must never be reported as a pending permission.
//
// Claude Code buffers the AskUserQuestion tool_use and doesn't flush it to the
// session JSONL until it's answered. So while a session waits on a question, the
// newest tool_use *physically present* in the transcript is the previous,
// already-resolved Read/Bash. The daemon scans the tail to label the
// permission_blocked it received; the old code returned that finished tool,
// spawning a phantom Approve/Deny footer in the web UI for a Read that already
// completed (real incident: cli/page.tsx Read sat "pending" ~13min while the
// session was actually parked on an AskUserQuestion).
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>) {
  return line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
}

function userToolResult(toolUseId: string) {
  return line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] } });
}

describe("extractPendingToolUseFromTail", () => {
  test("returns null when the newest tool_use already completed (buffered AskUserQuestion case)", () => {
    // Read completed; AskUserQuestion tool_use is buffered (not in the transcript yet).
    const tail = [
      assistantToolUse("toolu_read", "Read", { file_path: "/repo/packages/web/app/settings/cli/page.tsx" }),
      userToolResult("toolu_read"),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I've read it end-to-end" }] } }),
    ].join("\n");

    expect(extractPendingToolUseFromTail(tail)).toBeNull();
  });

  test("returns the tool_use when it is genuinely pending (no tool_result yet)", () => {
    const tail = [
      assistantToolUse("toolu_a", "Read", { file_path: "/repo/a.ts" }),
      userToolResult("toolu_a"),
      assistantToolUse("toolu_bash", "Bash", { command: "rm -rf build", description: "Clean build" }),
    ].join("\n");

    const pending = extractPendingToolUseFromTail(tail);
    expect(pending?.tool_name).toBe("Bash");
    expect(pending?.arguments_preview).toContain("rm -rf build");
    expect(pending?.arguments_preview).toContain("Clean build");
  });

  test("ignores a completed trailing tool even when an earlier tool is also completed", () => {
    const tail = [
      assistantToolUse("toolu_1", "Read", { file_path: "/repo/http.ts" }),
      userToolResult("toolu_1"),
      assistantToolUse("toolu_2", "Read", { file_path: "/repo/page.tsx" }),
      userToolResult("toolu_2"),
    ].join("\n");

    expect(extractPendingToolUseFromTail(tail)).toBeNull();
  });

  test("returns null for an empty transcript", () => {
    expect(extractPendingToolUseFromTail("")).toBeNull();
  });
});
