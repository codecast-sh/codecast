import { describe, expect, test } from "bun:test";
import { parseCursorTranscriptFile } from "./parser.js";
import { cursorPassBoundary } from "./transcriptWindow.js";
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

  test("the older text format still parses", () => {
    const msgs = parseCursorTranscriptFile("user:\n<user_query>\nhi\n</user_query>\nassistant:\nhello\n");
    expect(msgs.map((m) => [m.role, m.content])).toEqual([["user", "hi"], ["assistant", "hello"]]);
  });

  test("the window cut advances at any newline in a JSONL transcript", () => {
    const buf = Buffer.from(JSONL);
    // Mid-file (not at EOF) a text transcript needs a later role header to
    // cut; a JSONL one cuts at the last complete line.
    const cut = cursorPassBoundary(buf, buf.length - 10, false, 0);
    expect(cut).toBe(buf.lastIndexOf(0x0a, buf.length - 11));
    expect(cut).toBeGreaterThan(0);
  });

  test("the watcher accepts .jsonl transcripts", () => {
    expect(isCursorTranscriptPath("p/agent-transcripts/abc/abc.jsonl")).toBe(true);
    expect(isCursorTranscriptPath("p/terminals/abc.jsonl")).toBe(false);
  });
});
