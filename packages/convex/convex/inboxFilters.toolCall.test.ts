import { describe, expect, test } from "bun:test";
import { openToolCallAt, subagentIsProducing, SUBAGENT_TOOL_CALL_CAP_MS } from "./inboxFilters";

const NOW = 10_000_000;

// A verifier inside one long test run syncs nothing until the call returns.
test("an open tool call keeps a quiet subagent producing, up to the cap", () => {
  const quiet = { isSubagent: true, convStatus: "active", updatedAt: NOW - 30 * 60 * 1000, isLive: false, agentStatus: undefined, now: NOW };
  expect(subagentIsProducing({ ...quiet, toolCallOpenAt: NOW - 12 * 60 * 1000 })).toBe(true);
  expect(subagentIsProducing({ ...quiet, toolCallOpenAt: NOW - (SUBAGENT_TOOL_CALL_CAP_MS + 1_000) })).toBe(false);
  expect(subagentIsProducing({ ...quiet, convStatus: "completed", toolCallOpenAt: NOW - 60_000 })).toBe(false);
});

test("a live child that reported settling is not producing, whatever it synced a minute ago", () => {
  const fresh = { isSubagent: true, convStatus: "active", updatedAt: NOW - 60_000, isLive: true, now: NOW };
  expect(subagentIsProducing({ ...fresh, reportedStatus: "dormant", agentStatus: "dormant" })).toBe(false);
  expect(subagentIsProducing({ ...fresh, reportedStatus: "idle", agentStatus: "idle", toolCallOpenAt: NOW - 60_000 })).toBe(false);
  // A reported "working" the trust rule decayed to idle is still a child at work.
  expect(subagentIsProducing({ ...fresh, updatedAt: NOW - 15 * 60_000, reportedStatus: "working", agentStatus: "idle", toolCallOpenAt: NOW - 15 * 60_000 })).toBe(true);
});

describe("openToolCallAt", () => {
  test("the newest message is the call itself: open", () => {
    expect(openToolCallAt({ last_message_role: "assistant", activity: { at: 500 }, updated_at: 500 })).toBe(500);
  });
  test("anything synced after the call (its result, a reply) closes it", () => {
    expect(openToolCallAt({ last_message_role: "user", activity: { at: 500 }, updated_at: 900 })).toBeNull();
    expect(openToolCallAt({ last_message_role: "assistant", activity: { at: 500 }, updated_at: 900 })).toBeNull();
  });
  test("no call stamped: none open", () => {
    expect(openToolCallAt({ last_message_role: "assistant", activity: null, updated_at: 900 })).toBeNull();
  });
});
