import { describe, expect, test } from "bun:test";
import {
  commentIdOf,
  commentsFromRows,
  isConversationComment,
  rowFromComment,
  rowPatchFromComment,
  withoutBorrowedRows,
} from "./conversationCommentRows";

const comment = {
  conversation_id: "conv_1",
  message_id: "msg_1",
  user_id: "user_1",
  content: "Why?",
  created_at: 10,
  pr_id: "pr_1",
  github_comment_id: 42,
  file_path: "src/a.ts",
  line_number: 3,
  author_kind: "user",
  client_id: "cl-1",
} as any;

describe("conversation comment rows", () => {
  test("a comment maps to its row and back, field for field", () => {
    const row = { _id: "rc_1", _creationTime: 1, ...rowFromComment(comment, undefined) } as any;
    expect(row).toMatchObject({
      origin: "comment", author_user_id: "user_1", source_pr_id: "pr_1", source_github_comment_id: 42, resolved: false,
    });
    expect(row.pull_request_id).toBeUndefined();
    expect(row.github_comment_id).toBeUndefined();
    expect(commentsFromRows([row])).toEqual([{ _id: "rc_1", _creationTime: 1, ...comment }]);
  });

  test("a comment written before the move goes by its source id, and replies name parents by the id they go by", () => {
    const legacy = { _id: "rc_old", _creationTime: 1, source_comment_id: "c_old", ...rowFromComment(comment, undefined), origin: undefined } as any;
    const reply = { _id: "rc_new", _creationTime: 2, ...rowFromComment({ ...comment, content: "Because." }, "rc_old" as any) } as any;
    expect(commentIdOf(legacy)).toBe("c_old");
    expect(commentIdOf(reply)).toBe("rc_new");
    const [first, second] = commentsFromRows([legacy, reply]);
    expect(first._id).toBe("c_old");
    expect(second).toMatchObject({ _id: "rc_new", parent_comment_id: "c_old" });
  });

  test("resolved follows resolved_at, and the parent cannot be patched", () => {
    expect(rowPatchFromComment({ resolved_at: 5, resolved_by: "u" as any })).toEqual({ resolved_at: 5, resolved_by: "u", resolved: true });
    expect(rowPatchFromComment({ resolved_at: undefined, resolved_by: undefined })).toEqual({ resolved_at: undefined, resolved_by: undefined, resolved: false });
    expect(rowPatchFromComment({ content: "x" })).toEqual({ content: "x" });
    expect(() => rowPatchFromComment({ parent_comment_id: "c" } as any)).toThrow();
  });

  test("only quote rows and conversation comments are borrowed", () => {
    const rows = [
      { _id: "code" },
      { _id: "quote", origin: "quote" },
      { _id: "new", origin: "comment" },
      { _id: "old", source_comment_id: "c_old" },
      { _id: "decision", decision_id: "sd_1" },
    ] as any[];
    expect(rows.filter(isConversationComment).map((r) => r._id)).toEqual(["new", "old"]);
    expect(withoutBorrowedRows(rows).map((r) => r._id)).toEqual(["code", "decision"]);
    expect(commentsFromRows(rows).map((c) => c._id)).toEqual(["new", "c_old"]);
  });
});
