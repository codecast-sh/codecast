import { expect, test } from "bun:test";
import { contentHash } from "@codecast/shared/diff";
import { hasReviewBase, isSeen, reviewBaseId, toggleSeen } from "../diffSeenMarks";

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
  expect(cleared).toEqual({ b: { h: v } });
});

test("a mark records the change it was made on and keeps the one before", () => {
  const v1 = contentHash("1"), v2 = contentHash("2");
  const first = toggleSeen(undefined, "a", v1, "c1");
  expect(first.a).toEqual({ h: v1, at: "c1" });
  const second = toggleSeen(first, "a", v2, "c4");
  expect(second.a).toEqual({ h: v2, at: "c4", prev: { h: v1, at: "c1" } });
  // Clearing a live mark steps back to the review before it.
  expect(toggleSeen(second, "a", v2).a).toEqual({ h: v1, at: "c1" });
});

test("an old bare-string mark still reads as seen and becomes the previous version", () => {
  const v1 = contentHash("1"), v2 = contentHash("2");
  expect(isSeen({ a: v1 }, "a", v1)).toBe(true);
  expect(toggleSeen({ a: v1 }, "a", v2, "c3").a).toEqual({ h: v2, at: "c3", prev: { h: v1 } });
  expect(hasReviewBase({ a: v1 })).toBe(false);
});

test("the review base: the reviewed change when the file moved, else the review before", () => {
  const mark = { h: "x", at: "c4", prev: { h: "w", at: "c1" } };
  expect(reviewBaseId(mark, "c9")).toBe("c4");
  expect(reviewBaseId(mark, "c4")).toBe("c1");
  expect(reviewBaseId({ h: "x", at: "c4" }, "c4")).toBeUndefined();
  expect(reviewBaseId("x", "c9")).toBeUndefined();
  expect(reviewBaseId(undefined, "c9")).toBeUndefined();
  expect(hasReviewBase({ a: mark })).toBe(true);
});
