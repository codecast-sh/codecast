import { describe, expect, test } from "bun:test";
import { formatKey, hasMarks, markRuns, richLines, toggleList, wrapRuns } from "./boardMarks";

const key = (k: string, shift = false) => ({ key: k, metaKey: true, ctrlKey: false, shiftKey: shift });

describe("board text marks", () => {
  test("list lines", () => {
    expect(richLines("Title\n- one\n2. two\nplain")).toEqual([
      { kind: "text", text: "Title" }, { kind: "bullet", text: "one" }, { kind: "number", n: 2, text: "two" }, { kind: "text", text: "plain" },
    ]);
  });
  test("hasMarks finds marks and lists, not plain text", () => {
    expect(hasMarks("ship **now**")).toBe(true);
    expect(hasMarks("see https://x.dev")).toBe(true);
    expect(hasMarks("- item")).toBe(true);
    expect(hasMarks("plain words 2 * 3")).toBe(false);
  });
  test("Cmd+B wraps and unwraps the selection", () => {
    const on = formatKey(key("b"), "ship now", 5, 8)!;
    expect(on).toEqual({ value: "ship **now**", start: 7, end: 10 });
    expect(formatKey(key("b"), on.value, on.start, on.end)).toEqual({ value: "ship now", start: 5, end: 8 });
  });
  test("Cmd+I inside bold adds italic rather than eating a bold star", () => {
    expect(formatKey(key("i"), "**now**", 2, 5)!.value).toBe("***now***");
  });
  test("Cmd+K makes a link and selects its url", () => {
    const r = formatKey(key("k"), "see docs", 4, 8)!;
    expect(r.value).toBe("see [docs](https://)");
    expect(r.value.slice(r.start, r.end)).toBe("https://");
  });
  test("other keys pass", () => {
    expect(formatKey(key("z"), "a", 0, 1)).toBeNull();
    expect(formatKey({ ...key("b"), metaKey: false }, "a", 0, 1)).toBeNull();
  });
});

describe("list toggle", () => {
  test("bullets the touched lines and takes them off again", () => {
    const on = toggleList("Title\none\ntwo", 7, 12);
    expect(on.value).toBe("Title\n- one\n- two");
    expect(toggleList(on.value, on.start, on.end).value).toBe("Title\none\ntwo");
  });
});

describe("styled runs for export", () => {
  test("marks become runs; links keep their address", () => {
    expect(markRuns("ship **now** see [docs](https://x.dev)")).toEqual([
      { t: "ship " }, { t: "now", b: true }, { t: " see " }, { t: "docs", href: "https://x.dev" },
    ]);
  });
  test("wrapping keeps each word's style and breaks at spaces", () => {
    const lines = wrapRuns("**Launch** the new checklist today", 10, (s) => s.length);
    expect(lines.map((l) => l.map((r) => r.t).join("").trim())).toEqual(["Launch the", "new", "checklist", "today"]);
    expect(lines[0][0]).toEqual({ t: "Launch", b: true });
  });
  test("list lines get their mark", () => {
    expect(wrapRuns("- one", 100, (s) => s.length)[0].map((r) => r.t).join("")).toBe("• one");
  });
});
