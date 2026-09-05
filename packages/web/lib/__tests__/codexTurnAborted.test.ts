import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCodexTurnAbortedMessage, isNoiseUserMessage } from "../conversationProcessor";

// Regression: a Codex conversation switched to Claude rendered its earlier
// `<turn_aborted>` notices as ordinary user bubbles, because the renderer only
// treated the tag as an interrupt when the conversation's CURRENT agent_type
// was codex. The tag is unambiguous on its own, so no path may gate it on the
// conversation's agent.
const notice = "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>";

describe("isCodexTurnAbortedMessage", () => {
  test("recognizes the notice from the message alone", () => {
    expect(isCodexTurnAbortedMessage(notice)).toBe(true);
    expect(isCodexTurnAbortedMessage("  " + notice)).toBe(true);
    expect(isCodexTurnAbortedMessage(notice.slice(0, 40))).toBe(true);
    expect(isNoiseUserMessage(notice)).toBe(true);
  });

  test("does not match a person mentioning the tag mid-message", () => {
    expect(isCodexTurnAbortedMessage("why does <turn_aborted> render as text?")).toBe(false);
    expect(isCodexTurnAbortedMessage("")).toBe(false);
    expect(isCodexTurnAbortedMessage(null)).toBe(false);
  });
});

test("ConversationView classifies <turn_aborted> without consulting agent_type", () => {
  const src = readFileSync(join(import.meta.dir, "../../components/ConversationView.tsx"), "utf8");
  const line = src.split("\n").find((l) => l.includes("isCodexTurnAbortedMessage(") && l.includes("interrupt"));
  expect(line).toBeDefined();
  expect(line).not.toMatch(/agentType/);
  expect(src).not.toMatch(/agentType === "codex" && isCodexTurnAborted/);
});
