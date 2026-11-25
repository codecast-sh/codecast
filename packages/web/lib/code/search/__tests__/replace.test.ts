import { describe, expect, test } from "bun:test";
import { compileQuery, globList, matchLine, usesNoteOperators } from "../query";
import { applyEdits, dominantSeparator, expandReplacement, planReplace, textLines, withCaseOf } from "../replace";

const re = (text: string, o: { regex?: boolean; caseSensitive?: boolean; word?: boolean } = {}) => {
  const c = compileQuery({ text, regex: !!o.regex, caseSensitive: !!o.caseSensitive, word: !!o.word });
  if (!c.re) throw new Error(c.error);
  return c.re;
};
const lit = { regex: false, preserveCase: false };
const rx = { regex: true, preserveCase: false };

describe("compileQuery", () => {
  test("literal text is escaped", () => {
    expect(matchLine(re("a.b(c)"), "xa.b(c) aXb(c)").map((m) => m.start)).toEqual([1]);
  });

  test("case and whole word", () => {
    expect(matchLine(re("foo"), "Foo foo FOO").length).toBe(3);
    expect(matchLine(re("foo", { caseSensitive: true }), "Foo foo FOO").length).toBe(1);
    expect(matchLine(re("foo", { word: true }), "foo food _foo foo_ éfoo (foo)").map((m) => m.start)).toEqual([0, 25]);
  });

  test("an invalid regex is an error, not a throw", () => {
    const c = compileQuery({ text: "foo(", regex: true, caseSensitive: false, word: false });
    expect(c.re).toBeUndefined();
    expect(c.error).toBeTruthy();
    expect(c.error).not.toContain("foo(/");
  });

  test("a legacy-only pattern still compiles", () => {
    expect(compileQuery({ text: "a\\-b", regex: true, caseSensitive: false, word: false }).re).toBeDefined();
  });

  test("empty matches never loop", () => {
    expect(matchLine(re("x*", { regex: true }), "ab").length).toBe(3);
    expect(compileQuery({ text: "", regex: true, caseSensitive: false, word: false }).error).toBe("empty");
  });
});

describe("helpers", () => {
  test("globs keep braces", () => {
    expect(globList(" src/**, *.{ts,tsx} ,,")).toEqual(["src/**", "*.{ts,tsx}"]);
  });

  test("note operators need a value", () => {
    expect(usesNoteOperators("tag:draft")).toBe(true);
    expect(usesNoteOperators("foo -path:archive")).toBe(true);
    expect(usesNoteOperators("path: string")).toBe(false);
    expect(usesNoteOperators("filepath:x")).toBe(false);
  });

  test("lines keep their own separators", () => {
    expect([...textLines("a\r\nb\nc\rd")].map((l) => [l.text, l.sep, l.from])).toEqual([
      ["a", "\r\n", 0],
      ["b", "\n", 3],
      ["c", "\r", 5],
      ["d", "", 7],
    ]);
    expect([...textLines("a\n")].map((l) => l.text)).toEqual(["a", ""]);
    expect(dominantSeparator("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(dominantSeparator("abc")).toBe("\n");
  });
});

describe("expandReplacement", () => {
  const exec = (r: RegExp, s: string) => {
    r.lastIndex = 0;
    return r.exec(s)!;
  };

  test("capture groups, named groups, $& and $$", () => {
    const r = re("(\\w+)@(?<host>\\w+)", { regex: true });
    const m = exec(r, "mail ada@lab now");
    expect(expandReplacement(m, "$2:$1 <$&> $<host> $$1 $9", rx, "mail ada@lab now")).toBe("lab:ada <ada@lab> lab $1 $9");
  });

  test("$` and $' are the line around the match", () => {
    const r = re("b", { regex: true });
    expect(expandReplacement(exec(r, "abc"), "[$`|$']", rx, "abc")).toBe("[a|c]");
  });

  test("two-digit groups only when they exist", () => {
    const r = re("(a)", { regex: true });
    expect(expandReplacement(exec(r, "a"), "$10", rx, "a")).toBe("a0");
  });

  test("escapes in regex mode, literal otherwise", () => {
    const r = re("x", { regex: true });
    expect(expandReplacement(exec(r, "x"), "a\\nb\\t\\\\", rx, "x", "\r\n")).toBe("a\r\nb\t\\");
    expect(expandReplacement(exec(re("x"), "x"), "$1\\n", lit, "x")).toBe("$1\\n");
  });

  test("preserve case", () => {
    expect(withCaseOf("FOO", "bar")).toBe("BAR");
    expect(withCaseOf("foo", "Bar")).toBe("bar");
    expect(withCaseOf("Foo", "bar")).toBe("Bar");
    expect(withCaseOf("fOo", "bar")).toBe("bar");
    expect(withCaseOf("123", "bar")).toBe("bar");
    const r = re("foo");
    expect(expandReplacement(exec(r, "FOO"), "bar", { regex: false, preserveCase: true }, "FOO")).toBe("BAR");
  });
});

describe("planReplace", () => {
  test("several matches on one line, every match", () => {
    const text = "foo foo\nbar\nfoo";
    const plan = planReplace(text, re("foo"), "x", lit, null);
    expect(plan.edits.map((e) => [e.line, e.column])).toEqual([
      [1, 0],
      [1, 4],
      [3, 0],
    ]);
    expect(applyEdits(text, plan.edits)).toBe("x x\nbar\nx");
  });

  test("only the targets, and a missing target is reported", () => {
    const text = "foo foo\nfoo";
    const plan = planReplace(text, re("foo"), "x", lit, [
      { line: 1, column: 4 },
      { line: 2, column: 0 },
      { line: 2, column: 9 },
    ]);
    expect(applyEdits(text, plan.edits)).toBe("foo x\nx");
    expect(plan.missing).toEqual([{ line: 2, column: 9 }]);
  });

  test("regex groups across a CRLF file keep every CRLF", () => {
    const text = "let a = 1;\r\nlet bb = 22;\r\n";
    const plan = planReplace(text, re("let (\\w+) = (\\d+)", { regex: true }), "const $1: number = $2", rx, null);
    expect(applyEdits(text, plan.edits)).toBe("const a: number = 1;\r\nconst bb: number = 22;\r\n");
  });

  test("$ anchors at each line's end, before a CR", () => {
    const text = "a;\r\nb;\r\n";
    const plan = planReplace(text, re(";$", { regex: true }), "", rx, null);
    expect(applyEdits(text, plan.edits)).toBe("a\r\nb\r\n");
  });

  test("\\n in a replacement takes the line's own separator", () => {
    const text = "a,b\r\nc";
    const plan = planReplace(text, re(",", { regex: true }), "\\n", rx, null);
    expect(applyEdits(text, plan.edits)).toBe("a\r\nb\r\nc");
  });

  test("columns are UTF-16, as the daemon reports them", () => {
    const text = "😀 foo";
    const plan = planReplace(text, re("foo"), "bar", lit, [{ line: 1, column: 3 }]);
    expect(plan.missing).toEqual([]);
    expect(applyEdits(text, plan.edits)).toBe("😀 bar");
  });
});

test("ripgrep's flattened pattern error reads as its last clause", async () => {
  const { searchErrorText } = await import("../query");
  expect(searchErrorText("    (?:foo()     ^ error: unclosed group")).toBe("unclosed group");
  expect(searchErrorText("Files is not connected")).toBe("Files is not connected");
});
