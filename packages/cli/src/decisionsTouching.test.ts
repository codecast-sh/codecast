import { describe, expect, test } from "bun:test";
import { conversationIdsFromTrailers, parseOldSpans } from "./decisionsTouching";

describe("decisionsTouching", () => {
  test("old-side spans: replaced lines, a pure insertion anchored after its line, new files skipped", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@ fn",
      "@@ -40,0 +42,2 @@",
      "@@ -7 +9 @@",
      "diff --git a/src/new.ts b/src/new.ts",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,5 @@",
    ].join("\n");
    expect([...parseOldSpans(patch)]).toEqual([["src/a.ts", [[10, 12], [40, 40], [7, 7]]]]);
  });

  test("conversation ids from trailer values", () => {
    const text = "https://codecast.sh/conversation/jx73nf7n75yr54qqcjvssnm6498jcfed\n\nhttps://codecast.sh/conversation/jx73nf7n75yr54qqcjvssnm6498jcfed\n";
    expect(conversationIdsFromTrailers(text)).toEqual(["jx73nf7n75yr54qqcjvssnm6498jcfed"]);
  });
});
