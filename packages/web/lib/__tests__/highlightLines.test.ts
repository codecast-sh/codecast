import { describe, expect, it } from "bun:test";
import { highlightLines, splitHighlightedLines } from "../codeLanguage";

describe("splitHighlightedLines", () => {
  it("gives one entry per source line, including trailing blanks", () => {
    expect(splitHighlightedLines("a\nb\n")).toEqual(["a", "b", ""]);
    expect(splitHighlightedLines("")).toEqual([""]);
  });

  it("re-closes and re-opens a span that crosses a newline", () => {
    const lines = splitHighlightedLines('<span class="token comment">/* one\ntwo */</span>');
    expect(lines).toEqual([
      '<span class="token comment">/* one</span>',
      '<span class="token comment">two */</span>',
    ]);
  });

  it("keeps nested spans balanced on every line", () => {
    const lines = splitHighlightedLines('<span class="a"><span class="b">x\ny</span>z</span>');
    expect(lines).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b">y</span>z</span>',
    ]);
  });

  it("leaves a line with no markup alone", () => {
    expect(splitHighlightedLines("plain &amp; escaped")).toEqual(["plain &amp; escaped"]);
  });
});

describe("highlightLines", () => {
  it("matches the file's line count for a real grammar", () => {
    const code = ["const a = 1;", "/* a comment", "   that spans lines */", "const b = 2;"].join("\n");
    const lines = highlightLines(code, "typescript");
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(4);
    // The comment colour survives onto the second line of the comment.
    expect(lines![2]).toContain("token comment");
  });

  it("answers null when there is no grammar, so the caller renders plain text", () => {
    expect(highlightLines("x", undefined)).toBeNull();
    expect(highlightLines("x", "not-a-language")).toBeNull();
  });
});
