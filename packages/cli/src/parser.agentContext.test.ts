import { expect, test } from "bun:test";
import { parseCodexSessionFile } from "./parser";
import { isAgentContextMessage, isMachineDeliveredMessage } from "@codecast/shared/contracts";

const setup = "<recommended_plugins>\nAvailable plugins\n</recommended_plugins>\n# AGENTS.md instructions for /repo\n<INSTRUCTIONS>Rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>";
const entry = (text: string) => JSON.stringify({ type: "response_item", timestamp: "2026-09-05T00:55:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

test("Codex plugin-prefixed setup never becomes a human message or title", () => {
  const messages = parseCodexSessionFile([entry(setup), entry("Review cloud spawn")].join("\n"));
  expect(messages.map(m => m.content)).toEqual(["Review cloud spawn"]);
  expect(isMachineDeliveredMessage(setup)).toBe(true);
});

test("context detection is anchored and accepts injection noise", () => {
  expect(isAgentContextMessage("\u0001\u000b " + setup)).toBe(true);
  for (const content of ["Explain <recommended_plugins>", "```xml\n" + setup, "# AGENTS.md guidance", "<permissions-example>example</permissions-example>"]) {
    expect(isAgentContextMessage(content)).toBe(false);
  }
});
