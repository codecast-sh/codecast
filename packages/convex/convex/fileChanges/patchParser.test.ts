import { expect, test } from "bun:test";
import { parsePatch } from "./patchParser";

const counted = (h: { lines: { type: string }[] }) => ({
  old: h.lines.filter((l) => l.type !== "addition").length,
  new: h.lines.filter((l) => l.type !== "deletion").length,
});

test("the empty string after a patch's final newline is not a context line", () => {
  const { hunks, newContent } = parsePatch("--- a/x\n+++ b/x\n@@ -1,0 +1,2 @@\n+a\n+b\n");
  expect(hunks[0].lines.map((l) => l.type)).toEqual(["addition", "addition"]);
  expect(counted(hunks[0])).toEqual({ old: 0, new: 2 });
  expect(newContent.split("\n")).toEqual(["a", "b"]);
});

test("a bare empty line inside a hunk is still a blank context line", () => {
  const { hunks } = parsePatch("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n\n@@ -9,1 +9,1 @@\n-x\n+y\n");
  expect(hunks.map(counted)).toEqual([{ old: 3, new: 3 }, { old: 1, new: 1 }]);
  expect(hunks[0].lines[1]).toMatchObject({ type: "context", content: "" });
});
