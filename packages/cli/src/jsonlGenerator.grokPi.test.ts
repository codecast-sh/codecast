import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateGrokSession, generatePiSession, grokSessionDir, piSessionFilePath, writeGrokSession, writePiSession, type ExportResult } from "./jsonlGenerator.js";

// A rebuilt grok session is a directory under ~/.grok/sessions/<encoded cwd>/<uuid>/
// whose chat_history.jsonl (chat_format_version 1) is the model context grok
// resumes from — live-verified: a bundle of chat_history.jsonl + summary.json +
// empty updates.jsonl resumes and the model answers from the written history.
describe("generateGrokSession / writeGrokSession", () => {
  const data: ExportResult = {
    conversation: {
      id: "conv-grok", title: "Rebuilt thread", session_id: "old-claude-id", agent_type: "claude_code",
      project_path: "/tmp/project", model: "claude-fable-5-1", message_count: 4,
      started_at: "2026-09-05T10:00:00.000Z", updated_at: "2026-09-05T11:00:00.000Z",
    },
    messages: [
      { role: "user", content: "Remember the secret word MARMALADE", timestamp: "2026-09-05T10:00:00.000Z" },
      { role: "assistant", content: "Noted.", timestamp: "2026-09-05T10:00:01.000Z",
        tool_calls: [{ id: "call_1", name: "Bash", input: '{"command":"ls"}' }] },
      { role: "user", content: "", timestamp: "2026-09-05T10:00:02.000Z",
        tool_results: [{ tool_use_id: "call_1", content: "README.md", is_error: false }] },
      { role: "assistant", content: '{"__wf":1}', timestamp: "2026-09-05T10:00:03.000Z" },
      { role: "assistant", content: "One file.", timestamp: "2026-09-05T10:00:04.000Z" },
    ],
  };

  test("writes user prompts inside <user_query>, tool activity as text, and skips server meta rows", () => {
    const files = generateGrokSession(data, { sessionId: "e1d4009c-ee25-4e8e-9090-5671b3a134e6" });
    const lines = files.chatHistoryJsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(files.cwd).toBe("/tmp/project");
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(lines[0].prompt_index).toBe(0);
    expect(lines[0].content[0].text).toBe("<user_query>\nRemember the secret word MARMALADE\n</user_query>");
    expect(lines[1].content).toContain("Noted.");
    expect(lines[1].content).toContain('<tool_call id="call_1" name="Bash">');
    expect(lines[2].synthetic_reason).toBe("system_reminder");
    expect(lines[2].content[0].text).toContain("README.md");
    expect(files.chatHistoryJsonl).not.toContain("__wf");
    const summary = JSON.parse(files.summaryJson);
    expect(summary.info).toEqual({ id: "e1d4009c-ee25-4e8e-9090-5671b3a134e6", cwd: "/tmp/project" });
    expect(summary.chat_format_version).toBe(1);
    expect(summary.current_model_id).toBe("grok-4.6");
    expect(summary.generated_title).toBe("Rebuilt thread");
  });

  test("keeps a grok source's own model and mints a UUID when none is given", () => {
    const files = generateGrokSession({ ...data, conversation: { ...data.conversation, agent_type: "grok", model: "grok-4.5" } });
    expect(files.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(JSON.parse(files.summaryJson).current_model_id).toBe("grok-4.5");
  });

  test("tail trim keeps earlier instructions and prepends the import notice as a reminder", () => {
    const files = generateGrokSession(data, { tailMessages: 1 });
    const lines = files.chatHistoryJsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].synthetic_reason).toBe("system_reminder");
    expect(lines[0].content[0].text).toContain("trimmed to fit Grok's context window");
    expect(lines[0].content[0].text).toContain("cast read conv-grok");
    expect(lines[1].content[0].text).toContain("MARMALADE");
    expect(lines[lines.length - 1].content).toBe("One file.");
  });

  test("writes the bundle under the encoded cwd with an empty updates.jsonl to watch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const files = generateGrokSession(data, { sessionId: "2cbdb767-64d4-4801-9e11-826017eacb50" });
    const { filePath } = writeGrokSession(files, home);
    const dir = grokSessionDir("/tmp/project", "2cbdb767-64d4-4801-9e11-826017eacb50", home);
    expect(dir).toBe(path.join(home, "sessions", "%2Ftmp%2Fproject", "2cbdb767-64d4-4801-9e11-826017eacb50"));
    expect(filePath).toBe(path.join(dir, "updates.jsonl"));
    expect(fs.readFileSync(filePath, "utf-8")).toBe("");
    expect(fs.readFileSync(path.join(dir, "chat_history.jsonl"), "utf-8")).toBe(files.chatHistoryJsonl);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf-8")).info.cwd).toBe("/tmp/project");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// A rebuilt pi session is one JSONL: a version-3 `session` header, then a
// parentId-linked chain pi walks from the last entry — live-verified: pi renders
// a written chain and appends its own bookkeeping entries on load.
describe("generatePiSession / writePiSession", () => {
  const data: ExportResult = {
    conversation: {
      id: "conv-pi", title: "Rebuilt thread", session_id: "old-claude-id", agent_type: "claude_code",
      project_path: "/tmp/project", model: "claude-fable-5-1", message_count: 4,
      started_at: "2026-09-05T10:00:00.000Z", updated_at: "2026-09-05T11:00:00.000Z",
    },
    messages: [
      { role: "user", content: "Remember the secret word MARMALADE", timestamp: "2026-09-05T10:00:00.000Z" },
      { role: "assistant", content: "Noted.", timestamp: "2026-09-05T10:00:01.000Z",
        tool_calls: [{ id: "call_1", name: "Bash", input: '{"command":"ls"}' }] },
      { role: "user", content: "", timestamp: "2026-09-05T10:00:02.000Z",
        tool_results: [{ tool_use_id: "call_1", content: "README.md", is_error: false }] },
      { role: "assistant", content: '{"__wf":1}', timestamp: "2026-09-05T10:00:03.000Z" },
      { role: "assistant", content: "One file.", timestamp: "2026-09-05T10:00:04.000Z" },
    ],
  };

  test("writes a version-3 header and a parentId chain with pi tool blocks", () => {
    const { jsonl, sessionId, cwd } = generatePiSession(data, { sessionId: "471d789b-b84f-4427-908d-9c5ee65d06e7" });
    const entries = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(cwd).toBe("/tmp/project");
    expect(entries[0]).toEqual({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-05T10:00:00.000Z", cwd: "/tmp/project" });
    const chain = entries.slice(1);
    expect(chain.map((e) => e.message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(chain[0].parentId).toBeNull();
    for (let i = 1; i < chain.length; i++) expect(chain[i].parentId).toBe(chain[i - 1].id);
    expect(chain[0].message.content).toEqual([{ type: "text", text: "Remember the secret word MARMALADE" }]);
    expect(chain[1].message.content[1]).toEqual({ type: "toolCall", id: "call_1", name: "Bash", arguments: { command: "ls" } });
    expect(chain[1].message.stopReason).toBe("toolUse");
    // pi's footer sums usage over every assistant entry at render; a missing
    // usage crashes the TUI on load.
    expect(chain[1].message.usage.cost.total).toBe(0);
    expect(chain[3].message.usage.input).toBe(0);
    expect(chain[2].message).toMatchObject({ role: "toolResult", toolCallId: "call_1", toolName: "Bash", content: [{ type: "text", text: "README.md" }] });
    expect(chain[3].message.stopReason).toBe("stop");
    expect(jsonl).not.toContain("__wf");
  });

  test("stamps the requested model on assistant entries so pi restores it", () => {
    const { jsonl } = generatePiSession(data, { model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" } });
    const assistant = jsonl.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.message?.role === "assistant");
    expect(assistant.message.provider).toBe("anthropic");
    expect(assistant.message.model).toBe("claude-sonnet-4-20250514");
  });

  test("entries reuse the original message uuids so a re-parse upserts, never duplicates", () => {
    const withUuids: ExportResult = { ...data, messages: data.messages.map((m, i) => ({ ...m, message_uuid: `orig-${i}` })) };
    const { jsonl } = generatePiSession(withUuids);
    const chain = jsonl.trim().split("\n").map((l) => JSON.parse(l)).slice(1);
    expect(chain.map((e) => e.id)).toEqual(["orig-0", "orig-1", expect.stringMatching(/^[0-9a-f]{8}$/), "orig-4"]);
    for (let i = 1; i < chain.length; i++) expect(chain[i].parentId).toBe(chain[i - 1].id);
  });

  test("tail trim prepends the import notice as a user entry", () => {
    const { jsonl } = generatePiSession(data, { tailMessages: 1 });
    const entries = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries[1].message.role).toBe("user");
    expect(entries[1].message.content[0].text).toContain("trimmed to fit pi's context window");
    expect(entries[entries.length - 1].message.content[0].text).toBe("One file.");
  });

  test("writes under pi's cwd slug with the <ts>_<uuid>.jsonl name the watcher expects", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"));
    const { jsonl, sessionId } = generatePiSession(data, { sessionId: "2cbdb767-64d4-4801-9e11-826017eacb50" });
    const { filePath } = writePiSession(jsonl, sessionId, "/tmp/project", home);
    expect(path.dirname(filePath)).toBe(path.join(home, "sessions", "--tmp-project--"));
    expect(path.basename(filePath)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_2cbdb767-64d4-4801-9e11-826017eacb50\.jsonl$/);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(jsonl);
    expect(piSessionFilePath("/tmp/project", sessionId, home).startsWith(path.join(home, "sessions", "--tmp-project--"))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
