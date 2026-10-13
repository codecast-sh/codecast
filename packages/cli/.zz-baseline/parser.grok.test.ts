// Grok Build (xai-org/grok-build) transcript parsing + tail classification.
// Fixtures under __fixtures__/grok are hand-composed (throwaway /tmp paths,
// fabricated tool output, no real user data) to the updates.jsonl schema from
// the grok-build source, then corrected field-for-field against a LIVE
// logged-in v1.0.5 capture (2026-08-26): envelope timestamps in unix SECONDS,
// ACP camelCase payload fields (toolCallId, _meta.promptIndex), xAI extension
// snake_case variant fields (prompt_id, stop_reason, target_prompt_index),
// tool results as ToolCallContent wrappers ({type:"content"}) for commands and
// {type:"diff"} blocks for edits, an in_progress update carrying the tool
// DESCRIPTION (the terminal update's content replaces it), camelCase
// turn_completed usage, _meta["x.ai/tool"] on tool_call, a legacy method-less
// line, a rewind_marker, and a torn final line.
import { test, expect, describe } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  parseGrokSessionFile,
  parseTranscriptFor,
  extractGrokCwd,
  extractGrokSessionId,
  isGrokInternalSession,
} from "./parser.js";
import { classifyGrokTranscriptTail, classifyTranscriptTailFor } from "./daemon.js";

const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "grok", name), "utf8");

describe("parseGrokSessionFile — linear turn with a bash tool call", () => {
  const content = fixture("linear-tools.jsonl");
  const messages = parseGrokSessionFile(content);

  test("dispatches through parseTranscriptFor('grok', …)", () => {
    expect(parseTranscriptFor("grok", content)).toEqual(messages);
  });

  test("emits user/assistant turns in chronological order", () => {
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe("user");
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].timestamp).toBeGreaterThanOrEqual(messages[i - 1].timestamp);
    }
  });

  test("coalesces consecutive user_message_chunk deltas into ONE user message", () => {
    const users = messages.filter((m) => m.role === "user");
    expect(users.length).toBe(1);
    expect(users[0].content).toBe("list the files here");
  });

  test("coalesces consecutive agent_message_chunk deltas into ONE assistant message", () => {
    const first = messages.find((m) => m.role === "assistant");
    expect(first?.content).toBe("Sure, let me look.");
  });

  test("envelope timestamps are unix SECONDS -> ms on ParsedMessage", () => {
    expect(messages[0].timestamp).toBe(1772550001 * 1000);
  });

  test("maps tool_call to ToolCall{ id:toolCallId, name:title, input:rawInput }", () => {
    const withCall = messages.find((m) => m.toolCalls && m.toolCalls.length > 0);
    expect(withCall).toBeDefined();
    const call = withCall!.toolCalls![0];
    expect(call.id).toBe("call_synthbash01");
    expect(call.name).toBe("bash");
    expect(call.input).toEqual({ command: "ls" });
  });

  test("merges tool_call_update by toolCallId and emits the result at terminal status", () => {
    const withResult = messages.find((m) => m.toolResults && m.toolResults.length > 0);
    expect(withResult).toBeDefined();
    expect(withResult!.role).toBe("assistant");
    const result = withResult!.toolResults![0];
    expect(result.toolUseId).toBe("call_synthbash01");
    expect(result.content).toBe("README.md\npackage.json\nsrc\n");
    expect(result.isError).toBeUndefined();
  });

  test("the terminal update's content REPLACES the in_progress description (ACP update semantics)", () => {
    // The live-captured in_progress update carries the tool DESCRIPTION in a
    // ToolCallContent wrapper; appending it prefixed every command result with
    // its description.
    const result = messages
      .flatMap((m) => m.toolResults ?? [])
      .find((r) => r.toolUseId === "call_synthbash01");
    expect(result!.content).not.toContain("List the files");
  });

  test("renders {type:'diff'} edit results as path + diff lines (live edit-tool shape)", () => {
    const result = messages
      .flatMap((m) => m.toolResults ?? [])
      .find((r) => r.toolUseId === "call_synthwrite02");
    expect(result).toBeDefined();
    expect(result!.content).toBe("/tmp/demo/notes.txt\n+ hello\n");
  });

  test("tracks the model from _meta.modelId on user chunks", () => {
    const assistant = messages.find((m) => m.role === "assistant" && m.content);
    expect(assistant?.model).toBe("grok-4.6");
  });

  test("stamps turn_completed's stop_reason on the turn's last assistant message", () => {
    const assistants = messages.filter((m) => m.role === "assistant" && m.content);
    expect(assistants[assistants.length - 1].stopReason).toBe("end_turn");
  });

  test("agent_result does NOT duplicate the reply when chunks already carried text", () => {
    const finals = messages.filter((m) => m.content.includes("Three entries"));
    expect(finals.length).toBe(1);
  });

  test("legacy method-less first line parses without deranging the stream", () => {
    // available_commands_update (legacy raw-ACP shape) is meta — no message,
    // no crash, and extractGrokSessionId reads its top-level sessionId.
    expect(extractGrokSessionId(content)).toBe("c3f8a1b2-4d5e-4f60-8a9b-0c1d2e3f4a5b");
  });
});

