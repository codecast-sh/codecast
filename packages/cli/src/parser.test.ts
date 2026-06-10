import { describe, test, expect, mock } from "bun:test";
import { parseSessionLine, parseLine, parseCodexLine, extractMessages, parseSessionFile, parseCodexSessionFile, type ClaudeSessionEntry } from "./parser.js";

describe("Parser malformed JSON handling", () => {
  test("parseSessionLine logs warning and returns null for malformed JSON", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseSessionLine('this is not valid json');

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalled();
    const calls = consoleWarnSpy.mock.calls as unknown[][];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0][0]).toContain('[parser] Failed to parse session line');
    expect(calls[1][0]).toContain('[parser] Line content:');

    console.warn = originalWarn;
  });

  test("parseSessionLine handles valid JSON correctly", () => {
    const validJson = '{"type":"user","message":{"role":"user","content":"test"},"timestamp":"2025-12-24T00:00:00.000Z"}';
    const result = parseSessionLine(validJson);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("user");
  });

  test("parseSessionLine returns null for empty lines without logging", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseSessionLine('   ');

    expect(result).toBeNull();
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    console.warn = originalWarn;
  });

  test("parseLine logs warning for malformed JSON", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseLine('invalid json {{{');

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalled();

    console.warn = originalWarn;
  });

  test("parseCodexLine logs warning for malformed JSON", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseCodexLine('not valid json');

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalled();

    console.warn = originalWarn;
  });

  test("parseSessionLine truncates long malformed lines in warning", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const longLine = 'x'.repeat(200);
    parseSessionLine(longLine);

    expect(consoleWarnSpy).toHaveBeenCalled();
    const calls = consoleWarnSpy.mock.calls as unknown[][];
    const contentWarning = calls[1][0] as string;
    expect(contentWarning.length).toBeLessThan(longLine.length + 50);
    expect(contentWarning).toContain('...');

    console.warn = originalWarn;
  });
});

describe("parser - codex images", () => {
  test("extracts user inline image blocks and strips codex image tags from text", () => {
    const jsonl = JSON.stringify({
      timestamp: "2026-02-25T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<image name=[Image #1]>\n</image>\nPlease inspect this" },
          { type: "input_image", image_url: "data:image/png;base64,QUJDRA==" },
        ],
      },
    });

    const messages = parseCodexSessionFile(jsonl);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Please inspect this");
    expect(messages[0].images).toHaveLength(1);
    expect(messages[0].images?.[0]).toEqual({
      mediaType: "image/png",
      data: "QUJDRA==",
    });
  });

  test("extracts tool output images and associates them to tool call ids", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-25T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "browser-tools.screenshot",
          call_id: "call_1",
          arguments: "{\"fullPage\":true}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "output_text", text: "captured image" },
            { type: "input_image", image_url: "data:image/jpeg;base64,AAAA" },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      }),
    ];

    const messages = parseCodexSessionFile(lines.join("\n"));

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].toolCalls?.[0].id).toBe("call_1");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].toolResults).toHaveLength(1);
    expect(messages[1].toolResults?.[0]).toEqual({
      toolUseId: "call_1",
      content: "captured image",
    });
    expect(messages[1].images).toHaveLength(1);
    expect(messages[1].images?.[0]).toEqual({
      mediaType: "image/jpeg",
      data: "AAAA",
      toolUseId: "call_1",
    });
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toBe("Done.");
  });

  test("preserves raw function_call arguments for apply_patch", () => {
    const rawPatch = "*** Begin Patch\n*** Update File: src/test.ts\n@@\n-foo\n+bar\n*** End Patch";
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-25T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "apply_patch",
          call_id: "call_patch_1",
          arguments: rawPatch,
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_patch_1",
          output: "{\"output\":\"Success\"}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      }),
    ];

    const messages = parseCodexSessionFile(lines.join("\n"));
    expect(messages).toHaveLength(3);
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].toolCalls?.[0]).toEqual({
      id: "call_patch_1",
      name: "apply_patch",
      input: { input: rawPatch },
    });
  });

  test("preserves codex assistant/tool interleaving instead of flattening one whole turn", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-25T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I’m checking the docs first." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call_docs",
          arguments: "{\"cmd\":\"rg README.md\"}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_docs",
          output: "README.md",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The main overview is in README.md." }],
        },
      }),
    ];

    const messages = parseCodexSessionFile(lines.join("\n"));

    expect(messages).toHaveLength(4);
    expect(messages.map((msg) => msg.role)).toEqual(["assistant", "assistant", "assistant", "assistant"]);
    expect(messages[0].content).toBe("I’m checking the docs first.");
    expect(messages[1].toolCalls?.[0].name).toBe("exec_command");
    expect(messages[2].toolResults?.[0]).toEqual({
      toolUseId: "call_docs",
      content: "README.md",
    });
    expect(messages[3].content).toBe("The main overview is in README.md.");
  });

  test("assigns stable UUIDs from codex response item ids and call ids", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-25T00:00:00.000Z",
        type: "response_item",
        payload: {
          id: "user_1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run tests" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:01.000Z",
        type: "response_item",
        payload: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I’ll run them." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call_1",
          arguments: "{\"cmd\":\"bun test\"}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "ok",
        },
      }),
    ];

    const first = parseCodexSessionFile(lines.join("\n"));
    const second = parseCodexSessionFile(lines.join("\n"));

    expect(first.map((m) => m.uuid)).toEqual([
      "codex-message-user_1",
      "codex-message-msg_1",
      "codex-function-call-call_1",
      "codex-function-output-call_1",
    ]);
    expect(second.map((m) => m.uuid)).toEqual(first.map((m) => m.uuid));
  });

  test("synthesizes stable UUIDs for codex items without ids", () => {
    const jsonl = JSON.stringify({
      timestamp: "2026-02-25T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "No explicit id" }],
      },
    });

    const first = parseCodexSessionFile(jsonl);
    const second = parseCodexSessionFile(jsonl);
    const withEarlierLine = parseCodexSessionFile([
      JSON.stringify({
        timestamp: "2026-02-24T23:59:59.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Earlier item" }],
        },
      }),
      jsonl,
    ].join("\n"));

    expect(first).toHaveLength(1);
    expect(first[0].uuid).toMatch(/^codex-message-/);
    expect(second[0].uuid).toBe(first[0].uuid);
    expect(withEarlierLine[1].uuid).toBe(first[0].uuid);
  });
});

