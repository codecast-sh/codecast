import { describe, expect, it } from "bun:test";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { isAssistantTask } from "../assistantScope";

describe("isAssistantTask", () => {
  it("keeps the person's own errands and what the assistant added", () => {
    expect(isAssistantTask({})).toBe(true);
    expect(isAssistantTask({ created_from_conversation: "c1", source_agent_type: HOSTED_AGENT_TYPE })).toBe(true);
  });
  it("leaves out to-dos coding work filed", () => {
    expect(isAssistantTask({ project_id: "p1" })).toBe(false);
    expect(isAssistantTask({ plan_id: "pl" })).toBe(false);
    expect(isAssistantTask({ created_from_conversation: "c1", source_agent_type: "claude_code" })).toBe(false);
    expect(isAssistantTask({ conversation_ids: ["c2"] })).toBe(false);
  });
});
