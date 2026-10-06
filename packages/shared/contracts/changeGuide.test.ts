import { describe, expect, test } from "bun:test";
import { changeGuideMarkdown, changeGuideOutline, focusHunks, MAX_STEP_HUNK_LINES, parseChangeGuide, parseStepHeading } from "./changeGuide";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,6 +1,7 @@",
  " one",
  " two",
  "-three",
  "+THREE",
  "+three and a half",
  " four",
  " five",
  " six",
  "@@ -40,3 +41,4 @@",
  " forty",
  "+forty-one",
  " forty-two",
  " forty-three",
].join("\n");

describe("parseStepHeading", () => {
  test("backticked range, title keeps its words", () => {
    expect(parseStepHeading("Parse the guide `packages/x/guide.ts:40-120`")).toEqual({ title: "Parse the guide", file: "packages/x/guide.ts", start: 40, end: 120 });
  });
  test("single line, bare path, L prefixes, separators trimmed", () => {
    expect(parseStepHeading("Store it — src/schema.ts:L12")).toEqual({ title: "Store it", file: "src/schema.ts", start: 12, end: 12 });
    expect(parseStepHeading("Wire it (src/a.ts:L3-L9)")).toEqual({ title: "Wire it", file: "src/a.ts", start: 3, end: 9 });
  });
  test("whole file when no range", () => {
    expect(parseStepHeading("New hook `hooks/useGuide.ts`")).toEqual({ title: "New hook", file: "hooks/useGuide.ts" });
  });
  test("prose with a dotted word is not a location", () => {
    expect(parseStepHeading("Why, e.g. the parser, reads first")).toBeNull();
    expect(parseStepHeading("Background")).toBeNull();
  });
});

describe("focusHunks", () => {
  test("keeps only the hunk touching the range, cut to it", () => {
    const got = focusHunks(PATCH, 42, 42)!;
    expect(got.truncated).toBe(false);
    expect(got.hunk).toBe(["@@ -40,3 +41,4 @@", " forty", "+forty-one", " forty-two", " forty-three"].join("\n"));
  });
  test("narrow range trims context to three lines around it", () => {
    const got = focusHunks(PATCH, 3, 3)!;
    expect(got.hunk.split("\n")[0]).toBe("@@ -1,5 +1,6 @@");
    expect(got.hunk).toContain("-three");
    expect(got.hunk).toContain("+THREE");
  });
  test("no range keeps every hunk; a range with no change is null", () => {
    expect(focusHunks(PATCH)!.hunk.match(/^@@/gm)!.length).toBe(2);
    expect(focusHunks(PATCH, 20, 25)).toBeNull();
  });
  test("a long new file is capped and marked truncated", () => {
    const n = MAX_STEP_HUNK_LINES + 40;
    const patch = [`@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+line ${i + 1}`)].join("\n");
    const got = focusHunks(patch)!;
    expect(got.truncated).toBe(true);
    expect(got.hunk.split("\n").length).toBe(MAX_STEP_HUNK_LINES + 1);
    expect(got.hunk.split("\n")[0]).toBe(`@@ -0,0 +1,${MAX_STEP_HUNK_LINES} @@`);
  });
});

describe("parseChangeGuide", () => {
  const md = [
    "# Change guide",
    "Start with the data, then the reader.",
    "",
    "## Store the value `src/a.ts:3`",
    "The schema needs it before anything reads it.",
    "",
    "### Note",
    "A subheading stays inside the step.",
    "```ts",
    "## not a step `src/b.ts:1`",
    "```",
    "",
    "## Read it `src/a.ts:42`",
    "The page reads the stored copy.",
  ].join("\n");

  test("steps, summary and hunks from the diff", () => {
    const calls: string[] = [];
    const guide = parseChangeGuide(md, (file) => { calls.push(file); return PATCH; });
    expect(guide.summary).toBe("# Change guide\nStart with the data, then the reader.");
    expect(guide.steps.map((s) => s.title)).toEqual(["Store the value", "Read it"]);
    expect(guide.steps[0].why).toContain("A subheading stays inside the step.");
    expect(guide.steps[0].why).toContain("## not a step");
    expect(guide.steps[0].hunk).toContain("+THREE");
    expect(guide.steps[1].hunk).toContain("+forty-one");
    expect(calls).toEqual(["src/a.ts"]);
  });

  test("a step with no diff keeps its text and no hunk", () => {
    const guide = parseChangeGuide(md, () => null);
    expect(guide.steps[0].hunk).toBeUndefined();
    expect(guide.steps[0].why).toBe(guide.steps[0].why.trim());
  });

  test("no step heading is an error naming the form", () => {
    expect(() => parseChangeGuide("Just some prose.\n## Heading without a place")).toThrow(/heading per step/);
  });

  test("markdown and outline renderings", () => {
    const guide = parseChangeGuide(md, () => PATCH);
    const body = changeGuideMarkdown(guide, { heading: "## Walkthrough" });
    expect(body).toStartWith("## Walkthrough\n\n# Change guide");
    expect(body).toContain("### 1. Store the value\n`src/a.ts:3`");
    expect(body).toContain("```diff\n@@");
    expect(changeGuideMarkdown(guide, { hunks: false })).not.toContain("```diff");
    expect(changeGuideOutline(guide)).toContain("2. Read it (src/a.ts:42): The page reads the stored copy.");
  });
});
