import { describe, expect, it } from "vitest";
import { parseFileChangeSummary, parseUnifiedDiffSections } from "../unifiedDiffParser";

describe("parseFileChangeSummary", () => {
  it("extracts file paths from codex file change summaries", () => {
    expect(parseFileChangeSummary("updated: /src/a.ts\ncreated: /src/b.ts")).toEqual([
      "/src/a.ts",
      "/src/b.ts",
    ]);
  });
});

describe("parseUnifiedDiffSections", () => {
  it("parses hunk-only diffs with a fallback file path", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
      " export default a;",
    ].join("\n");

    expect(parseUnifiedDiffSections(diff, ["/src/a.ts"])).toEqual([
      {
        filePath: "/src/a.ts",
        hunks: expect.any(Array),
        oldContent: "const a = 1;\nexport default a;",
        newContent: "const a = 2;\nexport default a;",
      },
    ]);
  });

  it("parses multiple unified diff sections from codex output", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,1 @@",
      "+export const b = true;",
    ].join("\n");

    expect(parseUnifiedDiffSections(diff)).toEqual([
      {
        filePath: "src/a.ts",
        hunks: expect.any(Array),
        oldContent: "const a = 1;",
        newContent: "const a = 2;",
      },
      {
        filePath: "src/b.ts",
        hunks: expect.any(Array),
        oldContent: "",
        newContent: "export const b = true;",
      },
    ]);
  });
});
