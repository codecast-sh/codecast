import { describe, expect, it } from "bun:test";
import { PR_GUIDE_FILE_CHARS, numberPatch, parsePrGuideReply, prGuideRequest, type PrGuideFile } from "./prGuidePrompt";

const PATCH = ["@@ -10,4 +10,5 @@ function a() {", " keep", "-old", "+new one", "+new two", " tail"].join("\n");
const FILES: PrGuideFile[] = [
  { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH },
  { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
];

describe("numberPatch", () => {
  it("numbers context and added lines on the new side and leaves removed lines unnumbered", () => {
    expect(numberPatch(PATCH).split("\n")).toEqual([
      "@@ -10,4 +10,5 @@ function a() {",
      "   10  keep",
      "      -old",
      "   11 +new one",
      "   12 +new two",
      "   13  tail",
    ]);
  });

  it("restarts the count at each hunk header", () => {
    const two = `${PATCH}\n@@ -40,2 +41,2 @@\n x\n+y`;
    expect(numberPatch(two).split("\n").slice(-2)).toEqual(["   41  x", "   42 +y"]);
  });
});

describe("prGuideRequest", () => {
  it("sends the title, description, each file's numbered patch, and says which files have no diff text", () => {
    const req = prGuideRequest({ repository: "o/r", number: 7, title: "Fix a", body: "Because b.", files: FILES });
    expect(req.prompt).toContain("Pull request o/r#7: Fix a");
    expect(req.prompt).toContain("Because b.");
    expect(req.prompt).toContain("### src/a.ts (modified, +2 -1)");
    expect(req.prompt).toContain("   11 +new one");
    expect(req.prompt).toContain("### logo.png (added, +0 -0)\n(no diff text");
  });

  it("cuts one huge file to its share so the files after it still reach the model", () => {
    const huge = "@@ -1,1 +1,4000 @@\n" + Array.from({ length: 4000 }, (_, i) => `+line ${i} ${"x".repeat(20)}`).join("\n");
    const req = prGuideRequest({ repository: "o/r", number: 1, title: "t", body: "", files: [{ filename: "gen.json", status: "added", additions: 4000, deletions: 0, patch: huge }, FILES[0]] });
    expect(req.prompt).toContain("(diff cut here to fit the request)");
    expect(req.prompt).toContain("   11 +new one");
    expect(req.prompt.length).toBeLessThan(PR_GUIDE_FILE_CHARS + 5_000);
  });
});

describe("parsePrGuideReply", () => {
  it("parses the reply as an author's guide would be, with each step's hunk from the PR's patch", () => {
    const guide = parsePrGuideReply("Swaps the old line.\n\n## Replace the line `src/a.ts:11-12`\nWhy it changed.", FILES);
    expect(guide.summary).toBe("Swaps the old line.");
    expect(guide.steps).toHaveLength(1);
    expect(guide.steps[0]).toMatchObject({ title: "Replace the line", file: "src/a.ts", start: 11, end: 12, why: "Why it changed." });
    expect(guide.steps[0].hunk).toContain("+new one");
  });

  it("drops a step about a file the PR does not change", () => {
    const guide = parsePrGuideReply("## Real `src/a.ts:11`\nok\n\n## Invented `src/zzz.ts:3`\nno", FILES);
    expect(guide.steps.map((s) => s.file)).toEqual(["src/a.ts"]);
  });

  it("refuses a reply with no step on this PR's files", () => {
    expect(() => parsePrGuideReply("## Invented `src/zzz.ts:3`\nno", FILES)).toThrow(/no file this pull request changes/);
    expect(() => parsePrGuideReply("Just prose.", FILES)).toThrow(/heading per step/);
  });
});
