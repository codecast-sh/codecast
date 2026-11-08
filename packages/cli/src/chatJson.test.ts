import { describe, expect, test } from "bun:test";
import { chatLinesJson, chatReadJson } from "./chatJson";

describe("cast chat read --json", () => {
  const keys = ["id", "text", "author_name", "is_agent", "created_at"];

  test("the paged read and the --since read give rows with the same keys under one envelope", () => {
    const paged = chatReadJson({
      messages: [{ _id: "m1", user_id: "u1", content: "hello", created_at: 5, thread_root_id: "m0" }],
      authors: [{ _id: "u1", name: "Cam" }],
      has_more: true,
      next_cursor: "c2",
    });
    const since = chatLinesJson({ lines: [{ message_id: "m1", author_name: "Cam", is_agent: false, is_root: false, thread_root_id: "m0", text: "hello", created_at: 5 }], truncated: false });
    for (const row of [paged.messages[0]!, since.messages[0]!]) {
      for (const k of keys) expect(row).toHaveProperty(k);
      expect(row).toMatchObject({ id: "m1", text: "hello", author_name: "Cam", is_agent: false, thread_root_id: "m0" });
    }
    expect(paged).toMatchObject({ has_more: true, next_cursor: "c2" });
    // The raw fields stay for scripts written against the paged read.
    expect(paged.messages[0]).toMatchObject({ content: "hello", user_id: "u1" });
  });

  test("an agent or session line names who wrote it, and a deleted one has no text", () => {
    const out = chatReadJson({
      messages: [
        { _id: "a", user_id: "u9", author_kind: "agent", content: "on it", created_at: 1 },
        { _id: "b", user_id: "u1", origin_session_title: "Fix login", content: "done", created_at: 2 },
        { _id: "c", user_id: "u1", content: "oops", deleted_at: 3, created_at: 3 },
      ],
      authors: [{ _id: "u1", name: "Cam" }],
    });
    expect(out.messages.map((m) => [m.author_name, m.is_agent, m.text])).toEqual([["anchor", true, "on it"], ["Fix login", true, "done"], ["Cam", false, ""]]);
  });
});
