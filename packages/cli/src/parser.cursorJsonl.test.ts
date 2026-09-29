import { describe, expect, test } from "bun:test";
import { parseCursorTranscriptFile } from "./parser.js";
import { classifyCursorTranscriptTail } from "./workers/ingestMetadata.js";
import { isCursorTranscriptPath } from "./cursorTranscriptWatcher.js";

// Recorded from cursor-agent 2026.09.28 (TUI) on 2026-09-29.
const JSONL = [
  `{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Tuesday, Sep 29, 2026, 2:29 AM (UTC-4)</timestamp>\\n<user_query>\\ncreate a file hello.txt containing the word hi, then reply done\\n</user_query>"}]}}`,
  `{"role":"assistant","message":{"content":[{"type":"text","text":"Creating \`hello.txt\` with the word \`hi\`."},{"type":"tool_use","name":"Write","input":{"path":"/private/tmp/cursor-scratch/hello.txt","contents":"hi\\n"}}]}}`,
  `{"role":"assistant","message":{"content":[{"type":"text","text":"done\\n\\n[REDACTED]"}]}}`,
  `{"type":"turn_ended","status":"success"}`,
  `{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{"command":"ls -la"}},{"type":"tool_use","name":"Read","input":{"path":"/tmp/x"}}]}}`,
  "",
].join("\n");

describe("cursor JSONL transcripts", () => {
  test("parse user queries, assistant text and tool calls; drop turn markers and redaction stubs", () => {
    const msgs = parseCursorTranscriptFile(JSONL);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(msgs[0].content).toBe("create a file hello.txt containing the word hi, then reply done");
    expect(msgs[0].timestamp).toBe(Date.parse("2026-09-29T06:29:00Z"));
    expect(msgs[1].toolCalls).toEqual([{ id: "cursor-1-0", name: "Write", input: { path: "/private/tmp/cursor-scratch/hello.txt", contents: "hi\n" } }]);
    expect(msgs[2].content).toBe("done");
    expect(msgs[3].content).toBe("");
    expect(msgs[3].toolCalls?.map((t) => t.name)).toEqual(["Shell", "Read"]);
    // Assistant turns carry the clock of the query they answer.
    expect(msgs[3].timestamp).toBe(msgs[0].timestamp);
  });

  test("ids are the chat id plus the record ordinal, stable across a rewrite", () => {
    const ids = parseCursorTranscriptFile(JSONL, "chat-1").map((m) => m.uuid);
    expect(ids).toEqual(["chat-1:0", "chat-1:1", "chat-1:2", "chat-1:3"]);
    // A redacted-only record renders nothing but still holds its ordinal.
    const withEmpty = JSONL.replace(`{"role":"assistant","message":{"content":[{"type":"text","text":"done\\n\\n[REDACTED]"}]}}`, `{"role":"assistant","message":{"content":[{"type":"text","text":"[REDACTED]"}]}}`);
    expect(parseCursorTranscriptFile(withEmpty, "chat-1").map((m) => m.uuid)).toEqual(["chat-1:0", "chat-1:1", "chat-1:3"]);
  });

  test("terminal control bytes a paste left in the query are dropped", () => {
    const line = `{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\n\\u000b\\u0001hello\\n</user_query>"}]}}`;
    expect(parseCursorTranscriptFile(line)[0].content).toBe("hello");
  });

  test("turn state comes from turn_ended", () => {
    expect(classifyCursorTranscriptTail(JSONL)).toBe("active");
    expect(classifyCursorTranscriptTail(JSONL.split("\n").slice(0, 4).join("\n"))).toBe("idle");
    expect(classifyCursorTranscriptTail("")).toBe("unknown");
  });

  test("the older text format still parses", () => {
    const msgs = parseCursorTranscriptFile("user:\n<user_query>\nhi\n</user_query>\nassistant:\nhello\n");
    expect(msgs.map((m) => [m.role, m.content])).toEqual([["user", "hi"], ["assistant", "hello"]]);
  });

  test("the watcher accepts .jsonl transcripts", () => {
    expect(isCursorTranscriptPath("p/agent-transcripts/abc/abc.jsonl")).toBe(true);
    expect(isCursorTranscriptPath("p/terminals/abc.jsonl")).toBe(false);
  });
});
