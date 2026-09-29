import { describe, expect, test } from "bun:test";
import {
  ASK_SYSTEM_PROMPT,
  citedLines,
  clipAround,
  dedupeTerms,
  parseTermsReply,
  questionTerms,
  selectAskContext,
  toAskLine,
  type AskLine,
  type AskMessage,
} from "./sessionAsk";

const msg = (over: Partial<AskMessage>): AskMessage => ({ _id: "m", role: "assistant", timestamp: 0, ...over });

const line = (n: number, over: Partial<AskLine> = {}): AskLine => ({
  line: n,
  kind: "agent",
  text: `line ${n}`,
  tools: [],
  results: [],
  files: [],
  hits: [],
  ...over,
});

describe("questionTerms", () => {
  test("keeps identifiers, paths and quoted phrases, drops stop words and numbers", () => {
    expect(questionTerms('Is idea 4 (contribute sharing) a gap?')).toEqual(["idea", "contribute", "sharing", "gap"]);
    expect(questionTerms('why did `collab_grants` change in convex/schema.ts?')).toEqual(["collab_grants", "change", "convex/schema.ts"]);
    expect(questionTerms('what does "send access" mean')).toEqual(["send access", "mean"]);
  });

  test("dedupeTerms lowercases, drops short and repeated terms, caps the list", () => {
    expect(dedupeTerms(["Foo", "foo", "ab", "bar"])).toEqual(["foo", "bar"]);
    expect(dedupeTerms(Array.from({ length: 30 }, (_, i) => `term${i}`))).toHaveLength(14);
  });

  test("parseTermsReply reads a JSON array anywhere in the reply, else nothing", () => {
    expect(parseTermsReply('Sure: ["a", "collab_grants", 3]')).toEqual(["a", "collab_grants"]);
    expect(parseTermsReply("no array here")).toEqual([]);
    expect(parseTermsReply("[not json")).toEqual([]);
    expect(parseTermsReply(null)).toEqual([]);
  });
});

describe("clipAround", () => {
  test("short text is untouched", () => {
    expect(clipAround("hello", ["x"], 10)).toBe("hello");
  });

  test("a match past the head survives the clip", () => {
    const text = `${"a".repeat(5000)} the NEEDLE is here ${"b".repeat(5000)}`;
    const clipped = clipAround(text, ["needle"], 400);
    expect(clipped).toContain("NEEDLE");
    expect(clipped.length).toBeLessThan(500);
  });

  test("no match keeps a head", () => {
    expect(clipAround("x".repeat(100), ["zzz"], 10)).toBe(`${"x".repeat(10)} […]`);
  });
});

describe("toAskLine", () => {
  test("classifies human turns, compactions, tool results and agent prose", () => {
    expect(toAskLine(msg({ role: "user", content: "please fix it" }), 1, []).kind).toBe("human");
    expect(toAskLine(msg({ role: "user", content: "This session is being continued from a previous conversation. Summary: ..." }), 2, []).kind).toBe("compaction");
    expect(toAskLine(msg({ role: "user", content: "", tool_results: [{ tool_use_id: "t", content: "ok" }] }), 3, []).kind).toBe("result");
    expect(toAskLine(msg({ content: "done" }), 4, []).kind).toBe("agent");
  });

  test("matches terms in prose, tool inputs and tool results", () => {
    const terms = ["collab_grants", "expires_at", "nowhere"];
    const l = toAskLine(msg({
      content: "Checking collab_grants.",
      tool_calls: [{ id: "t", name: "Grep", input: JSON.stringify({ pattern: "expires_at" }) }],
    }), 7, terms);
    expect(l.hits).toEqual([0, 1]);
    expect(l.line).toBe(7);
    expect(l.tools[0]).toContain("expires_at");
  });

  test("records edited files; keeps results only when they match or failed", () => {
    const edit = toAskLine(msg({
      tool_calls: [{ id: "t", name: "Edit", input: JSON.stringify({ file_path: "/r/src/a.ts", old_string: "x", new_string: "y" }) }],
    }), 1, []);
    expect(edit.files).toEqual(["/r/src/a.ts"]);

    const plain = toAskLine(msg({ role: "user", content: "", tool_results: [{ content: "irrelevant output" }] }), 2, ["needle"]);
    expect(plain.results).toEqual([]);
    const failed = toAskLine(msg({ role: "user", content: "", tool_results: [{ content: "boom", is_error: true }] }), 3, ["needle"]);
    expect(failed.error).toBe(true);
    expect(failed.results).toEqual(["boom"]);
    const hit = toAskLine(msg({ role: "user", content: "", tool_results: [{ content: "found the needle" }] }), 4, ["needle"]);
    expect(hit.results).toEqual(["found the needle"]);
  });
});

