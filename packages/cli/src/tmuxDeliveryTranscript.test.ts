import { expect, test } from "bun:test";
import { transcriptContainsDelivery } from "./tmuxDeliveryTranscript.js";

const at = Date.parse("2026-10-04T18:42:00Z");
const row = (content: unknown, timestamp = at, role = "user") => JSON.stringify({ type: role, uuid: "echo", timestamp: new Date(timestamp).toISOString(), message: { role, content } });

test("only the submitted user payload after this receipt proves delivery", () => {
  expect(transcriptContainsDelivery(row("continue"), "claude", "continue", at)).toBe(true);
  expect(transcriptContainsDelivery(row("continue", at - 1), "claude", "continue", at)).toBe(false);
  expect(transcriptContainsDelivery(row("continue", at, "assistant"), "claude", "continue", at)).toBe(false);
  expect(transcriptContainsDelivery(row([{ type: "tool_result", tool_use_id: "x", content: "continue" }]), "claude", "continue", at)).toBe(false);
  expect(transcriptContainsDelivery(row("continue please"), "claude", "continue", at)).toBe(false);
  expect(transcriptContainsDelivery(row('<pasted_content id="x">\ncontinue\n</pasted_content>'), "claude", "continue", at)).toBe(true);
});

test("a queued command is delivery evidence before its turn runs", () => {
  const transcript = JSON.stringify({ type: "attachment", uuid: "queued", timestamp: new Date(at).toISOString(), attachment: { type: "queued_command", prompt: "continue" } });
  expect(transcriptContainsDelivery(transcript, "claude", "continue", at)).toBe(true);
});

test("a slash command is delivered once Claude Code records its invocation", () => {
  // /mcp writes nothing until its panel closes, then the tagged record: read as
  // text it never matched, and the receipt released and typed the command again.
  const recorded = "<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>";
  expect(transcriptContainsDelivery(row(recorded), "claude", "/mcp", at)).toBe(true);
  expect(transcriptContainsDelivery(row(recorded), "claude", "/model opus", at)).toBe(false);
  expect(transcriptContainsDelivery(row(recorded, at - 1), "claude", "/mcp", at)).toBe(false);
});
