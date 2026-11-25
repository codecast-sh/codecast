import { describe, expect, test } from "bun:test";
import { isClaudeSubagentSessionId } from "./claudeSubagentSession";

// 2026-10-07: a manual `cast sync` re-uploaded old subagent transcripts without
// parent detection and 44 `agent-*` rows landed in the founder's inbox; three
// warmup sidechains (`agent-<7 hex>`) sat in another user's. The id alone says
// subagent, so createConversation marks it whatever the client sent.
describe("isClaudeSubagentSessionId", () => {
  test("Task, workflow and warmup agent ids are subagents", () => {
    expect(isClaudeSubagentSessionId("agent-ae0d985f954e4fea1")).toBe(true);
    expect(isClaudeSubagentSessionId("agent-a46135edbb63ec7de")).toBe(true);
    expect(isClaudeSubagentSessionId("agent-a54937f")).toBe(true);
  });

  test("top-level sessions and other agent-* names are not", () => {
    expect(isClaudeSubagentSessionId("6d422b09-d280-4e73-9c4b-53b8bf428a3e")).toBe(false);
    expect(isClaudeSubagentSessionId("agent-averify-bugs-7-9-06a0cd0a0f0da259")).toBe(false);
    expect(isClaudeSubagentSessionId("wf-th7068m95vdc3c0mmhyxsx26zh8fvqaf")).toBe(false);
  });
});
