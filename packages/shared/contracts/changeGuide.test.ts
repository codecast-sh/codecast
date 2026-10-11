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
  test("route files keep their brackets", () => {
    expect(parseStepHeading("Rows `packages/mobile/app/task/[id].tsx:81-88`")).toEqual({ title: "Rows", file: "packages/mobile/app/task/[id].tsx", start: 81, end: 88 });
    expect(parseStepHeading("Page — app/tasks/[id]/page.tsx:12")).toEqual({ title: "Page", file: "app/tasks/[id]/page.tsx", start: 12, end: 12 });
    expect(parseStepHeading("Tabs `packages/mobile/app/(tabs)/index.tsx:3-9`")).toEqual({ title: "Tabs", file: "packages/mobile/app/(tabs)/index.tsx", start: 3, end: 9 });
    expect(parseStepHeading("Tabs app/(tabs)/index.tsx:3")).toEqual({ title: "Tabs", file: "app/(tabs)/index.tsx", start: 3, end: 3 });
    expect(parseStepHeading("Catch-all `app/[[...slug]]/page.tsx`")).toEqual({ title: "Catch-all", file: "app/[[...slug]]/page.tsx" });
    expect(parseStepHeading("Wire it (src/a.ts)")).toEqual({ title: "Wire it", file: "src/a.ts" });
  });
  test("a bracket around a bare path is not part of it", () => {
    expect(parseStepHeading("Wire it [src/a.ts]")).toBeNull();
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
  // The scratch e2e's file: a block of new lines 6-15, then take() at 16-21.
  const REFILL = [
    "@@ -3,5 +3,15 @@",
    "   updatedAt: number;",
    " }",
    " ",
    ...Array.from({ length: 10 }, (_, i) => `+new ${i + 6}`),
    " export function take(bucket: Bucket, now: number): boolean {",
    "-  if (bucket.tokens <= 0) return false;",
    "+  refill(bucket, now);",
    "+  if (bucket.tokens < 1) return false;",
    "   bucket.tokens -= 1;",
    "-  bucket.updatedAt = now;",
    "   return true;",
    " }",
  ].join("\n");
  const newLines = (hunk: string) => {
    const out: number[] = [];
    let n = 0;
    for (const l of hunk.split("\n")) {
      const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (h) { n = Number(h[1]); continue; }
      if (l[0] !== "-") out.push(n++);
    }
    return out;
  };

  test("touching ranges share no line: each step stops where the other starts", () => {
    const a = focusHunks(REFILL, 6, 15, [{ start: 16, end: 21 }])!.hunk;
    const b = focusHunks(REFILL, 16, 21, [{ start: 6, end: 15 }])!.hunk;
    expect(Math.max(...newLines(a))).toBe(15);
    expect(Math.min(...newLines(b))).toBe(16);
    expect(a).not.toContain("refill(bucket, now)");
    expect(b).not.toContain("+new 15");
  });

  test("ranges one line apart share just the line between them", () => {
    const a = focusHunks(REFILL, 6, 14, [{ start: 16, end: 21 }])!.hunk;
    const b = focusHunks(REFILL, 16, 21, [{ start: 6, end: 14 }])!.hunk;
    const shared = newLines(a).filter((n) => newLines(b).includes(n));
    expect(shared).toEqual([15]);
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

  test("steps in one file are focused against each other", () => {
    const guide = parseChangeGuide("## Head `src/a.ts:3`\nx\n\n## Tail `src/a.ts:4`\ny", () => PATCH);
    const lines = (h: string) => h.split("\n").filter((l) => !l.startsWith("@@"));
    // Line 3 and 4 touch: the first step ends at 3, the second starts at 4.
    expect(lines(guide.steps[0].hunk!)).not.toContain("+three and a half");
    expect(lines(guide.steps[1].hunk!)).not.toContain("+THREE");
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
