import { expect, test } from "bun:test";
import { formatAgentPrompt, mergeAgentPromptSources, resolveAgentPromptSource, subagentPromptParent } from "./agentPromptOrigin";
import { parseCodexSessionFile } from "./parser";
import { parseInboundSessionMessage } from "../../web/components/sessionMessage";
import { isMachineDeliveredMessage } from "@codecast/shared/contracts";

const parent = "jx7297y2rfkpskb14mgbsjm5e58dv709";
const knownParents = new Set([parent]);

test("a marked launch survives Codex parsing and renders with its parent's identity", () => {
  const body = "Implement the task.\n\nLiteral `code`, $HOME, <tags> and café.";
  const content = formatAgentPrompt(parent, body, true);
  const [message] = parseCodexSessionFile(JSON.stringify({ type: "response_item", timestamp: "2026-09-06T00:00:00Z", payload: { type: "message", id: "launch", role: "user", content: [{ type: "input_text", text: content }] } }));
  expect(subagentPromptParent(message.content, knownParents)).toBe(parent);
  expect(subagentPromptParent(message.content, new Set())).toBeUndefined();
  expect(subagentPromptParent(message.content, knownParents, parent)).toBeUndefined();
  expect(parseInboundSessionMessage(message.content)).toEqual({ from: parent, body, name: undefined });
  expect(isMachineDeliveredMessage(message.content)).toBe(true);
  expect(message.uuid).toBe("codex-message-launch");
});

test("follow-ups have a sender but cannot create a parent relationship", () => {
  const content = formatAgentPrompt(parent, "Please continue");
  expect(subagentPromptParent(content, knownParents)).toBeUndefined();
  expect(parseInboundSessionMessage(content)?.from).toBe(parent);
  expect(subagentPromptParent(`Example:\n${formatAgentPrompt(parent, "text", true)}`, knownParents)).toBeUndefined();
  expect(subagentPromptParent(`\n${formatAgentPrompt(parent, "text", true)}`, knownParents)).toBeUndefined();
  expect(subagentPromptParent(formatAgentPrompt(parent, "text", true) + "\nExample", knownParents)).toBeUndefined();
  expect(subagentPromptParent('<session-message from="unknown" subagent="true">text</session-message>', knownParents)).toBeUndefined();
  expect(isMachineDeliveredMessage("Please continue")).toBe(false);
});

test("managed and file-watcher evidence merge without modifying either cache or selecting a conflicting thread", () => {
  const other = "jx7297y2rfkpskb14mgbsjm5e58dv708";
  const own = { native: parent, collision: parent };
  const managed = { [other]: { threadId: "collision" }, [parent]: { threadId: "managed" } };
  const before = JSON.stringify({ own, managed });
  const merged = mergeAgentPromptSources(own, managed);
  expect(resolveAgentPromptSource("native", merged)).toBe(parent);
  expect(resolveAgentPromptSource("managed", merged)).toBe(parent);
  expect(resolveAgentPromptSource("collision", merged)).toBeUndefined();
  expect(resolveAgentPromptSource("jx7297y", merged)).toBeUndefined();
  expect(resolveAgentPromptSource(other, merged)).toBe(other);
  expect(JSON.stringify({ own, managed })).toBe(before);
});

test("only resolved, unambiguous source identities are accepted", () => {
  const cache = { thread: parent };
  expect(resolveAgentPromptSource("thread", cache)).toBe(parent);
  expect(resolveAgentPromptSource("jx7297y", cache)).toBe(parent);
  expect(resolveAgentPromptSource(parent, cache)).toBe(parent);
  expect(resolveAgentPromptSource(parent, {})).toBeUndefined();
  expect(resolveAgentPromptSource("unknown", cache)).toBeUndefined();
  expect(resolveAgentPromptSource("jx7297y", { ...cache, second: "jx7297y2rfkpskb14mgbsjm5e58dv708" })).toBeUndefined();
  expect(() => formatAgentPrompt("unknown", "text")).toThrow();
  expect(() => formatAgentPrompt(parent, " ")).toThrow();
});
