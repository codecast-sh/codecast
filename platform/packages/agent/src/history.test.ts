import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@mariozechner/pi-ai";
import { messagesToRows, prepareContext, rowsToMessages, type MessageRow } from "./history";

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3,
});

/** A conversation in the shape this package writes: every field it reads, in canonical form. */
const transcript: MessageRow[] = [
  { role: "user", content: "Find Dana's email and draft a reply", timestamp: 1, message_uuid: "u1" },
  {
    role: "assistant",
    content: "Looking.",
    thinking: "Search mail first.",
    tool_calls: [
      { id: "call_a", name: "search_mail", input: JSON.stringify({ q: "from:dana" }) },
      { id: "call_b", name: "read_calendar", input: JSON.stringify({ day: "2026-10-05" }) },
    ],
    model: "claude-sonnet-5-5",
    timestamp: 2,
    usage: usage(120, 40),
    message_uuid: "a1",
    api_message_id: "msg_1",
  },
  {
    role: "user",
    tool_results: [
      { tool_use_id: "call_a", content: "1 email from Dana", is_error: false },
      { tool_use_id: "call_b", content: "calendar unavailable", is_error: true },
    ],
    images: [{ media_type: "image/png", data: "iVBORw0KGgo=", tool_use_id: "call_a" }],
    timestamp: 3,
    message_uuid: "r1",
  },
  {
    role: "user",
    content: "Here is a screenshot too",
    images: [{ media_type: "image/jpeg", data: "/9j/4AAQ=" }],
    timestamp: 4,
    message_uuid: "u2",
  },
  { role: "assistant", content: "Drafted.", model: "claude-sonnet-5-5", timestamp: 5, usage: usage(300, 20), message_uuid: "a2" },
];

describe("history conversion", () => {
  it("round trips codecast rows through pi messages unchanged", () => {
    expect(messagesToRows(rowsToMessages(transcript))).toEqual(transcript);
  });

  it("round trips pi messages through rows with their content, calls and results intact", () => {
    const messages = rowsToMessages(transcript);
    const again = rowsToMessages(messagesToRows(messages));
    expect(again).toEqual(messages);
  });

  it("reads tool calls, result names and errors into pi's shapes", () => {
    const messages = rowsToMessages(transcript);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user", "assistant"]);
    const assistant = messages[1] as AssistantMessage;
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "Search mail first." },
      { type: "text", text: "Looking." },
      { type: "toolCall", id: "call_a", name: "search_mail", arguments: { q: "from:dana" } },
      { type: "toolCall", id: "call_b", name: "read_calendar", arguments: { day: "2026-10-05" } },
    ]);
    expect(assistant).toMatchObject({ api: "anthropic-messages", provider: "anthropic", stopReason: "toolUse", responseId: "msg_1" });
    expect(assistant.usage).toMatchObject({ input: 120, output: 40, cacheRead: 3, cacheWrite: 0 });
    const result = messages[2] as ToolResultMessage;
    expect(result).toMatchObject({ toolCallId: "call_a", toolName: "search_mail", isError: false });
    expect(result.content[1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect((messages[3] as ToolResultMessage).isError).toBe(true);
  });

  it("accepts tool rows, object inputs, and skips system notices", () => {
    const rows: MessageRow[] = [
      { role: "system", content: "Session resumed", timestamp: 0 },
      { role: "assistant", tool_calls: [{ id: "c", name: "lookup", input: { q: "x" } }], timestamp: 1 },
      { role: "tool", tool_results: [{ tool_use_id: "c", content: "ok" }], timestamp: 2 },
    ];
    const messages = rowsToMessages(rows);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((messages[0] as AssistantMessage).content[0]).toMatchObject({ arguments: { q: "x" } });
    expect(messages[1]).toMatchObject({ toolName: "lookup", isError: false });
  });

  it("keeps rows without a uuid apart and writes no uuid for them", () => {
    const rows: MessageRow[] = [
      { role: "user", tool_results: [{ tool_use_id: "c1", content: "a", is_error: false }], timestamp: 1 },
      { role: "user", tool_results: [{ tool_use_id: "c2", content: "b", is_error: false }], timestamp: 2 },
    ];
    expect(messagesToRows(rowsToMessages(rows))).toEqual(rows);
  });
});

describe("prepareContext", () => {
  const call = (id: string): AssistantMessage => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "t", arguments: {} }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  });
  const result = (id: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "t", content: [], isError: false, timestamp: 0 });
  const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

  it("drops unsigned thinking and assistant messages left empty", () => {
    const thinkingOnly: AssistantMessage = { ...call("x"), content: [{ type: "thinking", thinking: "hmm" }] };
    const signed: AssistantMessage = { ...call("y"), content: [{ type: "thinking", thinking: "ok", thinkingSignature: "sig" }, { type: "text", text: "hi" }] };
    expect(prepareContext([user("a"), thinkingOnly, signed])).toEqual([user("a"), signed]);
  });

  it("moves results next to their call and drops orphans and duplicates", () => {
    const out = prepareContext([user("a"), call("c1"), user("b"), result("c1"), result("c1"), result("nobody")]);
    expect(out.map((m) => (m.role === "toolResult" ? `r:${m.toolCallId}` : m.role))).toEqual(["user", "assistant", "r:c1", "user"]);
  });
});
