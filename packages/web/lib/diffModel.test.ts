import { describe, expect, test } from "bun:test";
import { processFile } from "@pierre/diffs";
import { buildDiffModel, diffPatchText, diffRows, type DiffModel } from "./diffModel";

const rowsOf = (model: DiffModel) => diffRows(model).map((r) => [r.type, r.content, r.oldNum, r.newNum, !!r.hidden]);

// What Pierre will number each line as, read from the patch DiffView hands it:
// the rows and the drawing must agree line for line.
function pierreNumbers(model: DiffModel) {
  const meta = processFile(diffPatchText(model, "x.ts"), model.whole && {
    oldFile: { name: "x.ts", contents: model.whole.oldStr },
    newFile: { name: "x.ts", contents: model.whole.newStr },
  })!;
  const out: Array<[string, number | undefined, number | undefined]> = [];
  for (const hunk of meta.hunks) {
    const oldNum = (i: number) => hunk.deletionStart + i - hunk.deletionLineIndex;
    const newNum = (i: number) => hunk.additionStart + i - hunk.additionLineIndex;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let k = 0; k < block.lines; k++) out.push(["context", oldNum(block.deletionLineIndex + k), newNum(block.additionLineIndex + k)]);
        continue;
      }
      for (let k = 0; k < block.deletions; k++) out.push(["removed", oldNum(block.deletionLineIndex + k), undefined]);
      for (let k = 0; k < block.additions; k++) out.push(["added", undefined, newNum(block.additionLineIndex + k)]);
    }
  }
  return out;
}
const shownNumbers = (model: DiffModel) => diffRows(model).filter((r) => !r.hidden).map((r) => [r.type, r.oldNum, r.newNum]);

describe("buildDiffModel + diffRows", () => {
  test("a whole file keeps every line as a row, the unchanged stretches hidden", () => {
    const oldStr = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const model = buildDiffModel({ oldStr, newStr: oldStr.replace("d", "X"), contextLines: 1 });
    expect(model.whole).toBeDefined();
    expect(rowsOf(model)).toEqual([
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
    expect(pierreNumbers(model)).toEqual(shownNumbers(model));
  });

  test("a snippet is numbered from the line it starts on", () => {
    const model = buildDiffModel({ oldStr: "a\nold\nc", newStr: "a\nnew\nc", startLine: 40 });
    expect(model.whole).toBeUndefined();
    expect(rowsOf(model)).toEqual([
      ["context", "a", 40, 40, false],
      ["removed", "old", 41, undefined, false],
      ["added", "new", undefined, 41, false],
      ["context", "c", 42, 42, false],
    ]);
    expect(pierreNumbers(model)).toEqual(shownNumbers(model));
  });

  test("identical text (a Read result) is every line as context", () => {
    const model = buildDiffModel({ oldStr: "p\nq\n", newStr: "p\nq\n", startLine: 10 });
    expect(rowsOf(model)).toEqual([["context", "p", 10, 10, false], ["context", "q", 11, 11, false]]);
    expect(pierreNumbers(model)).toEqual(shownNumbers(model));
  });

  test("a new file is all additions, and a deleted one all deletions", () => {
    const created = buildDiffModel({ oldStr: "", newStr: "one\ntwo" });
    expect(rowsOf(created)).toEqual([["added", "one", undefined, 1, false], ["added", "two", undefined, 2, false]]);
    expect(pierreNumbers(created)).toEqual(shownNumbers(created));
    const removed = buildDiffModel({ oldStr: "one\ntwo", newStr: "", startLine: 7 });
    expect(rowsOf(removed)).toEqual([["removed", "one", 7, undefined, false], ["removed", "two", 8, undefined, false]]);
    expect(pierreNumbers(removed)).toEqual(shownNumbers(removed));
  });

  test("an insertion and a deletion mid-file keep both sides' numbers", () => {
    const oldStr = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const newStr = oldStr.replace("l5\n", "l5\nnew\n").replace("l20\n", "");
    const model = buildDiffModel({ oldStr, newStr, contextLines: 2 });
    expect(pierreNumbers(model)).toEqual(shownNumbers(model));
    const rows = diffRows(model);
    expect(rows.find((r) => r.content === "new")).toMatchObject({ type: "added", newNum: 6 });
    expect(rows.find((r) => r.type === "removed")).toMatchObject({ content: "l20", oldNum: 20 });
    expect(rows.find((r) => r.content === "l30")).toMatchObject({ oldNum: 30, newNum: 30, hidden: true });
  });

  test("parsed pull request hunks keep their numbers", () => {
    const model = buildDiffModel({
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
    });
    expect(rowsOf(model).map((r) => r.slice(0, 4))).toEqual([
      ["context", "k", 5, 5],
      ["removed", "d", 6, undefined],
      ["added", "A", undefined, 6],
      ["context", "z", 20, 20],
      ["added", "B", undefined, 21],
    ]);
    expect(pierreNumbers(model)).toEqual(shownNumbers(model));
  });

  test("a large rewrite gives up on the minimal diff and stays fast", () => {
    const oldStr = Array.from({ length: 5000 }, (_, i) => `const a${i} = ${i};`).join("\n");
    const newStr = Array.from({ length: 5000 }, (_, i) => `const b${i} = ${i};`).join("\n");
    const start = performance.now();
    const rows = diffRows(buildDiffModel({ oldStr, newStr, startLine: 3 }));
    expect(rows.length).toBe(10_000);
    expect(rows[0]).toMatchObject({ type: "removed", oldNum: 3 });
    expect(rows[5000]).toMatchObject({ type: "added", newNum: 3 });
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