describe("selectAskContext", () => {
  test("a short session is shown whole, in order, with no gaps", () => {
    const lines = [1, 2, 3].map((n) => line(n));
    const ctx = selectAskContext(lines, { budget: 10_000, termCount: 0 });
    expect(ctx.shownLines).toEqual([1, 2, 3]);
    expect(ctx.text).not.toContain("not shown");
    expect(ctx.text.indexOf("[L1 ")).toBeLessThan(ctx.text.indexOf("[L3 "));
  });

  test("on a long session, a later line on the same topic beats unrelated lines", () => {
    // Line 100 answers the question, line 700 reverses it, the rest is noise.
    const lines = Array.from({ length: 1000 }, (_, i) => line(i + 1, { text: `noise ${"z".repeat(300)}` }));
    lines[99] = line(100, { text: "Idea 4 is a gap: nobody can contribute to a shared session.", hits: [0, 1] });
    lines[699] = line(700, { text: "Correction: collab_grants already covers contribute access, so idea 4 is mostly not a gap.", hits: [0, 2] });
    const ctx = selectAskContext(lines, { budget: 6_000, termCount: 3 });
    expect(ctx.shownLines).toContain(100);
    expect(ctx.shownLines).toContain(700);
    expect(ctx.anchorLines).toEqual([100, 700]);
    expect(ctx.text).toContain("not shown");
  });

  test("a later line that only touches the anchor's file is still gathered", () => {
    const lines = Array.from({ length: 400 }, (_, i) => line(i + 1, { text: "x".repeat(200) }));
    lines[9] = line(10, { text: "change the limit", hits: [0], files: ["/r/limits.ts"] });
    const extraFiles = new Map([[300, ["/r/limits.ts"]]]);
    const ctx = selectAskContext(lines, { budget: 4_000, termCount: 1, extraFiles });
    expect(ctx.shownLines).toContain(10);
    expect(ctx.shownLines).toContain(300);
  });

  test("the human's turns after the first match and the tail are kept", () => {
    const lines = Array.from({ length: 500 }, (_, i) => line(i + 1, { text: "y".repeat(200) }));
    lines[19] = line(20, { hits: [0] });
    lines[249] = line(250, { kind: "human", text: "no, revert that" });
    const ctx = selectAskContext(lines, { budget: 5_000, termCount: 1 });
    expect(ctx.shownLines).toContain(250);
    expect(ctx.shownLines).toContain(500);
  });

  test("never exceeds the budget, however much matches", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => line(i + 1, { text: "w".repeat(2000), hits: [0], results: ["r".repeat(700)] }));
    const ctx = selectAskContext(lines, { budget: 50_000, termCount: 1 });
    expect(ctx.text.length).toBeLessThanOrEqual(50_000 + 2000);
    expect(ctx.matchedLines).toBe(2000);
  });

  test("with no match, the tail and the human's turns still reach the model", () => {
    const lines = Array.from({ length: 300 }, (_, i) => line(i + 1, { kind: i % 50 === 0 ? "human" : "agent", text: "q".repeat(400) }));
    const ctx = selectAskContext(lines, { budget: 8_000, termCount: 2 });
    expect(ctx.anchorLines).toEqual([]);
    expect(ctx.shownLines).toContain(300);
    expect(ctx.shownLines).toContain(251);
  });
});

describe("citedLines", () => {
  test("reads single lines and ranges, in order, once each", () => {
    expect(citedLines("See L12 and L40–L42, also L12 and L7-8.")).toEqual([12, 40, 41, 42, 7, 8]);
    expect(citedLines("nothing")).toEqual([]);
  });
});

test("the prompt asks for reversal checks, outcome over attempt, and an honest not found", () => {
  expect(ASK_SYSTEM_PROMPT).toContain("later line");
  expect(ASK_SYSTEM_PROMPT).toContain("not what happened");
  expect(ASK_SYSTEM_PROMPT).toContain("not found in this session");
});
