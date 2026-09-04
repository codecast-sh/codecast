import { describe, expect, test } from "bun:test";
import { parseCodexSessionFile } from "./parser";

const context = (model: string) => ({ type: "turn_context", payload: { model } });
const assistant = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const jsonl = (entries: unknown[]) => entries.map(entry => JSON.stringify({ timestamp: "2026-09-04T12:00:00Z", ...entry as object })).join("\n");

describe("Codex model attribution", () => {
  test("uses each turn's model for text, thinking, tool calls and tool results", () => {
    const messages = parseCodexSessionFile(jsonl([
      context("gpt-5.6-sol"), assistant("First response"),
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "Thinking" }] } },
      context("gpt-6-astra"),
      { type: "response_item", payload: { type: "function_call", name: "exec", call_id: "tool1", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "tool1", output: "done" } },
      assistant("Second response"),
    ]));
    expect(messages.map(message => message.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-astra", "gpt-6-astra"]);
  });

  test("leaves historical messages without recorded context unknown", () => {
    const messages = parseCodexSessionFile(jsonl([assistant("Old response"), context("gpt-6-astra"), assistant("New response")]));
    expect(messages.map(message => message.model)).toEqual([undefined, "gpt-6-astra"]);
  });
});
