import { afterEach, describe, expect, test } from "bun:test";
import { fetchExport, generateClaudeCodeJsonl, generateCodexJsonl, type ExportResult } from "./jsonlGenerator.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchExport", () => {
  test("aggregates paginated export responses", async () => {
    const requestBodies: Array<{ api_token?: string; conversation_id?: string; cursor?: string; limit?: number }> = [];
    let call = 0;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requestBodies.push(body);
      call += 1;

      if (call === 1) {
        return new Response(JSON.stringify({
          conversation: {
            id: "conv1",
            title: "Conversation",
            session_id: "session-1",
            agent_type: "claude_code",
            project_path: "/tmp/project",
            model: "claude",
            message_count: 3,
            started_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:01.000Z",
          },
          messages: [
            { role: "user", content: "a", timestamp: "2026-01-01T00:00:00.000Z" },
            { role: "assistant", content: "b", timestamp: "2026-01-01T00:00:00.100Z" },
          ],
          next_cursor: "cursor-1",
          done: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        conversation: {
          id: "conv1",
          title: "Conversation",
          session_id: "session-1",
          agent_type: "claude_code",
          project_path: "/tmp/project",
          model: "claude",
          message_count: 3,
          started_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
        },
        messages: [
          { role: "user", content: "c", timestamp: "2026-01-01T00:00:00.200Z" },
        ],
        next_cursor: null,
        done: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await fetchExport("https://example.site", "token", "conv1");

    expect(result.messages).toHaveLength(3);
    expect(result.messages[2].content).toBe("c");
    expect(requestBodies).toEqual([
      { api_token: "token", conversation_id: "conv1", limit: 500 },
      { api_token: "token", conversation_id: "conv1", cursor: "cursor-1", limit: 500 },
    ]);
  });

  test("supports single-page export responses", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        conversation: {
          id: "conv2",
          title: "Single page",
          session_id: "session-2",
          agent_type: "claude_code",
          project_path: null,
          model: null,
          message_count: 1,
          started_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
        },
        messages: [
          { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await fetchExport("https://example.site", "token", "conv2");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("hello");
  });

  test("includes server details in export failures", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        error: "Internal error",
        details: "Unexpected backend failure",
      }), { status: 500, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(fetchExport("https://example.site", "token", "conv3")).rejects.toThrow(
      "Export failed: Internal error (Unexpected backend failure)"
    );
  });

  test("falls back to read API when export hits array-length limit", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/cli/export")) {
        return new Response(JSON.stringify({
          error: "Internal error",
          details: "Function conversations.js:exportConversationMessages return value invalid: Array length is too long (10239 > maximum length 8192)",
        }), { status: 500, headers: { "Content-Type": "application/json" } });
      }

      const body = JSON.parse(String(init?.body ?? "{}"));
      const startLine = body.start_line ?? 1;
      const endLine = body.end_line ?? 50;
      const count = endLine - startLine + 1;
      const messages = Array.from({ length: count }, (_, i) => {
        const line = startLine + i;
        if (line > 55) return null;
        return {
          role: line % 2 === 0 ? "assistant" : "user",
          content: `line ${line}`,
          timestamp: `2026-01-01T00:00:${String(line).padStart(2, "0")}.000Z`,
        };
      }).filter(Boolean);

      return new Response(JSON.stringify({
        conversation: {
          id: "conv4",
          title: "Fallback conversation",
          project_path: "/tmp/project",
          message_count: 55,
          updated_at: "2026-01-01T00:02:00.000Z",
        },
        messages,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await fetchExport("https://example.site", "token", "conv4");

    expect(result.messages).toHaveLength(55);
    expect(result.messages[0].content).toBe("line 1");
    expect(result.messages[54].content).toBe("line 55");
    expect(result.conversation.title).toBe("Fallback conversation");
  });

  test("retries transient 500s before succeeding", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(JSON.stringify({ error: "Internal error", details: "temporary" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        conversation: {
          id: "conv5",
          title: "Retry conversation",
          session_id: "session-5",
          agent_type: "claude_code",
          project_path: null,
          model: null,
          message_count: 1,
          started_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
        },
        messages: [
          { role: "user", content: "ok", timestamp: "2026-01-01T00:00:00.000Z" },
        ],
        done: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await fetchExport("https://example.site", "token", "conv5");
    expect(result.messages).toHaveLength(1);
    expect(calls).toBe(3);
  });
});

describe("generateClaudeCodeJsonl", () => {
  test("uses provided sessionId in all entries", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv", title: "t", session_id: "session", agent_type: "codex",
        project_path: "/tmp/project", model: "claude-opus-4-6-20260205",
        message_count: 2, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: "hello", timestamp: "2026-01-01T00:00:00.100Z" },
      ],
    };

    const customId = "598dcda2-a20b-4b3a-9a89-d597331a3e2d";
    const { jsonl, sessionId } = generateClaudeCodeJsonl(data, { sessionId: customId });
    expect(sessionId).toBe(customId);
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    for (const line of lines) {
      if (line.sessionId) expect(line.sessionId).toBe(customId);
    }
  });

  test("emits thinking blocks in assistant content", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv",
        title: "t",
        session_id: "session",
        agent_type: "codex",
        project_path: "/tmp/project",
        model: "claude-opus-4-6-20260205",
        message_count: 2,
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: "hello", thinking: "internal reasoning", timestamp: "2026-01-01T00:00:00.100Z" },
      ],
    };

    const { jsonl } = generateClaudeCodeJsonl(data);
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const assistant = lines.find((l) => l.type === "assistant") as any;
    expect(assistant?.message?.role).toBe("assistant");
    expect(Array.isArray(assistant?.message?.content)).toBe(true);
    const thinkingBlock = assistant.message.content.find((b: any) => b?.type === "thinking");
    expect(thinkingBlock).toBeTruthy();
    expect(thinkingBlock.thinking).toBe("internal reasoning");
  });

  test("can truncate to tail messages for Claude imports", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv",
        title: "t",
        session_id: "session",
        agent_type: "codex",
        project_path: "/tmp/project",
        model: "claude-opus-4-6-20260205",
        message_count: 10,
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "u1", timestamp: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: "a1", timestamp: "2026-01-01T00:00:00.100Z" },
        { role: "user", content: "u2", timestamp: "2026-01-01T00:00:00.200Z" },
        { role: "assistant", content: "a2", timestamp: "2026-01-01T00:00:00.300Z" },
        { role: "user", content: "u3", timestamp: "2026-01-01T00:00:00.400Z" },
      ],
    };

    const { jsonl } = generateClaudeCodeJsonl(data, { tailMessages: 2 });
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const chat = lines.filter((l) => l.type === "user" || l.type === "assistant");

    expect(chat[0].type).toBe("user");
    expect(chat[0].message?.content).toContain("[Codecast import]");
    expect(chat.some((l) => l.type === "user" && l.message?.content === "u1")).toBe(true);

    // Tail is the last 2 messages: a2, u3
    expect(chat.some((l) => l.type === "assistant" && l.message?.content?.[0]?.text === "a2")).toBe(true);
    expect(chat.some((l) => l.type === "user" && l.message?.content === "u3")).toBe(true);

    // Mid history should be omitted.
    expect(chat.some((l) => l.type === "assistant" && l.message?.content?.[0]?.text === "a1")).toBe(false);
    expect(chat.some((l) => l.type === "user" && l.message?.content === "u2")).toBe(false);
  });

  test("preserves all tool_result blocks including orphans", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv",
        title: "t",
        session_id: "session",
        agent_type: "codex",
        project_path: "/tmp/project",
        model: "claude-opus-4-6-20260205",
        message_count: 4,
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        {
          role: "user",
          content: "",
          timestamp: "2026-01-01T00:00:00.000Z",
          tool_results: [{ tool_use_id: "orphan_0", content: "orphan start" }],
        },
        {
          role: "assistant",
          content: "Running tool",
          timestamp: "2026-01-01T00:00:00.100Z",
          tool_calls: [{ id: "call_1", name: "Bash", input: "{\"command\":\"echo hi\"}" }],
        },
        {
          role: "user",
          content: "done",
          timestamp: "2026-01-01T00:00:00.200Z",
          tool_results: [
            { tool_use_id: "call_1", content: "ok" },
            { tool_use_id: "orphan_1", content: "orphan trailing" },
          ],
        },
        {
          role: "assistant",
          content: "complete",
          timestamp: "2026-01-01T00:00:00.300Z",
        },
      ],
    };

    const { jsonl } = generateClaudeCodeJsonl(data);
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const userEntries = lines.filter((l) => l.type === "user");

    const toolResultIds: string[] = [];
    for (const entry of userEntries) {
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "tool_result" && typeof block?.tool_use_id === "string") {
          toolResultIds.push(block.tool_use_id);
        }
      }
    }

    // All tool results should be preserved — orphans included
    expect(toolResultIds).toEqual(["orphan_0", "call_1", "orphan_1"]);
  });

  test("preserves tool_result blocks even when truncation removes the matching tool_use", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv",
        title: "t",
        session_id: "session",
        agent_type: "codex",
        project_path: "/tmp/project",
        model: "claude-opus-4-6-20260205",
        message_count: 4,
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "u1", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          role: "assistant",
          content: "tool call",
          timestamp: "2026-01-01T00:00:00.100Z",
          tool_calls: [{ id: "call_2", name: "Bash", input: "{\"command\":\"pwd\"}" }],
        },
        {
          role: "user",
          content: "",
          timestamp: "2026-01-01T00:00:00.200Z",
          tool_results: [{ tool_use_id: "call_2", content: "first result" }],
        },
        {
          role: "user",
          content: "",
          timestamp: "2026-01-01T00:00:00.300Z",
          tool_results: [{ tool_use_id: "call_2", content: "duplicate result" }],
        },
      ],
    };

    // Truncation to last 1 message keeps only the last user message with tool_result.
    // The tool_result is preserved as an orphan (matching tool_use was truncated away).
    const { jsonl } = generateClaudeCodeJsonl(data, { tailMessages: 1 });
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const userEntries = lines.filter((l) => l.type === "user");

    const toolResults = userEntries.flatMap((entry) => {
      const content = entry?.message?.content;
      if (!Array.isArray(content)) return [];
      return content.filter((block) => block?.type === "tool_result");
    });

    expect(toolResults.length).toBe(1);
    expect(toolResults[0].tool_use_id).toBe("call_2");
  });

  test("keeps consecutive assistant messages separate to preserve message-level structure", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv", title: "t", session_id: "session", agent_type: "claude_code",
        project_path: "/tmp/project", model: "claude-opus-4-6-20260205",
        message_count: 5, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: "thinking about it", timestamp: "2026-01-01T00:00:00.100Z" },
        {
          role: "assistant", content: "",
          timestamp: "2026-01-01T00:00:00.200Z",
          tool_calls: [{ id: "call_1", name: "Bash", input: '{"command":"echo hi"}' }],
        },
        {
          role: "user", content: "",
          timestamp: "2026-01-01T00:00:00.300Z",
          tool_results: [{ tool_use_id: "call_1", content: "hi" }],
        },
        { role: "assistant", content: "done", timestamp: "2026-01-01T00:00:00.400Z" },
      ],
    };

    const { jsonl } = generateClaudeCodeJsonl(data);
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));

    const assistants = lines.filter((l) => l.type === "assistant");
    // Text-only assistant and tool_use assistant should be separate entries
    expect(assistants.length).toBe(3);

    const textAssistant = assistants.find((a) => {
      const content = a.message?.content;
      return Array.isArray(content) &&
        content.some((b: any) => b.type === "text" && b.text === "thinking about it");
    });
    expect(textAssistant).toBeTruthy();

    const toolAssistant = assistants.find((a) => {
      const content = a.message?.content;
      return Array.isArray(content) &&
        content.some((b: any) => b.type === "tool_use" && b.name === "Bash");
    });
    expect(toolAssistant).toBeTruthy();
    // They should NOT be merged into the same entry
    expect(textAssistant).not.toBe(toolAssistant);
  });

  test("emits only the tool_results that exist, does not synthesize placeholders", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv", title: "t", session_id: "session", agent_type: "claude_code",
        project_path: "/tmp/project", model: "claude-opus-4-6-20260205",
        message_count: 4, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "check files", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          role: "assistant", content: "",
          timestamp: "2026-01-01T00:00:00.100Z",
          tool_calls: [
            { id: "call_read", name: "Read", input: '{"path":"a.txt"}' },
            { id: "call_bash", name: "Bash", input: '{"command":"ls"}' },
            { id: "call_grep", name: "Grep", input: '{"pattern":"foo"}' },
          ],
        },
        {
          role: "user", content: "",
          timestamp: "2026-01-01T00:00:00.200Z",
          tool_results: [{ tool_use_id: "call_grep", content: "found match" }],
        },
        { role: "assistant", content: "done", timestamp: "2026-01-01T00:00:00.300Z" },
      ],
    };

    const { jsonl } = generateClaudeCodeJsonl(data);
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const userEntries = lines.filter((l) => l.type === "user");

    const allToolResults: Array<{ tool_use_id: string; is_error?: boolean }> = [];
    for (const entry of userEntries) {
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "tool_result") {
          allToolResults.push({ tool_use_id: block.tool_use_id, is_error: block.is_error });
        }
      }
    }

    // Only the actual tool_result should appear — no synthesized placeholders
    const resultIds = allToolResults.map((r) => r.tool_use_id);
    expect(resultIds).toEqual(["call_grep"]);

    const realResult = allToolResults.find((r) => r.tool_use_id === "call_grep");
    expect(realResult?.is_error).toBeUndefined();
  });

  test("does not add trailing placeholder when session ends with dangling tool_use", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv", title: "t", session_id: "session", agent_type: "claude_code",
        project_path: "/tmp/project", model: "claude-opus-4-6-20260205",
        message_count: 2, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "do it", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          role: "assistant", content: "running",
          timestamp: "2026-01-01T00:00:00.100Z",
          tool_calls: [{ id: "call_dangling", name: "Bash", input: '{"command":"echo"}' }],
        },
      ],
    };

    const { jsonl } = generateClaudeCodeJsonl(data);
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));

    // The last entry should be the assistant message, not a synthetic user message
    const chatLines = lines.filter((l) => l.type === "user" || l.type === "assistant");
    const lastChat = chatLines[chatLines.length - 1];
    expect(lastChat.type).toBe("assistant");

    // No synthetic tool_result for the dangling tool_use
    const userWithDangling = lines.find((l) => {
      const content = l.message?.content;
      return Array.isArray(content) && content.some((b: any) => b.tool_use_id === "call_dangling");
    });
    expect(userWithDangling).toBeUndefined();
  });
});

describe("generateCodexJsonl", () => {
  test("uses provided session id in session_meta payload", () => {
    const forcedSessionId = "019c95d9-ef8b-7d43-b08f-647d85b2e5a6";
    const data: ExportResult = {
      conversation: {
        id: "conv",
        title: "t",
        session_id: "session",
        agent_type: "codex",
        project_path: "/tmp/project",
        model: "gpt-5",
        message_count: 2,
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: "hello", timestamp: "2026-01-01T00:00:00.100Z" },
      ],
    };

    const { jsonl, sessionId } = generateCodexJsonl(data, { sessionId: forcedSessionId });
    expect(sessionId).toBe(forcedSessionId);

    const firstLine = JSON.parse(jsonl.trim().split("\n")[0]) as {
      type?: string;
      payload?: { id?: string };
    };
    expect(firstLine.type).toBe("session_meta");
    expect(firstLine.payload?.id).toBe(forcedSessionId);
  });
});
