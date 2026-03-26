import { test, expect } from 'bun:test';
import { parseSessionFile } from '../../packages/cli/src/parser';
import * as path from 'path';

const FILE_TOOL_OPS: Record<string, string> = {
  Read: "read",
  Edit: "edit",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
};

function extractFileTouches(messages: Array<{ toolCalls?: Array<{ name: string; input: Record<string, unknown> }>; timestamp: number }>, startIndex: number) {
  const touches: Array<{ file_path: string; operation: string; message_index: number; timestamp: number; line_range?: string }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      const op = FILE_TOOL_OPS[tc.name];
      if (!op) continue;
      const filePath = (tc.input?.file_path ?? tc.input?.path) as string | undefined;
      if (!filePath || typeof filePath !== "string") continue;
      if (!path.isAbsolute(filePath)) continue;
      const key = `${startIndex + i}:${op}:${filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      touches.push({
        file_path: filePath,
        operation: op,
        message_index: startIndex + i,
        timestamp: msg.timestamp,
      });
    }
  }
  return touches;
}

test('extracts Read tool calls with file_path', () => {
  const content = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/Users/test/src/app.ts" } }
    ] },
    timestamp: new Date().toISOString(),
  });

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 0);

  expect(touches).toHaveLength(1);
  expect(touches[0].file_path).toBe("/Users/test/src/app.ts");
  expect(touches[0].operation).toBe("read");
  expect(touches[0].message_index).toBe(0);
});

test('extracts Edit tool calls', () => {
  const content = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/Users/test/src/app.ts", old_string: "foo", new_string: "bar" } }
    ] },
    timestamp: new Date().toISOString(),
  });

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 0);

  expect(touches).toHaveLength(1);
  expect(touches[0].operation).toBe("edit");
});

test('extracts Write tool calls', () => {
  const content = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/Users/test/new-file.ts", content: "hello" } }
    ] },
    timestamp: new Date().toISOString(),
  });

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 0);

  expect(touches).toHaveLength(1);
  expect(touches[0].operation).toBe("write");
});

test('extracts Grep tool calls using path parameter', () => {
  const content = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "TODO", path: "/Users/test/src" } }
    ] },
    timestamp: new Date().toISOString(),
  });

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 0);

  expect(touches).toHaveLength(1);
  expect(touches[0].operation).toBe("grep");
  expect(touches[0].file_path).toBe("/Users/test/src");
});

test('skips relative paths', () => {
  const content = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/app.ts" } }
    ] },
    timestamp: new Date().toISOString(),
  });

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 0);

  expect(touches).toHaveLength(0);
});

test('skips non-file tools like Bash', () => {
  const content = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }
    ] },
    timestamp: new Date().toISOString(),
  });

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 0);

  expect(touches).toHaveLength(0);
});

test('deduplicates same file+op+index', () => {
  const content = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/Users/test/app.ts" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/Users/test/app.ts" } },
    ] },
    timestamp: new Date().toISOString(),
  });

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 0);

  expect(touches).toHaveLength(1);
});

test('extracts multiple tools from multiple messages', () => {
  const content = [
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/Users/test/a.ts" } },
      ] },
      timestamp: new Date("2025-01-01T00:00:00Z").toISOString(),
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "ok" },
      timestamp: new Date("2025-01-01T00:01:00Z").toISOString(),
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [
        { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/Users/test/b.ts", old_string: "x", new_string: "y" } },
        { type: "tool_use", id: "t3", name: "Write", input: { file_path: "/Users/test/c.ts", content: "new" } },
      ] },
      timestamp: new Date("2025-01-01T00:02:00Z").toISOString(),
    }),
  ].join('\n');

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 0);

  expect(touches).toHaveLength(3);
  expect(touches[0]).toMatchObject({ file_path: "/Users/test/a.ts", operation: "read", message_index: 0 });
  expect(touches[1]).toMatchObject({ file_path: "/Users/test/b.ts", operation: "edit", message_index: 2 });
  expect(touches[2]).toMatchObject({ file_path: "/Users/test/c.ts", operation: "write", message_index: 2 });
});

test('uses startIndex offset for message_index', () => {
  const content = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/Users/test/app.ts" } },
    ] },
    timestamp: new Date().toISOString(),
  });

  const messages = parseSessionFile(content);
  const touches = extractFileTouches(messages, 42);

  expect(touches[0].message_index).toBe(42);
});
