import { describe, expect, test } from "bun:test";
import { firstUnreadIndex, withImages, type Comment } from "../../lib/commentThread";

// What the shared comment components add for every comment surface: pasted
// images post as markdown images, and a thread knows where the reader's news starts.

describe("withImages", () => {
  test("appends each uploaded image as a markdown image; nothing when there are none", async () => {
    const urls = async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `https://files.test/${id}`]));
    expect(await withImages("Look:", [{ storageId: "s1" }, { storageId: "s2" }], urls)).toBe("Look:\n\n![image](https://files.test/s1)\n\n![image](https://files.test/s2)");
    expect(await withImages("", [{ storageId: "s1" }], urls)).toBe("![image](https://files.test/s1)");
    expect(await withImages("plain", undefined, urls)).toBe("plain");
    // An upload still in flight has no storage id, and an unresolved id is dropped.
    expect(await withImages("x", [{}, { storageId: "gone" }], async () => ({ gone: null }))).toBe("x");
  });
});

describe("firstUnreadIndex", () => {
  const c = (id: string, at: number, user: string, extra: Partial<Comment> = {}): Comment => ({ _id: id, conversation_id: "c", user_id: user, content: id, created_at: at, ...extra });
  test("the first comment past the mark that someone else wrote", () => {
    const rows = [c("a", 1, "me"), c("b", 5, "me"), c("c", 6, "them"), c("d", 7, "them")];
    expect(firstUnreadIndex(rows, 2, "me")).toBe(2);
    expect(firstUnreadIndex(rows, 10, "me")).toBe(-1);
    expect(firstUnreadIndex(rows, undefined, "me")).toBe(-1);
  });
  test("an agent's answer is news, its empty placeholder is not", () => {
    const rows = [c("t", 5, "me", { author_kind: "agent", agent_status: "thinking", content: "" }), c("a", 6, "me", { author_kind: "agent", agent_status: "done" })];
    expect(firstUnreadIndex(rows, 1, "me")).toBe(1);
  });
});
