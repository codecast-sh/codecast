import { test, expect, describe } from "bun:test";
import {
  toBlockquote,
  formatQuotedReply,
  formatPendingComments,
  appendToDraft,
  sortPendingComments,
  type PendingComment,
} from "./quoteFormat";

describe("toBlockquote", () => {
  test("single line", () => {
    expect(toBlockquote("hello")).toBe("> hello");
  });
  test("multi-line prefixes every line", () => {
    expect(toBlockquote("a\nb")).toBe("> a\n> b");
  });
  test("blank interior line becomes a bare >", () => {
    expect(toBlockquote("a\n\nb")).toBe("> a\n>\n> b");
  });
  test("trims surrounding blank lines", () => {
    expect(toBlockquote("\n\nhi\n\n")).toBe("> hi");
  });
  test("empty => empty", () => {
    expect(toBlockquote("")).toBe("");
    expect(toBlockquote("   ")).toBe("");
  });
});

describe("formatQuotedReply", () => {
  test("quote + body", () => {
    expect(formatQuotedReply("quoted", "my reply")).toBe("> quoted\n\nmy reply");
  });
  test("quote only", () => {
    expect(formatQuotedReply("quoted", "")).toBe("> quoted");
    expect(formatQuotedReply("quoted")).toBe("> quoted");
  });
  test("body only (no quote)", () => {
    expect(formatQuotedReply("", "just a comment")).toBe("just a comment");
  });
});

describe("formatPendingComments", () => {
  test("joins multiple with blank line", () => {
    const out = formatPendingComments([
      { quote: "q1", body: "b1" },
      { quote: "q2", body: "b2" },
    ]);
    expect(out).toBe("> q1\n\nb1\n\n> q2\n\nb2");
  });
  test("skips fully-empty entries", () => {
    const out = formatPendingComments([
      { quote: "q1", body: "" },
      { quote: "", body: "" },
    ]);
    expect(out).toBe("> q1");
  });
});

describe("appendToDraft", () => {
  test("appends with a blank-line gap", () => {
    expect(appendToDraft("existing", "added")).toBe("existing\n\nadded");
  });
  test("empty draft returns addition", () => {
    expect(appendToDraft("", "added")).toBe("added");
  });
  test("empty addition returns existing", () => {
    expect(appendToDraft("existing", "")).toBe("existing");
  });
  test("trailing whitespace in draft is collapsed before the gap", () => {
    expect(appendToDraft("existing\n\n", "added")).toBe("existing\n\nadded");
  });
});

describe("sortPendingComments", () => {
  const mk = (id: string, messageId: string, blockIndex: number, createdAt: number): PendingComment => ({
    id,
    messageId,
    blockIndex,
    quote: id,
    body: id,
    createdAt,
  });

  test("orders by first-commented message, then block index", () => {
    // messageB was commented first (t=1), then messageA (t=2).
    const input = [
      mk("a-block2", "A", 2, 3),
      mk("b-block1", "B", 1, 1),
      mk("a-block1", "A", 1, 2),
      mk("b-block0", "B", 0, 4),
    ];
    const sorted = sortPendingComments(input).map((c) => c.id);
    expect(sorted).toEqual(["b-block0", "b-block1", "a-block1", "a-block2"]);
  });
});
