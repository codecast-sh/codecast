import { describe, expect, test } from "bun:test";
import { fileThreadKey, groupComments, type Comment } from "./commentThread";

function comment(overrides: Partial<Comment>): Comment {
  return {
    _id: Math.random().toString(36).slice(2),
    conversation_id: "conv-1",
    user_id: "user-1",
    content: "note",
    created_at: 1,
    ...overrides,
  };
}

describe("groupComments", () => {
  test("splits global, message-anchored, and code-anchored threads", () => {
    const grouped = groupComments([
      comment({ _id: "g1", content: "global", created_at: 3 }),
      comment({ _id: "m1", message_id: "msg-1", created_at: 1 }),
      comment({ _id: "f1", file_path: "codecast/foo.ts", line_number: 42, created_at: 2 }),
      comment({ _id: "f2", file_path: "codecast/foo.ts", line_number: 42, created_at: 5 }),
      comment({ _id: "f3", file_path: "codecast/foo.ts", line_number: 7, created_at: 4 }),
    ]);

    expect(grouped.global.comments.map((c) => c._id)).toEqual(["g1"]);
    expect(grouped.anchored).toHaveLength(1);
    expect(grouped.anchored[0].messageId).toBe("msg-1");

    expect(grouped.files).toHaveLength(2);
    const line42 = grouped.files.find((t) => t.lineNumber === 42)!;
    expect(line42.key).toBe(fileThreadKey("codecast/foo.ts", 42));
    expect(line42.filePath).toBe("codecast/foo.ts");
    // chronological within the thread
    expect(line42.comments.map((c) => c._id)).toEqual(["f1", "f2"]);
    expect(line42.lastActivity).toBe(5);
  });

  test("a message anchor wins over a stray file anchor on the same row", () => {
    // GitHub PR sync can stamp file_path onto message-anchored rows; the message
    // thread stays the identity so the rail keeps one thread, not two.
    const grouped = groupComments([
      comment({ _id: "m1", message_id: "msg-1", file_path: "codecast/foo.ts", line_number: 3 }),
    ]);
    expect(grouped.anchored).toHaveLength(1);
    expect(grouped.files).toHaveLength(0);
  });

  test("a thread is resolved only when every comment carries the stamp", () => {
    const resolved = groupComments([
      comment({ _id: "f1", file_path: "codecast/foo.ts", line_number: 1, resolved_at: 10 }),
      comment({ _id: "f2", file_path: "codecast/foo.ts", line_number: 1, resolved_at: 10 }),
    ]);
    expect(resolved.files[0].resolved).toBe(true);

    const reopened = groupComments([
      comment({ _id: "f1", file_path: "codecast/foo.ts", line_number: 1, resolved_at: 10 }),
      comment({ _id: "f3", file_path: "codecast/foo.ts", line_number: 1 }),
    ]);
    expect(reopened.files[0].resolved).toBe(false);
  });

  test("a code comment with no line number still forms a thread", () => {
    const grouped = groupComments([
      comment({ _id: "f1", file_path: "codecast/foo.ts" }),
    ]);
    expect(grouped.files).toHaveLength(1);
    expect(grouped.files[0].lineNumber).toBeUndefined();
    expect(grouped.files[0].key).toBe(fileThreadKey("codecast/foo.ts", undefined));
  });
});
