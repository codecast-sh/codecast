import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCodexJsonl, writeCodexSession, type ExportResult } from "./jsonlGenerator";
import { parseCodexSessionFile } from "./parser";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const timestamp = "2026-09-05T00:43:02.842Z";
const data: ExportResult = {
  conversation: {
    id: "conversation", title: "Browser screenshot test", session_id: "synthetic-session",
    agent_type: "codex", project_path: "/tmp/project", model: "gpt-6-astra",
    message_count: 4, started_at: timestamp, updated_at: timestamp,
  },
  messages: [
    { role: "user", content: "Which browser did you use?", timestamp },
    { role: "assistant", content: "I will check.", timestamp, thinking: "Inspect browser selection.",
      tool_calls: [{ id: "call-1", name: "exec_command", input: '{"cmd":"cast browser target"}' }] },
    { role: "assistant", content: "", timestamp,
      tool_results: [{ tool_use_id: "call-1", content: "clone" }] },
    { role: "assistant", content: "Your instructions explicitly say to use your normal Chrome.", timestamp },
  ],
};

describe("restored Codex transcript ingestion", () => {
  test("re-reading restored history from disk uploads no duplicate rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-restore-"));
    dirs.push(dir);
    const { jsonl, sessionId } = generateCodexJsonl(data, { sessionId: data.conversation.session_id });
    const { filePath } = writeCodexSession(jsonl, sessionId, "remote", dir);
    const restored = readFileSync(filePath, "utf8");
    expect(restored).toContain(data.messages[3].content);
    expect(restored).toContain('"function_call_output"');
    expect(parseCodexSessionFile(restored)).toEqual([]);

    const continuation = [
      { timestamp, type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] } },
      { timestamp, type: "response_item", payload: { id: "new-reply", type: "message", role: "assistant", content: [{ type: "output_text", text: data.messages[3].content }] } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    appendFileSync(filePath, continuation);
    const replay = parseCodexSessionFile(readFileSync(filePath, "utf8"));
    expect(replay.map(message => message.content)).toEqual(["Continue", data.messages[3].content]);
    expect(replay[1].model).toBe("gpt-5.6-sol");
    expect(parseCodexSessionFile(continuation)).toEqual(replay);
  });

  test("an incremental window beginning inside restored history still skips it", () => {
    const { jsonl } = generateCodexJsonl(data, { sessionId: data.conversation.session_id });
    const lines = jsonl.trim().split("\n");
    for (let offset = 0; offset < lines.length; offset++) {
      expect(parseCodexSessionFile(lines.slice(offset).join("\n"))).toEqual([]);
    }
  });

  test("a new import retains its history without the synthetic project prompt", () => {
    const { jsonl, sessionId } = generateCodexJsonl(data);
    expect(sessionId).not.toBe(data.conversation.session_id);
    const messages = parseCodexSessionFile(jsonl);
    expect(messages.filter(message => message.content).map(message => message.content))
      .toEqual(data.messages.filter(message => message.content).map(message => message.content));
    expect(messages.filter(message => message.role === "assistant").map(message => message.model))
      .toEqual(Array(4).fill("gpt-6-astra"));
    expect(jsonl).not.toContain("gpt-5.2-codex");
  });

  test("unknown and non-Codex models do not acquire a fabricated Codex label", () => {
    for (const conversation of [
      { ...data.conversation, model: null },
      { ...data.conversation, agent_type: "claude", model: "claude-fable-5" },
    ]) {
      const { jsonl } = generateCodexJsonl({ ...data, conversation });
      const messages = parseCodexSessionFile(jsonl);
      expect(messages.every(message => message.model === undefined)).toBe(true);
      expect(jsonl).not.toContain('"turn_context"');
    }
  });
});
