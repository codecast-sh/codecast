import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  antigravityUserRequest,
  classifyAntigravityTranscriptTail,
  parseAntigravityTranscript,
} from "./antigravityTranscript.js";
import {
  antigravityCwdFromWorkspaceUris,
  antigravityDataDirFromTranscript,
  antigravitySessionIdFromPath,
} from "./antigravityPaths.js";
import { parseTranscriptFor } from "./parser.js";

// Real transcripts from agy 1.5.14 (2026-11-22), with the home path scrubbed:
//  - print-one-command: `agy -p` that ran one shell command and answered "pong"
//  - interactive-two-commands: a TUI turn that ran two commands and answered
//    "done", then a second turn after `agy --conversation <id>` reopened it
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "antigravity", name), "utf8");

const row = (r: Record<string, unknown>) => JSON.stringify({ source: "MODEL", status: "DONE", created_at: "2026-11-22T20:45:09Z", ...r });

describe("parseAntigravityTranscript", () => {
  test("a print-mode conversation: the request, the call with its output, the answer", () => {
    const messages = parseAntigravityTranscript(fixture("print-one-command.jsonl"));
    expect(messages.map((m) => [m.uuid, m.role])).toEqual([
      ["agy-u0", "user"],
      ["agy-a1", "assistant"],
      ["agy-a3", "assistant"],
    ]);
    // Only the words inside <USER_REQUEST>, not agy's metadata and settings notices.
    expect(messages[0]!.content).toBe("Run the shell command 'echo probe-ok' and then reply with the single word pong.");
    expect(messages[1]!.toolCalls).toEqual([
      { id: "agy-t1-0", name: "run_command", input: { CommandLine: "echo probe-ok", WaitMsBeforeAsync: 5000, toolSummary: "Echo probe-ok" } },
    ]);
    expect(messages[1]!.toolResults).toHaveLength(1);
    expect(messages[1]!.toolResults![0]!.toolUseId).toBe("agy-t1-0");
    expect(messages[1]!.toolResults![0]!.content).toContain("probe-ok");
    expect(messages[1]!.model).toBe("gemini-4-argon-high");
    expect(messages[1]!.usage).toEqual({ input_tokens: 8660, output_tokens: 93, cache_read_input_tokens: 0 });
    expect(messages[2]!.content).toBe("pong");
    expect(messages[2]!.timestamp).toBe(Date.parse("2026-11-22T20:45:15Z"));
  });

  test("an interactive conversation reopened by id keeps one uuid per step and drops agy's system notices", () => {
    const messages = parseAntigravityTranscript(fixture("interactive-two-commands.jsonl"));
    expect(messages.map((m) => m.uuid)).toEqual(["agy-u0", "agy-a1", "agy-a3", "agy-a6", "agy-u7", "agy-a9"]);
    expect(messages.some((m) => m.content.includes("SYSTEM_MESSAGE"))).toBe(false);
    expect(messages.find((m) => m.uuid === "agy-a6")!.content).toBe("done");
    expect(messages.find((m) => m.uuid === "agy-u7")!.content).toBe("Reply with the word again.");
    // Each command's output lands on the response that ran it.
    for (const uuid of ["agy-a1", "agy-a3"]) {
      const m = messages.find((x) => x.uuid === uuid)!;
      expect(m.toolCalls).toHaveLength(1);
      expect(m.toolResults?.map((r) => r.toolUseId)).toEqual([m.toolCalls![0]!.id]);
    }
  });

  test("parallel calls pair with the result rows that follow them, in order", () => {
    const content = [
      row({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>\nsearch twice\n</USER_REQUEST>" }),
      row({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "search_web", args: { query: "a" } }, { name: "search_web", args: { query: "b" } }] }),
      row({ step_index: 2, type: "GENERIC", content: "results for a" }),
      row({ step_index: 3, type: "GENERIC", content: "results for b" }),
      row({ step_index: 4, type: "PLANNER_RESPONSE", content: "both found" }),
    ].join("\n") + "\n";
    const [, calls, answer] = parseAntigravityTranscript(content);
    expect(calls!.toolResults).toEqual([
      { toolUseId: "agy-t1-0", content: "results for a" },
      { toolUseId: "agy-t1-1", content: "results for b" },
    ]);
    expect(answer!.content).toBe("both found");
  });

  test("an interrupted stream shows as a system line; an empty response is skipped", () => {
    const content = [
      row({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "go" }),
      row({ step_index: 1, type: "PLANNER_RESPONSE", thinking: "planning" }),
      row({ step_index: 2, source: "SYSTEM", type: "ERROR_MESSAGE", content: "", error: "The stream was interrupted. Please continue the task you were working on." }),
      row({ step_index: 3, type: "PLANNER_RESPONSE", content: "continuing", thinking: "resumed" }),
    ].join("\n") + "\n";
    const messages = parseAntigravityTranscript(content);
    expect(messages.map((m) => [m.uuid, m.role])).toEqual([["agy-u0", "user"], ["agy-e2", "system"], ["agy-a3", "assistant"]]);
    expect(messages[0]!.content).toBe("go");
    expect(messages[2]!.thinking).toBe("resumed");
  });

  test("a torn last line, a codecast import notice and unknown row types are skipped, never thrown on", () => {
    const content = [
      row({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>\nhello\n</USER_REQUEST>" }),
      row({ step_index: 1, type: "SOMETHING_NEW", content: "?" }),
      row({ step_index: 2, type: "PLANNER_RESPONSE", content: "hi" }),
      '{"step_index":3,"type":"PLANNER_RES',
    ].join("\n");
    expect(parseAntigravityTranscript(content).map((m) => m.content)).toEqual(["hello", "hi"]);
  });

  test("tool args that agy stringified still parse; unparsable args become {}", () => {
    const content = [
      row({ step_index: 0, type: "PLANNER_RESPONSE", tool_calls: [{ name: "a", args: '{"x":1}' }, { name: "b", args: "not json" }, { args: {} }] }),
    ].join("\n") + "\n";
    const [m] = parseAntigravityTranscript(content);
    expect(m!.toolCalls).toEqual([
      { id: "agy-t0-0", name: "a", input: { x: 1 } },
      { id: "agy-t0-1", name: "b", input: {} },
    ]);
  });

  test("parseTranscriptFor dispatches antigravity to this parser", () => {
    const content = fixture("print-one-command.jsonl");
    expect(parseTranscriptFor("antigravity", content)).toEqual(parseAntigravityTranscript(content));
  });

  test("antigravityUserRequest keeps the request body and nothing else", () => {
    expect(antigravityUserRequest("<USER_REQUEST>\n  fix it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>")).toBe("fix it");
    expect(antigravityUserRequest("plain prompt")).toBe("plain prompt");
  });
});

describe("classifyAntigravityTranscriptTail", () => {
  test("a finished answer is idle", () => {
    expect(classifyAntigravityTranscriptTail(fixture("print-one-command.jsonl"))).toBe("idle");
    expect(classifyAntigravityTranscriptTail(fixture("interactive-two-commands.jsonl"))).toBe("idle");
  });

  test("a prompt, a call waiting on its output, an output or a system notice means more is coming", () => {
    const lines = fixture("print-one-command.jsonl").trim().split("\n");
    expect(classifyAntigravityTranscriptTail(lines.slice(0, 1).join("\n"))).toBe("active");
    expect(classifyAntigravityTranscriptTail(lines.slice(0, 2).join("\n"))).toBe("active");
    expect(classifyAntigravityTranscriptTail(lines.slice(0, 3).join("\n"))).toBe("active");
    expect(classifyAntigravityTranscriptTail(row({ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "notice" }))).toBe("active");
  });

  test("an error ends the turn; nothing readable is unknown", () => {
    expect(classifyAntigravityTranscriptTail(row({ step_index: 0, source: "SYSTEM", type: "ERROR_MESSAGE", error: "x" }))).toBe("idle");
    expect(classifyAntigravityTranscriptTail("")).toBe("unknown");
    expect(classifyAntigravityTranscriptTail('{"torn')).toBe("unknown");
  });
});

describe("antigravity paths", () => {
  const id = "42733a6f-f5ef-48ca-9f08-d571bd62efdd";
  const root = "/Users/me/.gemini/antigravity-cli";
  const transcript = `${root}/brain/${id}/.system_generated/logs/transcript_full.jsonl`;

  test("only the full transcript of a uuid conversation names a session", () => {
    expect(antigravitySessionIdFromPath(transcript)).toBe(id);
    expect(antigravitySessionIdFromPath(`${root}/brain/${id}/.system_generated/logs/transcript.jsonl`)).toBeNull();
    expect(antigravitySessionIdFromPath(`${root}/brain/${id}/.system_generated/logs/chunks/transcript_full/00000000.jsonl`)).toBeNull();
    expect(antigravitySessionIdFromPath(`${root}/brain/x;rm -rf ~/.system_generated/logs/transcript_full.jsonl`)).toBeNull();
    expect(antigravitySessionIdFromPath(`${root}/brain/not-a-uuid/.system_generated/logs/transcript_full.jsonl`)).toBeNull();
  });

  test("the data dir is brain's parent, and only under brain", () => {
    expect(antigravityDataDirFromTranscript(transcript)).toBe(root);
    expect(antigravityDataDirFromTranscript(`/tmp/doctor/${id}/.system_generated/logs/transcript_full.jsonl`)).toBeNull();
  });

  test("workspace_uris decode to the first local folder", () => {
    expect(antigravityCwdFromWorkspaceUris('["file:///Users/me/research_notes/LLM%20second%20brain"]')).toBe("/Users/me/research_notes/LLM second brain");
    expect(antigravityCwdFromWorkspaceUris('["https://example.com", "file:///tmp"]')).toBe("/tmp");
    expect(antigravityCwdFromWorkspaceUris("[]")).toBeUndefined();
    expect(antigravityCwdFromWorkspaceUris("not json")).toBeUndefined();
    expect(antigravityCwdFromWorkspaceUris(null)).toBeUndefined();
  });
});
