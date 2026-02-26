import { describe, it, expect } from "vitest";
import { extractFileChanges } from "../fileChangeExtractor";
import type { Doc } from "@codecast/convex/convex/_generated/dataModel";

type Message = Doc<"messages">;

describe("extractFileChanges", () => {
  it("should extract Edit tool calls", () => {
    const messages: Message[] = [
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "edit1",
            name: "Edit",
            input: JSON.stringify({
              file_path: "/src/utils.ts",
              old_string: "const x = 1;",
              new_string: "const x = 2;",
            }),
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "edit1",
      sequenceIndex: 0,
      messageId: "msg1",
      filePath: "/src/utils.ts",
      changeType: "edit",
      oldContent: "const x = 1;",
      newContent: "const x = 2;",
      timestamp: 1000,
    });
  });

  it("should extract Write tool calls", () => {
    const messages: Message[] = [
      {
        _id: "msg2" as any,
        _creationTime: 2000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 2000,
        tool_calls: [
          {
            id: "write1",
            name: "Write",
            input: JSON.stringify({
              file_path: "/src/new.ts",
              content: "export const foo = 'bar';",
            }),
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "write1",
      sequenceIndex: 0,
      messageId: "msg2",
      filePath: "/src/new.ts",
      changeType: "write",
      newContent: "export const foo = 'bar';",
      timestamp: 2000,
    });
    expect(changes[0].oldContent).toBeUndefined();
  });

  it("should return changes in chronological order with sequence index", () => {
    const messages: Message[] = [
      {
        _id: "msg3" as any,
        _creationTime: 3000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 3000,
        tool_calls: [
          {
            id: "edit2",
            name: "Edit",
            input: JSON.stringify({
              file_path: "/src/b.ts",
              old_string: "b",
              new_string: "B",
            }),
          },
        ],
      },
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "edit1",
            name: "Edit",
            input: JSON.stringify({
              file_path: "/src/a.ts",
              old_string: "a",
              new_string: "A",
            }),
          },
        ],
      },
      {
        _id: "msg2" as any,
        _creationTime: 2000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 2000,
        tool_calls: [
          {
            id: "write1",
            name: "Write",
            input: JSON.stringify({
              file_path: "/src/c.ts",
              content: "C",
            }),
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(3);
    expect(changes[0].sequenceIndex).toBe(0);
    expect(changes[0].filePath).toBe("/src/a.ts");
    expect(changes[0].timestamp).toBe(1000);

    expect(changes[1].sequenceIndex).toBe(1);
    expect(changes[1].filePath).toBe("/src/c.ts");
    expect(changes[1].timestamp).toBe(2000);

    expect(changes[2].sequenceIndex).toBe(2);
    expect(changes[2].filePath).toBe("/src/b.ts");
    expect(changes[2].timestamp).toBe(3000);
  });

  it("should handle malformed JSON gracefully", () => {
    const messages: Message[] = [
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "bad1",
            name: "Edit",
            input: "not valid json {{{",
          },
          {
            id: "good1",
            name: "Edit",
            input: JSON.stringify({
              file_path: "/src/good.ts",
              old_string: "old",
              new_string: "new",
            }),
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe("good1");
  });

  it("should skip tool calls with missing required fields", () => {
    const messages: Message[] = [
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "missing1",
            name: "Edit",
            input: JSON.stringify({
              old_string: "old",
              new_string: "new",
            }),
          },
          {
            id: "missing2",
            name: "Write",
            input: JSON.stringify({
              file_path: "/src/file.ts",
            }),
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(0);
  });

  it("should skip non-Edit and non-Write tool calls", () => {
    const messages: Message[] = [
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "read1",
            name: "Read",
            input: JSON.stringify({
              file_path: "/src/file.ts",
            }),
          },
          {
            id: "bash1",
            name: "Bash",
            input: JSON.stringify({
              command: "ls",
            }),
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(0);
  });

  it("should handle messages with no tool calls", () => {
    const messages: Message[] = [
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "user",
        content: "Hello",
        timestamp: 1000,
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(0);
  });

  it("should handle empty messages array", () => {
    const changes = extractFileChanges([]);

    expect(changes).toHaveLength(0);
  });

  it("should handle multiple tool calls in a single message", () => {
    const messages: Message[] = [
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "edit1",
            name: "Edit",
            input: JSON.stringify({
              file_path: "/src/a.ts",
              old_string: "a",
              new_string: "A",
            }),
          },
          {
            id: "edit2",
            name: "Edit",
            input: JSON.stringify({
              file_path: "/src/b.ts",
              old_string: "b",
              new_string: "B",
            }),
          },
          {
            id: "write1",
            name: "Write",
            input: JSON.stringify({
              file_path: "/src/c.ts",
              content: "C",
            }),
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(3);
    expect(changes[0].sequenceIndex).toBe(0);
    expect(changes[1].sequenceIndex).toBe(1);
    expect(changes[2].sequenceIndex).toBe(2);
    expect(changes[0].messageId).toBe("msg1");
    expect(changes[1].messageId).toBe("msg1");
    expect(changes[2].messageId).toBe("msg1");
  });

  it("should extract apply_patch changes into file changes", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /src/a.ts",
      "@@",
      "-const a = 1;",
      "+const a = 2;",
      "*** Add File: /src/b.ts",
      "+export const b = true;",
      "*** End Patch",
    ].join("\n");

    const messages: Message[] = [
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "patch1",
            name: "apply_patch",
            input: JSON.stringify({ input: patch }),
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      id: "patch1:0",
      toolCallId: "patch1",
      filePath: "/src/a.ts",
      changeType: "edit",
      oldContent: "const a = 1;",
      newContent: "const a = 2;",
    });
    expect(changes[1]).toMatchObject({
      id: "patch1:1",
      toolCallId: "patch1",
      filePath: "/src/b.ts",
      changeType: "write",
      newContent: "export const b = true;",
    });
  });

  it("should extract raw apply_patch input (non-JSON tool input)", () => {
    const rawPatch = [
      "*** Begin Patch",
      "*** Update File: /src/c.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const messages: Message[] = [
      {
        _id: "msg1" as any,
        _creationTime: 1000,
        conversation_id: "conv1" as any,
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "patch2",
            name: "apply_patch",
            input: rawPatch,
          },
        ],
      },
    ];

    const changes = extractFileChanges(messages);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "patch2:0",
      toolCallId: "patch2",
      filePath: "/src/c.ts",
      changeType: "edit",
      oldContent: "old",
      newContent: "new",
    });
  });
});
