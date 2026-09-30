import { describe, expect, test } from "bun:test";
import { isDismissible, replyPreview, type ThreadCardModel } from "./threadCards";

// The collapsed row's second line, and which rows "Done" can archive.

describe("replyPreview", () => {
  test("a person's reply is named; an agent's is named by its session, never by the token owner", () => {
    expect(replyPreview({ _id: "c1", author_kind: "user", author_name: "Bob", created_at: 1, preview: "which key?" }))
      .toEqual({ who: "Bob", whoKind: "user", text: "which key?" });
    // The server signs an agent's comment with its owner's name: the row must not.
    expect(replyPreview({ _id: "c2", author_kind: "agent", author_name: "Ashot", session_title: "Fix auth race", created_at: 1, preview: "PR up" }))
      .toEqual({ who: "Fix auth race", whoKind: "agent", text: "PR up" });
    expect(replyPreview({ _id: "c3", author_kind: "agent", author_name: "Ashot", created_at: 1, preview: "PR up" })?.who).toBe("Agent");
  });

  test("a nameless person resolves through the roster; nothing to preview is null", () => {
    const nameOf = (id: string) => (id === "u1" ? "Carol" : undefined);
    expect(replyPreview({ _id: "c4", author_kind: "user", user_id: "u1", created_at: 1, preview: "hi" }, nameOf)?.who).toBe("Carol");
    expect(replyPreview(null)).toBeNull();
    expect(replyPreview(undefined)).toBeNull();
  });
});

describe("isDismissible", () => {
  const card = (kind: ThreadCardModel["kind"]): ThreadCardModel =>
    ({ id: kind, kind, chip: "task", activityAt: 0, unread: 1, href: "/", source: {} as any });
  test("thread_reads-backed kinds archive; projections of other state do not", () => {
    for (const k of ["chat", "comment", "code", "task", "page"] as const) expect(isDismissible(card(k))).toBe(true);
    for (const k of ["dm", "session", "question"] as const) expect(isDismissible(card(k))).toBe(false);
  });
});
