import { describe, expect, test } from "bun:test";
import { buildDiffMetadata, diffRows } from "./diffMetadata";

const shown = (rows: ReturnType<typeof diffRows>) => rows.filter((r) => !r.hidden);

describe("buildDiffMetadata + diffRows", () => {
  test("a whole file keeps every line as a row, the unchanged stretches hidden", () => {
    const oldStr = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const meta = buildDiffMetadata({ oldStr, newStr: oldStr.replace("d", "X"), contextLines: 1, name: "x.ts" });
    expect(meta.isPartial).toBe(false);
    const rows = diffRows(meta);
    expect(rows.map((r) => [r.type, r.content, r.oldNum, r.newNum, !!r.hidden])).toEqual([
      ["context", "a", 1, 1, true],
      ["context", "b", 2, 2, true],
      ["context", "c", 3, 3, false],
      ["removed", "d", 4, undefined, false],
      ["added", "X", undefined, 4, false],
      ["context", "e", 5, 5, false],
      ["context", "f", 6, 6, true],
      ["context", "g", 7, 7, true],
      ["context", "h", 8, 8, true],
    ]);
  });

  test("a snippet is numbered from the line it starts on", () => {
    const rows = diffRows(buildDiffMetadata({ oldStr: "a\nold\nc", newStr: "a\nnew\nc", startLine: 40, name: "x.ts" }));
    expect(rows.map((r) => [r.type, r.content, r.oldNum, r.newNum])).toEqual([
      ["context", "a", 40, 40],
      ["removed", "old", 41, undefined],
      ["added", "new", undefined, 41],
      ["context", "c", 42, 42],
    ]);
  });

  test("identical text (a Read result) is every line as context", () => {
    const meta = buildDiffMetadata({ oldStr: "p\nq\n", newStr: "p\nq\n", startLine: 10, name: "x.ts" });
    expect(meta.type).toBe("change");
    expect(diffRows(meta).map((r) => [r.content, r.oldNum, r.newNum])).toEqual([["p", 10, 10], ["q", 11, 11]]);
  });

  test("a new file is all additions", () => {
    const rows = diffRows(buildDiffMetadata({ oldStr: "", newStr: "one\ntwo", name: "x.ts" }));
    expect(rows.map((r) => [r.type, r.newNum])).toEqual([["added", 1], ["added", 2]]);
  });

  test("parsed pull request hunks keep their numbers", () => {
    const rows = diffRows(buildDiffMetadata({
      name: "x.ts",
      hunks: [
        { oldStart: 5, oldCount: 2, newStart: 5, newCount: 2, lines: [
          { type: "context", content: "k", oldLineNumber: 5, newLineNumber: 5 },
          { type: "deletion", content: "d", oldLineNumber: 6 },
          { type: "addition", content: "A", newLineNumber: 6 },
        ] },
        { oldStart: 20, oldCount: 1, newStart: 20, newCount: 2, lines: [
          { type: "context", content: "z", oldLineNumber: 20, newLineNumber: 20 },
          { type: "addition", content: "B", newLineNumber: 21 },
        ] },
      ],
    }));
    expect(rows.map((r) => [r.type, r.content, r.oldNum, r.newNum])).toEqual([
      ["context", "k", 5, 5],
      ["removed", "d", 6, undefined],
      ["added", "A", undefined, 6],
      ["context", "z", 20, 20],
      ["added", "B", undefined, 21],
    ]);
  });

  test("a large rewrite diffs in linear-ish time", () => {
    const oldStr = Array.from({ length: 5000 }, (_, i) => `const a${i} = ${i};`).join("\n");
    const newStr = Array.from({ length: 5000 }, (_, i) => `const b${i} = ${i};`).join("\n");
    const start = performance.now();
    const rows = shown(diffRows(buildDiffMetadata({ oldStr, newStr, startLine: 3, name: "x.ts" })));
    expect(rows.length).toBe(10_000);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