describe("parseGrokSessionFile — thinking, rewind filter, torn tail", () => {
  const content = fixture("thinking-rewind.jsonl");
  const messages = parseGrokSessionFile(content);
  const texts = messages.map((m) => m.content).join(" | ");

  test("accumulates agent_thought_chunk deltas as the assistant's thinking block", () => {
    const withThinking = messages.find((m) => m.thinking && m.thinking.length > 0);
    expect(withThinking).toBeDefined();
    expect(withThinking!.thinking).toBe("First map the modules, then order the steps.");
  });

  test("rewind_marker drops every message of the rewound-away turn", () => {
    expect(texts).not.toContain("ABANDONED question");
    expect(texts).not.toContain("ABANDONED answer");
  });

  test("keeps the turns before the rewind target and the superseding turn", () => {
    expect(texts).toContain("outline the plan");
    expect(texts).toContain("ACTIVE question");
    expect(texts).toContain("ACTIVE answer");
  });

  test("model_changed updates the tracked model for later assistant turns", () => {
    const active = messages.find((m) => m.content === "ACTIVE answer");
    expect(active?.model).toBe("grok-4.5");
  });

  test("skips the torn final line silently (buffered appends heal it later)", () => {
    // The fixture's last line is truncated mid-record; the parse still succeeds
    // and the final message is the superseding turn's answer.
    expect(messages[messages.length - 1].content).toBe("ACTIVE answer");
  });
});

describe("parseGrokSessionFile — degenerate input", () => {
  test("empty content -> []", () => {
    expect(parseGrokSessionFile("")).toEqual([]);
  });
  test("meta-only content (no chunks) -> []", () => {
    expect(
      parseGrokSessionFile(
        '{"timestamp":0,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"available_commands_update","availableCommands":[]}}}',
      ),
    ).toEqual([]);
  });
  test("an unparsable middle line is skipped, not a parse failure", () => {
    const content =
      '{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"},"_meta":{"promptIndex":0}}}}\n' +
      "{corrupt\n" +
      '{"timestamp":2,"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p-0","stop_reason":"end_turn","agent_result":"ok"}}}';
    const msgs = parseGrokSessionFile(content);
    expect(msgs.map((m) => m.content)).toEqual(["hi", "ok"]);
  });
  test("tool_call_update with an unknown toolCallId is ignored (fork/rewind edge)", () => {
    const content =
      '{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"ghost","status":"completed","content":[{"type":"text","text":"boo"}]}}}';
    expect(parseGrokSessionFile(content)).toEqual([]);
  });
});

describe("grok summary.json helpers", () => {
  test("extractGrokCwd reads summary info.cwd (authoritative across relocation)", () => {
    expect(extractGrokCwd(fixture("summary-normal.json"))).toBe("/tmp/grok-demo");
    expect(extractGrokCwd("{}")).toBeUndefined();
    expect(extractGrokCwd("not json")).toBeUndefined();
  });

  test("isGrokInternalSession: subagent / hidden siblings are grok-internal", () => {
    expect(isGrokInternalSession(fixture("summary-normal.json"))).toBe(false);
    expect(isGrokInternalSession(fixture("summary-subagent.json"))).toBe(true);
    expect(isGrokInternalSession(fixture("summary-hidden.json"))).toBe(true);
    expect(isGrokInternalSession('{"session_kind":"subagent_fork"}')).toBe(true);
    // A user-initiated fork is a REAL top-level session, not an internal child.
    expect(isGrokInternalSession('{"session_kind":"fork"}')).toBe(false);
    expect(isGrokInternalSession("not json")).toBe(false);
  });
});

