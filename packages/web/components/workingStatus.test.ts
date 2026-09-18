import { test, expect, describe } from "bun:test";
import {
  formatElapsedClock,
  shouldShowElapsed,
  deriveRunningTool,
  deriveRunningPhrase,
  shouldShowIdleGap,
  workingSinceForClock,
  isProducingAgentStatus,
  WORKING_ELAPSED_GRACE_MS,
  IDLE_GAP_MS,
} from "./workingStatus";

describe("formatElapsedClock", () => {
  test("m:ss under an hour, zero-padded seconds", () => {
    expect(formatElapsedClock(0)).toBe("0:00");
    expect(formatElapsedClock(5_000)).toBe("0:05");
    expect(formatElapsedClock(74_000)).toBe("1:14");
    expect(formatElapsedClock(134_000)).toBe("2:14");
    expect(formatElapsedClock(599_000)).toBe("9:59");
  });

  test("h:mm:ss at and past an hour, zero-padded minutes", () => {
    expect(formatElapsedClock(3_600_000)).toBe("1:00:00");
    expect(formatElapsedClock(3_725_000)).toBe("1:02:05");
    expect(formatElapsedClock(7_384_000)).toBe("2:03:04");
  });

  test("never renders negative time (clock skew floors at 0)", () => {
    expect(formatElapsedClock(-5_000)).toBe("0:00");
  });
});

describe("shouldShowElapsed", () => {
  test("hidden before the grace, shown at/after it", () => {
    const start = 1_000_000;
    expect(shouldShowElapsed(start, start)).toBe(false);
    expect(shouldShowElapsed(start, start + WORKING_ELAPSED_GRACE_MS - 1)).toBe(false);
    expect(shouldShowElapsed(start, start + WORKING_ELAPSED_GRACE_MS)).toBe(true);
    expect(shouldShowElapsed(start, start + 5 * 60_000)).toBe(true);
  });

  test("undefined start never shows (no anchor to count from)", () => {
    expect(shouldShowElapsed(undefined, 1_000_000)).toBe(false);
  });
});

describe("deriveRunningTool", () => {
  const asstWithTools = (...names: string[]) => ({
    type: "message",
    data: { role: "assistant", tool_calls: names.map((name) => ({ name })) },
  });
  const asstText = { type: "message", data: { role: "assistant", tool_calls: [] } };
  const user = { type: "message", data: { role: "user" } };
  const system = { type: "message", data: { role: "system" } };

  test("tail assistant with an unanswered tool call → that tool is running", () => {
    expect(deriveRunningTool([user, asstWithTools("Bash")])).toBe("Bash");
  });

  test("multiple tool calls in the tail message → the last one", () => {
    expect(deriveRunningTool([asstWithTools("Read", "Edit", "Bash")])).toBe("Bash");
  });

  test("tail is a user message (tool result already landed) → nothing running", () => {
    expect(deriveRunningTool([asstWithTools("Bash"), user])).toBeUndefined();
  });

  test("tail assistant is pure text (a long generation) → nothing running", () => {
    expect(deriveRunningTool([asstText])).toBeUndefined();
  });

  test("trailing system messages are skipped, not treated as the end", () => {
    expect(deriveRunningTool([asstWithTools("Bash"), system])).toBe("Bash");
  });

  test("non-message timeline items (dividers, etc.) are skipped", () => {
    expect(deriveRunningTool([asstWithTools("Bash"), { type: "divider", data: {} }])).toBe("Bash");
  });

  test("empty timeline → undefined", () => {
    expect(deriveRunningTool([])).toBeUndefined();
  });
});

