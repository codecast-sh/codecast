import { describe, expect, test } from "bun:test";
import { performNeedsInputCheck } from "./notifications";
import { settledIdleWorld, type Rec } from "./notifications.needsInput.testkit";

// A child stands down while it answers to its parent. Once a person takes it
// over (parent_released_at) it is theirs, heard like any session they own:
// neither child stand-down holds it, with the owners model or without. The
// web chime mirrors this (inboxStore isSub).
describe("needs-input push for a child a person took over", () => {
  const check = async (conv: Rec) => {
    const { ctx, tables } = settledIdleWorld({ conv });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    return { res, sent: tables.notifications.length };
  };

  test.each([
    ["subagent", { is_subagent: true, parent_conversation_id: "convP" }],
    ["subagent", { parent_conversation_id: "convP", parent_message_uuid: "plan-handoff" }],
    ["agent_spawned", { spawned_by_conversation_id: "convP" }],
  ] as Array<[string, Rec]>)("a child that answers to its parent stands down as %s", async (reason, conv) => {
    const { res, sent } = await check(conv);
    expect([res.notified, res.reason, sent]).toEqual([false, reason, 0]);
  });

  test.each([
    ["a Task subagent", { is_subagent: true, parent_conversation_id: "convP" }],
    ["a plan handoff", { parent_conversation_id: "convP", parent_message_uuid: "plan-handoff" }],
    ["a spawned worker", { is_subagent: true, parent_conversation_id: "convP", spawned_by_conversation_id: "convP" }],
    ["a workflow station", { is_subagent: true, is_workflow_sub: true, parent_conversation_id: "convP" }],
  ] as Array<[string, Rec]>)("%s a person released is heard", async (_label, conv) => {
    const { res, sent } = await check({ ...conv, parent_released_at: 1 });
    expect([res.notified, sent]).toEqual([true, 1]);
  });
});