describe("classifyGrokTranscriptTail", () => {
  const wrap = (update: string) =>
    `{"timestamp":1772550000,"method":"session/update","params":{"sessionId":"s","update":${update}}}`;
  const wrapX = (update: string) =>
    `{"timestamp":1772550000,"method":"_x.ai/session/update","params":{"sessionId":"s","update":${update}}}`;
  const turnDone = wrapX('{"sessionUpdate":"turn_completed","prompt_id":"p-0","stop_reason":"end_turn"}');

  test("turn_completed -> idle, for ANY stop_reason (end_turn/cancelled/error)", () => {
    expect(classifyGrokTranscriptTail(turnDone)).toBe("idle");
    expect(classifyGrokTranscriptTail(wrapX('{"sessionUpdate":"turn_completed","prompt_id":"p","stop_reason":"cancelled"}'))).toBe("idle");
    expect(classifyGrokTranscriptTail(wrapX('{"sessionUpdate":"turn_completed","prompt_id":"p","stop_reason":"error"}'))).toBe("idle");
  });

  test("scans past post-turn housekeeping to the turn_completed beneath it", () => {
    const tail = `${turnDone}\n${wrapX('{"sessionUpdate":"last_turn_summary","summary":"x"}')}\n${wrapX('{"sessionUpdate":"session_summary_generated"}')}`;
    expect(classifyGrokTranscriptTail(tail)).toBe("idle");
  });

  test("a user chunk / tool_call / tool_call_update tail -> active", () => {
    expect(classifyGrokTranscriptTail(wrap('{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"go"},"_meta":{"promptIndex":0}}'))).toBe("active");
    expect(classifyGrokTranscriptTail(wrap('{"sessionUpdate":"tool_call","toolCallId":"t1","title":"bash","status":"pending"}'))).toBe("active");
    expect(classifyGrokTranscriptTail(wrap('{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"in_progress"}'))).toBe("active");
  });

  test("an unresolved pending_interaction -> active (agent parked on a question)", () => {
    expect(classifyGrokTranscriptTail(wrapX('{"sessionUpdate":"pending_interaction","interaction_id":"q1"}'))).toBe("active");
  });

  test("a RESOLVED pending_interaction is scanned past to the state beneath it", () => {
    const tail = `${turnDone}\n${wrapX('{"sessionUpdate":"pending_interaction","interaction_id":"q1"}')}\n${wrapX('{"sessionUpdate":"interaction_resolved","interaction_id":"q1"}')}`;
    expect(classifyGrokTranscriptTail(tail)).toBe("idle");
  });

  test("a streaming assistant chunk with no terminal marker -> unknown (defer)", () => {
    expect(classifyGrokTranscriptTail(wrap('{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"streaming"}}'))).toBe("unknown");
    expect(classifyGrokTranscriptTail(wrap('{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}'))).toBe("unknown");
  });

  test("empty / unparseable / meta-only tail -> unknown", () => {
    expect(classifyGrokTranscriptTail("")).toBe("unknown");
    expect(classifyGrokTranscriptTail("{torn")).toBe("unknown");
    expect(classifyGrokTranscriptTail(wrap('{"sessionUpdate":"available_commands_update","availableCommands":[]}'))).toBe("unknown");
  });

  test("a completed session (linear-tools) reads idle; rewind fixture's torn tail still reads idle", () => {
    expect(classifyGrokTranscriptTail(fixture("linear-tools.jsonl"))).toBe("idle");
    expect(classifyGrokTranscriptTail(fixture("thinking-rewind.jsonl"))).toBe("idle");
  });

  test("a mid-turn session (pending tool call, no turn_completed) reads active", () => {
    expect(classifyGrokTranscriptTail(fixture("mid-turn.jsonl"))).toBe("active");
  });

  test("registered in classifyTranscriptTailFor('grok')", () => {
    expect(typeof classifyTranscriptTailFor("grok")).toBe("function");
  });
});
