import { describe, expect, it } from "bun:test";
import { detectIndent, indentLabel } from "../indent";

const lines = (...ls: string[]) => ls.join("\n");

describe("detectIndent", () => {
  it("reads two-space code, ignoring a deep nesting's absolute widths", () => {
    const text = lines("function a() {", "  if (x) {", "    if (y) {", "      go();", "    }", "  }", "}");
    expect(detectIndent(text)).toMatchObject({ tabs: false, width: 2, unit: "  ", detected: true });
  });

  it("reads four-space code", () => {
    const text = lines("def a():", "    if x:", "        go()", "    return 1", "", "def b():", "    pass");
    expect(detectIndent(text)).toMatchObject({ tabs: false, width: 4, detected: true });
  });

  it("reads tabs, with the configured display width", () => {
    const text = lines("func a() {", "\tif x {", "\t\tgo()", "\t}", "}");
    expect(detectIndent(text, { tabSize: 8 })).toMatchObject({ tabs: true, unit: "\t", width: 8 });
  });

  it("does not let JSDoc's one-space alignment vote for width 1", () => {
    const text = lines("/**", " * Docs.", " * More.", " */", "export function a() {", "  return 1;", "}");
    expect(detectIndent(text).width).toBe(2);
  });

  it("skips blank and whitespace-only lines", () => {
    const text = lines("a:", "    b: 1", "        ", "", "    c: 2", "        d: 3");
    expect(detectIndent(text).width).toBe(4);
  });

  it("falls back to the language's convention when the file cannot say", () => {
    expect(detectIndent("package main", { languageName: "Go" })).toMatchObject({ tabs: true, detected: false });
    expect(detectIndent("x = 1", { languageName: "Python" })).toMatchObject({ tabs: false, width: 4, detected: false });
    expect(detectIndent("const a = 1;")).toMatchObject({ tabs: false, width: 2, detected: false });
  });

  it("handles CRLF files", () => {
    const text = ["{", '    "a": {', '        "b": 1', "    }", "}"].join("\r\n");
    expect(detectIndent(text).width).toBe(4);
  });

  it("labels the way editors do", () => {
    expect(indentLabel(detectIndent(lines("a", "  b")))).toBe("Spaces: 2");
    expect(indentLabel(detectIndent(lines("a", "\tb"), { tabSize: 4 }))).toBe("Tab Size: 4");
  });
});