// The composer's fallback phrase, when the row's server side activity stamp is
// absent or stale: the same present tense line the inbox card shows, from the
// same shared phrase library, so one tool is never named two ways.
describe("deriveRunningPhrase", () => {
  const asst = (...tool_calls: Array<{ name: string; input: unknown }>) => ({
    type: "message",
    data: { role: "assistant", tool_calls: tool_calls.map((tc) => ({ name: tc.name, input: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input) })) },
  });
  const user = { type: "message", data: { role: "user" } };

  test("names the running tool's subject in present tense, matching the inbox card", () => {
    expect(deriveRunningPhrase([user, asst({ name: "Edit", input: { file_path: "/Users/me/src/app/chat.ts" } })])).toBe("editing app/chat.ts");
    expect(deriveRunningPhrase([asst({ name: "Bash", input: { command: "cd repo && npx tsc --noEmit" } })])).toBe("running npx tsc");
    expect(deriveRunningPhrase([asst({ name: "Grep", input: { pattern: "wakeSig" } })])).toBe("searching for wakeSig");
    expect(deriveRunningPhrase([asst({ name: "AskUserQuestion", input: {} })])).toBe("asking a question");
  });

  test("the last call of the tail message is the one in flight", () => {
    expect(deriveRunningPhrase([asst({ name: "Read", input: { file_path: "/x/a.ts" } }, { name: "Bash", input: { command: "bun test" } })])).toBe("running bun test");
  });

  test("a call with no phrase falls back to the tool's display name", () => {
    expect(deriveRunningPhrase([asst({ name: "Bash", input: "{bad" })])).toBe("Bash");
  });

  test("tool result already landed, or nothing loaded: nothing in flight", () => {
    expect(deriveRunningPhrase([asst({ name: "Bash", input: { command: "ls" } }), user])).toBeUndefined();
    expect(deriveRunningPhrase([])).toBeUndefined();
  });
});

describe("isProducingAgentStatus", () => {
  test("working / thinking / compacting are producing; idle and absent are not", () => {
    expect(isProducingAgentStatus("working")).toBe(true);
    expect(isProducingAgentStatus("thinking")).toBe(true);
    expect(isProducingAgentStatus("compacting")).toBe(true);
    expect(isProducingAgentStatus("idle")).toBe(false);
    expect(isProducingAgentStatus("connected")).toBe(false);
    expect(isProducingAgentStatus(undefined)).toBe(false);
    expect(isProducingAgentStatus(null)).toBe(false);
  });
});

describe("shouldShowIdleGap", () => {
  const now = 10_000_000;
  const recent = now - 60_000;
  const stale = now - 3 * 86_400_000;

  test("hidden while the last activity is still inside the gap", () => {
    expect(shouldShowIdleGap({ lastActivityAt: recent, now, hasMoreBelow: false })).toBe(false);
  });

  test("shown when the loaded tail has been quiet past the gap", () => {
    expect(shouldShowIdleGap({ lastActivityAt: stale, now, hasMoreBelow: false })).toBe(true);
    expect(shouldShowIdleGap({ lastActivityAt: now - IDLE_GAP_MS, now, hasMoreBelow: false })).toBe(false);
    expect(shouldShowIdleGap({ lastActivityAt: now - IDLE_GAP_MS - 1, now, hasMoreBelow: false })).toBe(true);
  });

  test("hidden while more transcript sits below (deep-link window)", () => {
    expect(shouldShowIdleGap({ lastActivityAt: stale, now, hasMoreBelow: true })).toBe(false);
  });

  test("hidden while the agent is mid-turn even if the last loaded row is days old", () => {
    expect(shouldShowIdleGap({ lastActivityAt: stale, now, hasMoreBelow: false, agentStatus: "working" })).toBe(false);
    expect(shouldShowIdleGap({ lastActivityAt: stale, now, hasMoreBelow: false, agentStatus: "thinking" })).toBe(false);
    expect(shouldShowIdleGap({ lastActivityAt: stale, now, hasMoreBelow: false, agentStatus: "compacting" })).toBe(false);
    expect(shouldShowIdleGap({ lastActivityAt: stale, now, hasMoreBelow: false, agentStatus: "idle" })).toBe(true);
  });
});

describe("workingSinceForClock", () => {
  const now = 10_000_000;

  test("passes through a recent last-activity stamp", () => {
    expect(workingSinceForClock(now - 30_000, now)).toBe(now - 30_000);
  });

  test("drops a days-old stamp so Working does not clock from three days ago", () => {
    expect(workingSinceForClock(now - 3 * 86_400_000, now)).toBeUndefined();
    expect(workingSinceForClock(now - IDLE_GAP_MS - 1, now)).toBeUndefined();
  });

  test("undefined / zero have no clock", () => {
    expect(workingSinceForClock(undefined, now)).toBeUndefined();
    expect(workingSinceForClock(0, now)).toBeUndefined();
  });
});
