import { describe, test, expect, mock } from "bun:test";
import { parseSessionLine, parseLine, parseCodexLine, extractMessages, parseSessionFile, type ClaudeSessionEntry } from "./parser.js";

describe("Parser malformed JSON handling", () => {
  test("parseSessionLine logs warning and returns null for malformed JSON", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseSessionLine('this is not valid json');

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(consoleWarnSpy.mock.calls[0][0]).toContain('[parser] Failed to parse session line');
    expect(consoleWarnSpy.mock.calls[1][0]).toContain('[parser] Line content:');

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
    const contentWarning = consoleWarnSpy.mock.calls[1][0];
    expect(contentWarning.length).toBeLessThan(longLine.length + 50);
    expect(contentWarning).toContain('...');

    console.warn = originalWarn;
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
});
