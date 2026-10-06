import { expect, test } from "bun:test";
import { contentHash } from "@codecast/shared/diff";
import { isSeen, toggleSeen } from "../diffSeenMarks";

test("a mark holds while the file's text is the one it was made on", () => {
  const v1 = contentHash("const a = 1;\n");
  const marks = toggleSeen(undefined, "src/a.ts", v1);
  expect(isSeen(marks, "src/a.ts", v1)).toBe(true);
  expect(isSeen(marks, "src/b.ts", v1)).toBe(false);
});

test("a mark lapses when the file changes again after it", () => {
  const v1 = contentHash("const a = 1;\n");
  const v2 = contentHash("const a = 2;\n");
  const marks = toggleSeen(undefined, "src/a.ts", v1);
  expect(isSeen(marks, "src/a.ts", v2)).toBe(false);
  // Marking the changed file again stamps the new text rather than clearing.
  const again = toggleSeen(marks, "src/a.ts", v2);
  expect(isSeen(again, "src/a.ts", v2)).toBe(true);
  // The agent putting the text back revives nothing it did not mean to: the
  // stamp names the newer text now.
  expect(isSeen(again, "src/a.ts", v1)).toBe(false);
});

test("toggling a live mark clears it and leaves the others", () => {
  const v = contentHash("x");
  const marks = toggleSeen(toggleSeen(undefined, "a", v), "b", v);
  const cleared = toggleSeen(marks, "a", v);
  expect(cleared).toEqual({ b: v });
});
