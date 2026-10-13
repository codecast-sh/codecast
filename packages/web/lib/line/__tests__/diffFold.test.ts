import { describe, expect, test } from "bun:test";
import { foldGenerated, isGeneratedFile } from "../diffFold";

const f = (filename: string, additions = 1, deletions = 1) => ({ filename, additions, deletions });

describe("foldGenerated", () => {
  test("folds regenerated fixtures under one row after the change", () => {
    const files = [
      f("outreach/backend/src/lib/needs/statedFields.ts", 27, 6),
      f("outreach/backend/tests/unit/__fixtures__/promptTemplateFidelity/email-grounded.txt"),
      f("outreach/backend/tests/unit/__fixtures__/promptTemplateFidelity/email-selling.txt"),
      f("outreach/backend/src/lib/needs/feeWillingness.ts", 12, 0),
    ];
    const r = foldGenerated(files);
    expect(r.change.map((x) => x.filename)).toEqual(["outreach/backend/src/lib/needs/statedFields.ts", "outreach/backend/src/lib/needs/feeWillingness.ts"]);
    expect(r.generated).toHaveLength(2);
    expect(r.words).toBe("2 fixture files, +1 −1 each");
  });

  test("sums when the folded files differ, and names snapshots", () => {
    const r = foldGenerated([f("src/a.ts"), f("src/__snapshots__/a.test.ts.snap", 4, 2), f("src/__snapshots__/b.test.ts.snap", 1, 0)]);
    expect(r.words).toBe("2 snapshot files, +5 −2");
  });

  test("a diff of fixtures alone, or none, is not folded", () => {
    expect(foldGenerated([f("tests/fixtures/a.json")]).words).toBeNull();
    expect(foldGenerated([f("src/a.ts")]).generated).toEqual([]);
  });

  test("only generated paths count", () => {
    expect(isGeneratedFile("packages/web/lib/fixtures.ts")).toBe(false);
    expect(isGeneratedFile("packages/cli/src/__fixtures__/install-golden/existing/mods.md")).toBe(true);
    expect(isGeneratedFile("go/testdata/out.txt")).toBe(true);
  });
});
