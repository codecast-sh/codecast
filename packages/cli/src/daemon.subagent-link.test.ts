import { describe, expect, test } from "bun:test";
import { resolvePendingSubagentLinks } from "./daemon.js";

describe("resolvePendingSubagentLinks", () => {
  test("parent created last: links a child that is already cached", () => {
    const pending = new Map([["agent-child", "parent-uuid"]]);
    const cache = { "agent-child": "convChild", "parent-uuid": "convParent" };
    expect(resolvePendingSubagentLinks("parent-uuid", "convParent", pending, cache)).toEqual([
      { parentConvId: "convParent", childConvId: "convChild", childSessionId: "agent-child", parentSessionId: "parent-uuid" },
    ]);
  });

  test("parent created while child create still in flight: no link from parent side", () => {
    const pending = new Map([["agent-child", "parent-uuid"]]);
    const cache = { "parent-uuid": "convParent" }; // child not cached yet
    expect(resolvePendingSubagentLinks("parent-uuid", "convParent", pending, cache)).toEqual([]);
  });

  test("regression: child created last links itself to its already-cached parent", () => {
    // jx78ekc: the child was queued first, the parent was created during the
    // child's 68s in-flight createConversation, so the parent-side drain ran
    // before the child was cached and skipped it. When the child finally
    // caches, it must resolve its own pending parent.
    const pending = new Map([["agent-child", "parent-uuid"]]);
    const cache = { "agent-child": "convChild", "parent-uuid": "convParent" };
    expect(resolvePendingSubagentLinks("agent-child", "convChild", pending, cache)).toEqual([
      { parentConvId: "convParent", childConvId: "convChild", childSessionId: "agent-child", parentSessionId: "parent-uuid" },
    ]);
  });

  test("child created but parent still missing: no link", () => {
    const pending = new Map([["agent-child", "parent-uuid"]]);
    const cache = { "agent-child": "convChild" };
    expect(resolvePendingSubagentLinks("agent-child", "convChild", pending, cache)).toEqual([]);
  });

  test("unrelated session creation produces no links", () => {
    const pending = new Map([["agent-child", "parent-uuid"]]);
    const cache = { "agent-child": "convChild", "parent-uuid": "convParent", "other": "convOther" };
    expect(resolvePendingSubagentLinks("other", "convOther", pending, cache)).toEqual([]);
  });
});
