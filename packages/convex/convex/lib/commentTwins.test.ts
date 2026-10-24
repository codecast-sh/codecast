import { describe, expect, test } from "bun:test";
import {
  COMMENT_TWIN_FIELDS,
  commentRowFromTwin,
  commentTwinFields,
  commentTwinMismatches,
  isCommentTwin,
  withoutBorrowedRows,
} from "./commentTwins";

const anchor = { before: ["a", "b"], lines: ["const x = 1;"], after: ["c"] } as any;

function comment(over: Record<string, unknown> = {}) {
  return {
    _id: "c1",
    conversation_id: "conv",
    message_id: "msg",
    user_id: "u1",
    content: "why?",
    created_at: 10,
    ...over,
  } as any;
}

describe("commentTwinFields", () => {
  test("maps every comments field onto its review_comments field", () => {
    const full = comment({
      parent_comment_id: "c0",
      github_comment_id: 99,
      pr_id: "pr1",
      file_path: "src/a.ts",
      line_number: 4,
      anchor_lines: anchor,
      author_kind: "agent",
      agent_status: "done",
      fork_conversation_id: "fork",
      resolved_at: 20,
      resolved_by: "u2",
      client_id: "cl",
    });
    expect(commentTwinFields(full, "rc0" as any)).toEqual({
      source_comment_id: "c1",
      conversation_id: "conv",
      message_id: "msg",
      author_user_id: "u1",
      author_kind: "agent",
      content: "why?",
      parent_id: "rc0",
      created_at: 10,
      file_path: "src/a.ts",
      line_number: 4,
      anchor_lines: anchor,
      agent_status: "done",
      fork_conversation_id: "fork",
      resolved: true,
      resolved_at: 20,
      resolved_by: "u2",
      client_id: "cl",
      source_pr_id: "pr1",
      source_github_comment_id: 99,
    } as any);
  });

  test("names every twin field, and never a field a pull request or GitHub reader keys on", () => {
    const keys = Object.keys(commentTwinFields(comment()));
    expect(keys.sort()).toEqual([...COMMENT_TWIN_FIELDS].sort());
    for (const reserved of ["pull_request_id", "github_comment_id", "repository", "ref", "workspace", "pending_review", "sent_at", "origin", "git_root", "disposition"]) {
      expect(keys).not.toContain(reserved);
    }
  });

  test("an open comment is unresolved; a reply without a parent twin has no parent", () => {
    const fields = commentTwinFields(comment({ parent_comment_id: "gone" }));
    expect(fields.resolved).toBe(false);
    expect(fields.parent_id).toBeUndefined();
    // A parent twin is ignored when the comment is not a reply.
    expect(commentTwinFields(comment(), "rc0" as any).parent_id).toBeUndefined();
  });
});

describe("commentTwinMismatches", () => {
  test("a twin written from the mapping matches; each drifted field is named", () => {
    const expected = commentTwinFields(comment({ anchor_lines: anchor, resolved_at: 5 }));
    expect(commentTwinMismatches({ ...expected, anchor_lines: JSON.parse(JSON.stringify(anchor)) }, expected)).toEqual([]);
    expect(commentTwinMismatches({ ...expected, content: "edited", resolved: false }, expected).sort())
      .toEqual(["content", "resolved"]);
    // An absent field and an undefined one are the same; 0 and "0" are not.
    const { message_id: _drop, ...noMessage } = commentTwinFields(comment({ message_id: undefined }));
    expect(commentTwinMismatches(noMessage, commentTwinFields(comment({ message_id: undefined })))).toEqual([]);
    expect(commentTwinMismatches({ ...expected, created_at: "10" }, expected)).toEqual(["created_at"]);
  });
});

describe("commentRowFromTwin", () => {
  test("round trip: a twin reads back as the comment it came from", () => {
    const source = comment({
      parent_comment_id: "c0",
      github_comment_id: 99,
      pr_id: "pr1",
      file_path: "src/a.ts",
      line_number: 4,
      anchor_lines: anchor,
      author_kind: "agent",
      agent_status: "thinking",
      fork_conversation_id: "fork",
      resolved_at: 20,
      resolved_by: "u2",
      client_id: "cl",
    });
    const twin = { _id: "rc1", _creationTime: 1, ...commentTwinFields(source, "rc0" as any) } as any;
    const row = commentRowFromTwin(twin, (id) => (id === "rc0" ? ("c0" as any) : undefined));
    const { _creationTime, ...rest } = row as any;
    expect(rest).toEqual(source);
  });

  test("a plain comment reads back without fields it never had", () => {
    const source = comment();
    const twin = { _id: "rc1", _creationTime: 1, ...commentTwinFields(source) } as any;
    const { _creationTime, ...rest } = commentRowFromTwin(twin, () => undefined) as any;
    expect(rest).toEqual(source);
    expect(Object.keys(rest)).not.toContain("resolved");
  });
});

describe("which rows are twins", () => {
  test("a source id marks a twin; borrowed rows are twins and quotes", () => {
    expect(isCommentTwin({ source_comment_id: "c1" })).toBe(true);
    expect(isCommentTwin({})).toBe(false);
    const rows = [
      { _id: "code" },
      { _id: "quote", origin: "quote" },
      { _id: "twin", source_comment_id: "c1" },
    ] as any[];
    expect(withoutBorrowedRows(rows).map((r) => r._id)).toEqual(["code"]);
  });
});