describe("parser - thinking content extraction", () => {
  test("extracts thinking content from assistant message", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "test-uuid-1",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me analyze this problem step by step.",
            },
            {
              type: "text",
              text: "Here's my response.",
            },
          ],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].thinking).toBe("Let me analyze this problem step by step.");
    expect(messages[0].content).toBe("Here's my response.");
  });

  test("handles multiple thinking blocks", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "test-uuid-2",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "First thought. ",
            },
            {
              type: "thinking",
              thinking: "Second thought.",
            },
            {
              type: "text",
              text: "Final answer.",
            },
          ],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe("First thought. Second thought.");
    expect(messages[0].content).toBe("Final answer.");
  });

  test("handles thinking without text content", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "test-uuid-3",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Just thinking, no response yet.",
            },
          ],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe("Just thinking, no response yet.");
    expect(messages[0].content).toBe("");
  });

  test("handles text without thinking", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "test-uuid-4",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Direct response without thinking.",
            },
          ],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBeUndefined();
    expect(messages[0].content).toBe("Direct response without thinking.");
  });

  test("handles thinking with tool calls", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "test-uuid-5",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "I need to use a tool for this.",
            },
            {
              type: "text",
              text: "Let me check that for you.",
            },
            {
              type: "tool_use",
              id: "tool-1",
              name: "read_file",
              input: { path: "/test/file.txt" },
            },
          ],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe("I need to use a tool for this.");
    expect(messages[0].content).toBe("Let me check that for you.");
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].toolCalls?.[0].name).toBe("read_file");
  });

  test("parses JSONL with thinking blocks", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      uuid: "test-uuid-6",
      timestamp: "2024-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Analyzing the request.",
          },
          {
            type: "text",
            text: "Here's what I found.",
          },
        ],
      },
    });

    const messages = parseSessionFile(jsonl);

    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe("Analyzing the request.");
    expect(messages[0].content).toBe("Here's what I found.");
  });

  test("handles string content (no thinking)", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "user",
        uuid: "test-uuid-7",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content: "Simple string message",
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Simple string message");
    expect(messages[0].thinking).toBeUndefined();
  });

  test("preserves message uuid", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "preserved-uuid",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Some thinking.",
            },
            {
              type: "text",
              text: "Some text.",
            },
          ],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].uuid).toBe("preserved-uuid");
  });

  test("handles empty thinking string", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "test-uuid-8",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "",
            },
            {
              type: "text",
              text: "Response text.",
            },
          ],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBeUndefined();
    expect(messages[0].content).toBe("Response text.");
  });

  test("real-world example with mixed content", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "real-world-uuid",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "The user is asking about file parsing. I should check the current implementation first before suggesting changes.",
            },
            {
              type: "text",
              text: "Let me examine the parser to understand the current implementation.",
            },
            {
              type: "tool_use",
              id: "toolu_01ABC123",
              name: "Read",
              input: {
                file_path: "/src/parser.ts",
              },
            },
          ],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].thinking).toContain("should check the current implementation");
    expect(messages[0].content).toContain("examine the parser");
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].toolCalls?.[0].name).toBe("Read");
  });

  test("keeps a slash command's isMeta expansion (the command's .md body)", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "user",
        uuid: "cmd-invocation",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content:
            "<command-message>learn</command-message>\n<command-name>/learn</command-name>\n<command-args>just testing</command-args>",
        },
      },
      {
        type: "user",
        uuid: "cmd-expansion",
        isMeta: true,
        timestamp: "2024-01-01T00:00:01Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "# /learn\n\nPurpose: Deeply analyze a codebase." }],
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("<command-name>/learn</command-name>");
    expect(messages[1].content).toContain("Purpose: Deeply analyze a codebase.");
  });

  test("still skips an isMeta message that does not follow a command invocation", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "user",
        uuid: "stray-meta",
        isMeta: true,
        timestamp: "2024-01-01T00:00:01Z",
        message: { role: "user", content: [{ type: "text", text: "internal meta noise" }] },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("hi");
  });
});

describe("per-message model extraction", () => {
  test("carries the model from an assistant entry", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "m1",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Generated reply." }],
          model: "claude-opus-4-8",
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].model).toBe("claude-opus-4-8");
  });

  test("drops the <synthetic> marker used by system-generated banners", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "m2",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "API Error: Request timed out." }],
          model: "<synthetic>",
        },
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(1);
    expect(messages[0].model).toBeUndefined();
  });

  test("leaves model unset on user entries and old string-format messages", () => {
    const entries: ClaudeSessionEntry[] = [
      {
        type: "user",
        uuid: "m3",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "human",
        uuid: "m4",
        timestamp: "2024-01-01T00:00:01Z",
        message: "old format text",
      },
    ];

    const messages = extractMessages(entries);

    expect(messages).toHaveLength(2);
    expect(messages[0].model).toBeUndefined();
    expect(messages[1].model).toBeUndefined();
  });
});
