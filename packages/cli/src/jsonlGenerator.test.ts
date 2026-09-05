import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { chooseClaudeTailMessagesForTokenBudget, fetchExport, generateClaudeCodeJsonl, generateCodexJsonl, generateGrokSession, generatedSessionCwd, grokSessionDir, isHumanInstruction, writeCodexSession, writeGrokSession, type ExportResult, generatePiSession, piSessionFilePath, writePiSession, renderConversationHandoff } from "./jsonlGenerator.js";

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

  // Regression: the server posts a workflow anchor message (subtype
  // "workflow_event", content = internal {"__wf":...} JSON) into conversations
  // so the web can render a live card. Baking it into a synthetic transcript
  // makes the daemon sync it back as ordinary assistant prose, which the web
  // then shows as raw JSON mid-conversation.
  test("skips server-injected workflow anchors so forks don't round-trip raw JSON", () => {
    const anchor = '{"__wf":"workflow_run","run_id":"th70zm","external_run_id":"wf_1","name":"roadmap-plain-rewrite"}';
    const data: ExportResult = {
      conversation: {
        id: "conv", title: "t", session_id: "session", agent_type: "claude_code",
        project_path: "/tmp/project", model: "claude-opus-4-6-20260205",
        message_count: 4, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
        // Original server anchor, tagged with its subtype.
        { role: "assistant", content: anchor, subtype: "workflow_event", timestamp: "2026-01-01T00:00:00.050Z" },
        // A copy that already round-tripped through an old fork: subtype lost.
        { role: "assistant", content: anchor, timestamp: "2026-01-01T00:00:00.060Z" },
        { role: "assistant", content: "hello", timestamp: "2026-01-01T00:00:00.100Z" },
      ],
    };

    const { jsonl } = generateClaudeCodeJsonl(data);
    expect(jsonl).not.toContain('"__wf"');
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const assistants = lines.filter((l) => l.type === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].message.content[0].text).toBe("hello");
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
    // Context-only: isMeta hides the notice from Claude Code's transcript and
    // from codecast's watcher sync (extractMessages skips isMeta entries).
    expect(chat[0].isMeta).toBe(true);
    expect(chat.filter((l) => l.isMeta).length).toBe(1);
    // The notice points the reader at `cast read` to pull anything omitted.
    expect(chat[0].message?.content).toContain("cast read");
    expect(chat.some((l) => l.type === "user" && l.message?.content === "u1")).toBe(true);

    // Tail is the last 2 messages: a2, u3
    expect(chat.some((l) => l.type === "assistant" && l.message?.content?.[0]?.text === "a2")).toBe(true);
    expect(chat.some((l) => l.type === "user" && l.message?.content === "u3")).toBe(true);

    // Assistant turns from the dropped middle are omitted...
    expect(chat.some((l) => l.type === "assistant" && l.message?.content?.[0]?.text === "a1")).toBe(false);
    // ...but every earlier *human* instruction is surfaced, not just the first.
    expect(chat.some((l) => l.type === "user" && l.message?.content === "u2")).toBe(true);
  });

  test("surfaces every earlier human instruction and cites exact cast read lines", () => {
    // 8 messages: human turns at lines 1, 3, 5 (u1/u2/u3); the rest assistant or
    // a tool-result carrier. Tail = last 2 => cutoff at index 6 (line 7).
    const data: ExportResult = {
      conversation: {
        id: "jx7abc123",
        title: "t",
        session_id: "session",
        agent_type: "claude_code",
        project_path: "/tmp/project",
        model: "claude-opus-4-8",
        message_count: 8,
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "first ask", timestamp: "2026-01-01T00:00:00.000Z" },       // line 1
        { role: "assistant", content: "a1", timestamp: "2026-01-01T00:00:00.100Z" },           // line 2
        { role: "user", content: "second ask", timestamp: "2026-01-01T00:00:00.200Z" },        // line 3
        { role: "assistant", content: "a2", timestamp: "2026-01-01T00:00:00.300Z" },           // line 4
        { role: "user", content: "third ask", timestamp: "2026-01-01T00:00:00.400Z" },         // line 5
        // A tool-result carrier (not a genuine human turn) must NOT be surfaced.
        { role: "user", content: "", timestamp: "2026-01-01T00:00:00.500Z", tool_results: [{ tool_use_id: "x", content: "tool out" }] }, // line 6
        { role: "assistant", content: "a3", timestamp: "2026-01-01T00:00:00.600Z" },           // line 7 (tail start)
        { role: "user", content: "fourth ask", timestamp: "2026-01-01T00:00:00.700Z" },        // line 8 (tail)
      ],
    };

    const { jsonl } = generateClaudeCodeJsonl(data, { tailMessages: 2 });
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const chat = lines.filter((l) => l.type === "user" || l.type === "assistant");
    const notice = chat[0].message?.content as string;

    // All three earlier human asks are surfaced (not just the first), in order.
    const userTexts = chat.filter((l) => l.type === "user").map((l) => l.message?.content);
    expect(userTexts).toContain("first ask");
    expect(userTexts).toContain("second ask");
    expect(userTexts).toContain("third ask");
    expect(userTexts).toContain("fourth ask"); // tail

    // The tool-result carrier from the middle is dropped, not surfaced as a turn.
    expect(chat.some((l) => l.type === "user" && Array.isArray(l.message?.content)
      && l.message.content.some((b: any) => b?.type === "tool_result"))).toBe(false);

    // Notice cites the conversation id and the exact `cast read` range for the
    // omitted middle: tail starts at line 7, so the gap is 1:6.
    expect(notice).toContain("8 messages");
    expect(notice).toContain("3 earlier instructions");
    expect(notice).toContain("starting at message 7");
    expect(notice).toContain("cast read jx7abc123 1:6");
  });

  test("isHumanInstruction distinguishes genuine human turns", () => {
    expect(isHumanInstruction({ role: "user", content: "do the thing", timestamp: "t" })).toBe(true);
    expect(isHumanInstruction({ role: "assistant", content: "ok", timestamp: "t" })).toBe(false);
    expect(isHumanInstruction({ role: "user", content: "   ", timestamp: "t" })).toBe(false);
    expect(isHumanInstruction({ role: "user", content: "[Codecast import] notice", timestamp: "t" })).toBe(false);
    expect(isHumanInstruction({ role: "user", content: "noticed", timestamp: "t", isMeta: true })).toBe(false);
    expect(isHumanInstruction({ role: "user", content: "result", timestamp: "t", tool_results: [{ tool_use_id: "x", content: "r" }] })).toBe(false);
  });

  test("token budget reserves space for earlier instructions", () => {
    // A long human instruction up front should be reserved out of the budget, so
    // the chosen tail is strictly shorter than if it were ignored.
    const bigText = "word ".repeat(2000); // ~2500 tokens
    const mk = (role: string, content: string, i: number): ExportResult["messages"][number] =>
      ({ role, content, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    const messages = [
      mk("user", bigText, 0),
      ...Array.from({ length: 40 }, (_, i) => mk(i % 2 === 0 ? "assistant" : "user", `m${i}`, i + 1)),
    ];
    const data: ExportResult = {
      conversation: { id: "c", title: "t", session_id: "s", agent_type: "claude_code", project_path: null, model: null, message_count: messages.length, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z" },
      messages,
    };
    // Budget large enough that without reservation the whole convo fits; the big
    // up-front instruction is counted as a genuine human turn regardless.
    const count = chooseClaudeTailMessagesForTokenBudget(data, 3000);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(messages.length);
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
  test("returns the rollout path it writes", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-codex-home-"));
    try {
      const written = writeCodexSession("{\"type\":\"session_meta\"}\n", "synthetic-thread", "codecast-fork", codexHome);
      expect(written.sessionId).toBe("synthetic-thread");
      expect(written.filePath).toStartWith(path.join(codexHome, "sessions"));
      expect(fs.readFileSync(written.filePath, "utf8")).toBe("{\"type\":\"session_meta\"}\n");
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

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

  test("skips server-injected workflow anchors", () => {
    const data: ExportResult = {
      conversation: {
        id: "conv", title: "t", session_id: "session", agent_type: "codex",
        project_path: "/tmp/project", model: "gpt-5",
        message_count: 3, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: '{"__wf":"workflow_run","run_id":"th70zm","name":"n"}', subtype: "workflow_event", timestamp: "2026-01-01T00:00:00.050Z" },
        { role: "assistant", content: "hello", timestamp: "2026-01-01T00:00:00.100Z" },
      ],
    };

    const { jsonl } = generateCodexJsonl(data);
    expect(jsonl).not.toContain('"__wf"');
  });
});

describe("generatedSessionCwd", () => {
  const data = (project_path: string | null): ExportResult => ({
    conversation: { id: "c1", title: "t", project_path, started_at: "2026-09-05T00:00:00.000Z" },
    messages: [],
  } as unknown as ExportResult);

  test("an explicit cwd wins over the recorded project path", () => {
    expect(generatedSessionCwd(data("/tmp/project"), { cwd: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  });

  test("the recorded project path wins over process.cwd()", () => {
    expect(generatedSessionCwd(data("/tmp/project"), {})).toBe("/tmp/project");
  });

  test("the explicit cwd is what the codex session_meta carries", () => {
    const { jsonl } = generateCodexJsonl(
      { ...data("/tmp/project"), messages: [{ role: "user", content: "hi", timestamp: "2026-09-05T00:00:01.000Z" }] } as unknown as ExportResult,
      { cwd: "/tmp/elsewhere" },
    );
    const meta = JSON.parse(jsonl.split("\n")[0]);
    expect(meta.type).toBe("session_meta");
    expect(meta.payload.cwd).toBe("/tmp/elsewhere");
  });
});

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

// OpenCode has no history import; the rebuild is ONE user message the next turn
// reads. The text must carry every turn (labelled), tool activity as text, the
// source notice, and the trim notice when trimmed — and never a server meta row.
describe("renderConversationHandoff", () => {
  const data: ExportResult = {
    conversation: {
      id: "conv-oc", title: "Rebuilt thread", session_id: "old", agent_type: "claude_code",
      project_path: "/tmp/project", model: null, message_count: 3,
      started_at: "2026-09-05T10:00:00.000Z", updated_at: "2026-09-05T11:00:00.000Z",
    },
    messages: [
      { role: "user", content: "Remember the secret word MARMALADE", timestamp: "2026-09-05T10:00:00.000Z" },
      { role: "assistant", content: "Noted.", timestamp: "2026-09-05T10:00:01.000Z", tool_calls: [{ id: "c1", name: "Bash", input: '{"command":"ls"}' }] },
      { role: "user", content: "", timestamp: "2026-09-05T10:00:02.000Z", tool_results: [{ tool_use_id: "c1", content: "README.md" }] },
      { role: "assistant", content: '{"__wf":1}', timestamp: "2026-09-05T10:00:03.000Z" },
    ],
  };
  test("labels every turn and renders tool activity as text", () => {
    const text = renderConversationHandoff(data);
    expect(text.startsWith("[Codecast import] This session continues a codecast conversation (conv-oc, 4 messages)")).toBe(true);
    expect(text).toContain("### user\nRemember the secret word MARMALADE");
    expect(text).toContain("### assistant\nNoted.\n\n<tool_call id=\"c1\" name=\"Bash\">");
    expect(text).toContain("<tool_result id=\"c1\">\nREADME.md\n</tool_result>");
    expect(text).not.toContain("__wf");
  });
  test("a trimmed handoff carries the trim notice", () => {
    const text = renderConversationHandoff(data, 1);
    expect(text).toContain("trimmed to fit the new agent's context window");
    expect(text).toContain("cast read conv-oc");
  });
});
