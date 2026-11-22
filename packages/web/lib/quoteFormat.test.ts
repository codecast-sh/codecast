import { test, expect, describe } from "bun:test";
import {
  splitQuoteRuns,
  toBlockquote,
  formatQuotedReply,
  formatPendingComments,
  appendToDraft,
  sortPendingComments,
  parseSentQuotes,
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

describe("splitQuoteRuns", () => {
  test("round-trips toBlockquote and keeps the replies between quotes", () => {
    const body = `${formatQuotedReply("1. first point\n\nmore of it", "yes")}\n\n${formatQuotedReply("2. second", "no")}`;
    expect(splitQuoteRuns(body)).toEqual([
      { quote: true, text: "1. first point\n\nmore of it" },
      { quote: false, text: "yes" },
      { quote: true, text: "2. second" },
      { quote: false, text: "no" },
    ]);
  });
  test("text without quotes is one plain run", () => {
    expect(splitQuoteRuns("a > b\nc")).toEqual([{ quote: false, text: "a > b\nc" }]);
  });
});

describe("parseSentQuotes", () => {
  const quotes = [
    { quote: "first line\n\nstill first", body: "" },
    { quote: "second", body: "a note\n\nin two paragraphs" },
    { quote: "third", body: "" },
  ];
  test("reads a batch send back into its quotes, notes and reply", () => {
    const sent = `${formatPendingComments(quotes)}\n\nthe reply`;
    expect(parseSentQuotes(sent)).toEqual({ quotes, reply: "the reply" });
  });
  test("formatting what it read gives the same text", () => {
    const sent = `${formatPendingComments(quotes)}\n\nthe reply`;
    const parsed = parseSentQuotes(sent)!;
    expect(`${formatPendingComments(parsed.quotes)}\n\n${parsed.reply}`).toBe(sent);
  });
  test("a quote-only send has no reply", () => {
    expect(parseSentQuotes(formatPendingComments(quotes.slice(0, 1)))).toEqual({ quotes: quotes.slice(0, 1), reply: "" });
  });
  test("a message that does not open with a quote is not a batch", () => {
    expect(parseSentQuotes("plain words\n\n> a quote later")).toBeNull();
  });
});
