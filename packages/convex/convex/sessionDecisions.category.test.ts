import { describe, expect, test } from "bun:test";
import { assignCategory, isHumanOnlyCategory } from "./lib/decisionCategory";

describe("category assignment", () => {
  test("the asker's proposal stands, open or protected", () => {
    expect(assignCategory("approach")).toBe("approach");
    expect(assignCategory("production")).toBe("production");
    expect(isHumanOnlyCategory(assignCategory("data"))).toBe(true);
  });

  test("no proposal is review, which a role may answer under a grant", () => {
    expect(assignCategory(undefined)).toBe("review");
    expect(isHumanOnlyCategory(assignCategory(undefined))).toBe(false);
  });

  test("a proposal outside the vocabulary, or unknown, is review", () => {
    expect(assignCategory("whatever")).toBe("review");
    expect(assignCategory("unknown")).toBe("review");
  });

  test("rows that still carry unknown stay held by a person", () => {
    expect(isHumanOnlyCategory("unknown")).toBe(true);
  });
});
