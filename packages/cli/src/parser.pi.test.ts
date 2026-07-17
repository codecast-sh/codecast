// pi (@mariozechner/pi-coding-agent) transcript parsing + tail classification.
// Fixtures under __fixtures__/pi are FULLY SYNTHETIC — hand-composed to pi's v3
// schema (verified byte-shape against real captured sessions, then written from
// scratch with throwaway /tmp paths and fabricated tool output, no real user data),
// including one /tree-branch session (pi has no real branches in captured data).
import { test, expect, describe } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  parsePiSessionFile,
  parseTranscriptFor,
  extractPiCwd,
  extractPiSessionId,
} from "./parser.js";
import { classifyPiTranscriptTail, classifyTranscriptTailFor } from "./daemon.js";

const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "pi", name), "utf8");

describe("parsePiSessionFile — real linear session with a bash tool call", () => {
  const content = fixture("linear-bash-tool.jsonl");
  const messages = parsePiSessionFile(content);

  test("dispatches through parseTranscriptFor('pi', …)", () => {
    expect(parseTranscriptFor("pi", content)).toEqual(messages);
  });

  test("emits user/assistant turns in chronological order", () => {
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe("user");
    // timestamps are non-decreasing (root -> leaf order)
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].timestamp).toBeGreaterThanOrEqual(messages[i - 1].timestamp);
    }
  });

  test("maps a toolCall block to ToolCall{ id, name, input:arguments }", () => {
    const withCall = messages.find((m) => m.toolCalls && m.toolCalls.length > 0);
    expect(withCall).toBeDefined();
    const call = withCall!.toolCalls![0];
    expect(call.name).toBe("bash");
    expect(call.id).toMatch(/^toolu_/);
    expect(call.input).toHaveProperty("command");
  });

  test("maps a toolResult message to a ParsedMessage with toolResults", () => {
    const withResult = messages.find((m) => m.toolResults && m.toolResults.length > 0);
    expect(withResult).toBeDefined();
    expect(withResult!.role).toBe("assistant");
    const result = withResult!.toolResults![0];
    expect(result.toolUseId).toMatch(/^toolu_/);
    expect(result.content.length).toBeGreaterThan(0);
  });

  test("tracks the model from model_change / per-message model on assistant turns", () => {
    const assistant = messages.find((m) => m.role === "assistant" && m.content);
    expect(assistant?.model).toBe("claude-opus-4-6");
  });

  test("extractPiCwd / extractPiSessionId read the header", () => {
    expect(extractPiCwd(content)).toBe("/tmp/pi-demo");
    expect(extractPiSessionId(content)).toBe("00000000-1111-2222-3333-444444444444");
  });
});

describe("parsePiSessionFile — thinking, multiple tools, and an image tool result", () => {
  const messages = parsePiSessionFile(fixture("thinking-image-tools.jsonl"));

  test("surfaces assistant thinking blocks", () => {
    const withThinking = messages.filter((m) => m.thinking && m.thinking.length > 0);
    expect(withThinking.length).toBeGreaterThan(0);
  });

  test("captures an image returned by a tool result", () => {
    const withImage = messages.find((m) => m.images && m.images.length > 0);
    expect(withImage).toBeDefined();
    expect(withImage!.images![0].mediaType).toBe("image/png");
    // truncated fixture payload is still a non-empty base64 string
    expect(withImage!.images![0].data.length).toBeGreaterThan(0);
  });

  test("collects every tool call across the branch (bash + read)", () => {
    const names = messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.name);
    expect(names).toContain("bash");
    expect(names).toContain("read");
  });
});

describe("parsePiSessionFile — active-branch resolution (synthetic /tree branch)", () => {
  const messages = parsePiSessionFile(fixture("branch.jsonl"));
  const texts = messages.map((m) => m.content).join(" | ");

  test("renders the active branch (the chain ending at the last file entry)", () => {
    expect(texts).toContain("ACTIVE question");
    expect(texts).toContain("ACTIVE answer");
  });

  test("excludes the abandoned branch's turns", () => {
    expect(texts).not.toContain("ABANDONED question");
    expect(texts).not.toContain("ABANDONED answer");
  });

  test("keeps the shared ancestor turns before the branch point", () => {
    expect(texts).toContain("start");
  });
});

describe("parsePiSessionFile — degenerate input", () => {
  test("empty content -> []", () => {
    expect(parsePiSessionFile("")).toEqual([]);
  });
  test("header only (no tree entries) -> []", () => {
    expect(parsePiSessionFile('{"type":"session","version":3,"id":"x","cwd":"/tmp"}')).toEqual([]);
  });
  test("skips a partial/corrupt trailing line without throwing", () => {
    const good = '{"type":"session","version":3,"id":"s","cwd":"/tmp"}\n'
      + '{"type":"message","id":"a","parentId":null,"timestamp":"2026-03-03T14:00:00.000Z","message":{"role":"user","content":"hi"}}\n'
      + '{"type":"message","id":"b","parentId":"a"'; // truncated mid-write
    const msgs = parsePiSessionFile(good);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("hi");
  });
});

describe("classifyPiTranscriptTail", () => {
  const asstStop = '{"type":"message","id":"a","parentId":"u","message":{"role":"assistant","stopReason":"stop","content":[]}}';
  const asstTool = '{"type":"message","id":"a","parentId":"u","message":{"role":"assistant","stopReason":"toolUse","content":[]}}';
  const userMsg = '{"type":"message","id":"u","parentId":null,"message":{"role":"user","content":"go"}}';
  const toolRes = '{"type":"message","id":"t","parentId":"a","message":{"role":"toolResult","toolCallId":"c","content":[]}}';

  test("assistant stop/length/error/aborted -> idle", () => {
    expect(classifyPiTranscriptTail(asstStop)).toBe("idle");
    expect(classifyPiTranscriptTail('{"type":"message","message":{"role":"assistant","stopReason":"aborted","content":[]}}')).toBe("idle");
  });
  test("assistant toolUse -> active", () => {
    expect(classifyPiTranscriptTail(asstTool)).toBe("active");
  });
  test("a user or toolResult tail -> active", () => {
    expect(classifyPiTranscriptTail(userMsg)).toBe("active");
    expect(classifyPiTranscriptTail(toolRes)).toBe("active");
  });
  test("streaming assistant (no stopReason) -> unknown (defer)", () => {
    expect(classifyPiTranscriptTail('{"type":"message","message":{"role":"assistant","content":[]}}')).toBe("unknown");
  });
  test("scans past non-message entries (model_change) to the last real turn", () => {
    expect(classifyPiTranscriptTail(`${asstStop}\n{"type":"model_change","id":"m","provider":"anthropic","modelId":"x"}`)).toBe("idle");
  });
  test("empty / unparseable tail -> unknown", () => {
    expect(classifyPiTranscriptTail("")).toBe("unknown");
  });

  test("a completed real session (linear-bash-tool) reads as idle", () => {
    expect(classifyPiTranscriptTail(fixture("linear-bash-tool.jsonl"))).toBe("idle");
  });

  test("registered in classifyTranscriptTailFor('pi')", () => {
    expect(typeof classifyTranscriptTailFor("pi")).toBe("function");
  });
});
