import { describe, expect, test } from "bun:test";
import { formatCost, formatDayOffset, formatDuration, formatVirtual, shortId } from "./format";
import { cell, makePalette, padEnd, renderFields, renderNext, renderTable, stripAnsi, truncate, wrapText } from "./render";

describe("palette", () => {
  test("off returns the text untouched; on wraps it", () => {
    expect(makePalette(false).red("x")).toBe("x");
    expect(makePalette(true).red("x")).toBe("\x1b[31mx\x1b[0m");
    expect(stripAnsi(makePalette(true).bold("y"))).toBe("y");
  });
});

describe("columns", () => {
  test("padEnd ignores escape codes", () => {
    const p = makePalette(true);
    expect(stripAnsi(padEnd(p.red("ab"), 5))).toBe("ab   ");
  });
  test("cell cuts before styling so the escape code survives", () => {
    const p = makePalette(true);
    const out = cell("a long value", 6, p.green);
    expect(stripAnsi(out)).toBe("a lon…");
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });
  test("truncate keeps newlines and marks the cut", () => {
    expect(truncate("abc\ndef", 10)).toBe("abc\ndef");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("wrapText", () => {
  test("wraps on words, keeps paragraphs, splits a long token", () => {
    expect(wrapText("one two three four five six seven eight", 20)).toEqual(["one two three four", "five six seven eight"]);
    expect(wrapText("a\n\n\nb", 40)).toEqual(["a", "", "b"]);
    const url = "x".repeat(50);
    expect(wrapText(url, 20)).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(10)]);
  });
});

describe("blocks", () => {
  const p = makePalette(false);
  test("renderNext aligns commands", () => {
    const lines = renderNext(
      [
        ["xrun convo show 1", "the conversation"],
        ["xrun freeze create 12345678", "freeze here"],
      ],
      p,
    );
    expect(lines[0]).toBe("Next:");
    expect(lines[1]).toBe("  xrun convo show 1             the conversation");
    expect(lines[2]).toBe("  xrun freeze create 12345678   freeze here");
  });
  test("renderTable sizes columns from content and cuts the flexible one", () => {
    const rows = [
      { id: "abcdefgh", n: 3, text: "a very long body that will need cutting to fit" },
      { id: "12345678", n: 12, text: "short" },
    ];
    const lines = renderTable(
      rows,
      [
        { header: "id", width: 8, value: (r) => r.id },
        { header: "n", width: 3, align: "right", value: (r) => String(r.n) },
        { header: "text", value: (r) => r.text },
      ],
      p,
      30,
    );
    expect(lines[0]).toBe("id          n  text");
    expect(lines[1]).toBe("abcdefgh    3  a very long bo…");
    expect(lines[1].length).toBe(30);
    expect(lines[2]).toBe("12345678   12  short");
  });
  test("renderFields drops empty values and aligns keys", () => {
    expect(renderFields([["name", "x"], ["notes", ""], ["created", "today"]], p)).toEqual(["name     x", "created  today"]);
  });
});

describe("format", () => {
  test("cost, duration, virtual, day offset, short id", () => {
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.42)).toBe("$0.420");
    expect(formatCost(4.2)).toBe("$4.20");
    expect(formatDuration(950)).toBe("950ms");
    expect(formatDuration(65_000)).toBe("1.1m");
    expect(formatVirtual(3 * 3_600_000)).toBe("3.0h");
    expect(formatVirtual(72 * 3_600_000)).toBe("3.0d");
    expect(formatDayOffset("2026-03-03T14:05:00Z", "2026-03-01T09:00:00Z")).toBe("d02 05:05");
    expect(formatDayOffset("2026-03-01T08:00:00Z", "2026-03-01T09:00:00Z")).toBe("d-1 23:00");
    expect(shortId("abcdefghijk")).toBe("abcdefgh");
    expect(shortId(null)).toBe("");
  });
});
