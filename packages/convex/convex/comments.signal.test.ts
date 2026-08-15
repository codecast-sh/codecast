import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { refreshCommentSignal } from "./comments";

const OWNER = "user-owner" as any;
const TEAMMATE = "user-teammate" as any;
const CONV = "conv-1" as any;

function comment(_id: string, author: any, extra: Record<string, unknown> = {}) {
  return {
    _id,
    conversation_id: CONV,
    user_id: author,
    content: `note ${_id}`,
    created_at: 0,
    ...extra,
  };
}

function ctx(comments: any[]) {
  const db = makeFakeDb({
    users: [
      { _id: OWNER, name: "Owner" },
      { _id: TEAMMATE, name: "Mattie Doe" },
    ],
    conversations: [{ _id: CONV, user_id: OWNER, title: "Session" }],
    comments,
  });
  return { db } as any;
}

describe("refreshCommentSignal", () => {
  test("stamps count, last author and excerpt from the newest OPEN comment", async () => {
    const c = ctx([
      // Resolved thread: contributes nothing.
      comment("c1", OWNER, { file_path: "a.ts", line_number: 1, created_at: 10, resolved_at: 11 }),
      // Open message thread, teammate spoke last.
      comment("c2", OWNER, { message_id: "m1", created_at: 20 }),
      comment("c3", TEAMMATE, { message_id: "m1", created_at: 30, content: "  needs   a guard\nhere  " }),
      // Second open thread (global).
      comment("c4", TEAMMATE, { created_at: 25 }),
    ]);
    await refreshCommentSignal(c, CONV);
    const patch = c.db._patched.find((p: any) => p._id === CONV)!.patch;
    expect(patch.unresolved_comment_count).toBe(2);
    expect(patch.last_comment_at).toBe(30);
    expect(patch.last_comment_author).toBe("Mattie Doe");
    expect(patch.last_comment_author_id).toBe(String(TEAMMATE));
    expect(patch.last_comment_excerpt).toBe("needs a guard here");
  });

  test("agent replies stamp the agent identity", async () => {
    const c = ctx([
      comment("c1", OWNER, { message_id: "m1", created_at: 10 }),
      comment("c2", OWNER, { message_id: "m1", created_at: 20, author_kind: "agent", content: "done — fixed in x.ts" }),
    ]);
    await refreshCommentSignal(c, CONV);
    const patch = c.db._patched.find((p: any) => p._id === CONV)!.patch;
    expect(patch.unresolved_comment_count).toBe(1);
    expect(patch.last_comment_author).toBe("Agent");
    expect(patch.last_comment_author_id).toBe("agent");
  });

  test("all threads resolved clears the whole signal", async () => {
    const c = ctx([
      comment("c1", TEAMMATE, { message_id: "m1", created_at: 10, resolved_at: 40 }),
      comment("c2", OWNER, { created_at: 20, resolved_at: 41 }),
    ]);
    await refreshCommentSignal(c, CONV);
    const patch = c.db._patched.find((p: any) => p._id === CONV)!.patch;
    expect(patch.unresolved_comment_count).toBeUndefined();
    expect(patch.last_comment_author).toBeUndefined();
    expect(patch.last_comment_excerpt).toBeUndefined();
  });

  test("a reply posted after resolution reopens the thread", async () => {
    const c = ctx([
      comment("c1", OWNER, { message_id: "m1", created_at: 10, resolved_at: 40 }),
      comment("c2", TEAMMATE, { message_id: "m1", created_at: 50, content: "actually, one more thing" }),
    ]);
    await refreshCommentSignal(c, CONV);
    const patch = c.db._patched.find((p: any) => p._id === CONV)!.patch;
    expect(patch.unresolved_comment_count).toBe(1);
    expect(patch.last_comment_excerpt).toBe("actually, one more thing");
  });
});
