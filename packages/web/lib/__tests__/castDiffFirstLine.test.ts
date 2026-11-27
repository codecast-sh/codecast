import { describe, expect, test } from "bun:test";
import { firstChangedNewLine, parseCastDiff } from "../castDiff";

const diff = (body: string) => `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${body}`;

describe("where a cast-diff file card's Edit lands", () => {
  test("an addition lands on its own line", () => {
    const [file] = parseCastDiff(diff("@@ -10,3 +10,4 @@\n a\n b\n+c\n d\n"));
    expect(file.path).toBe("src/x.ts");
    expect(firstChangedNewLine(file)).toBe(12);
  });
  test("a removal lands on the line that follows it", () => {
    const [file] = parseCastDiff(diff("@@ -4,3 +4,2 @@\n a\n-b\n c\n"));
    expect(firstChangedNewLine(file)).toBe(5);
  });
  test("no change, no line", () => {
    expect(firstChangedNewLine({ hunks: [] })).toBeUndefined();
  });
});
