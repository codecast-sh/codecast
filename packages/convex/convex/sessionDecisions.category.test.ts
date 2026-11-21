import { describe, expect, test } from "bun:test";
import { assignCategory, categoryFor, isHumanOnlyCategory } from "./lib/decisionCategory";

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

  test("a proposal outside the vocabulary is a person's, never an open category", () => {
    expect(assignCategory("deploy")).toBe("unknown");
    expect(assignCategory("security")).toBe("unknown");
    expect(isHumanOnlyCategory(assignCategory("money"))).toBe(true);
  });
});

describe("categoryFor", () => {
  const fresh = { current: null, runDeclares: false, runs: false };
  test("a new agent card: the proposal, else review", () => {
    expect(categoryFor(undefined, fresh)).toBe("review");
    expect(categoryFor("billing", fresh)).toBe("billing");
  });

  test("the run's own ask takes the flow's word, else a person", () => {
    expect(categoryFor(undefined, { current: null, runDeclares: true, runs: true })).toBe("unknown");
    expect(categoryFor("review", { current: null, runDeclares: true, runs: true })).toBe("review");
  });

  test("a station's new card is a person's unless it proposes a person's category", () => {
    const station = { current: null, runDeclares: false, runs: true };
    expect(categoryFor(undefined, station)).toBe("unknown");
    expect(categoryFor("review", station)).toBe("unknown");
    expect(categoryFor("access", station)).toBe("access");
  });

  test("a re-ask or edit keeps the category without a proposal; on a run's card a proposal only tightens", () => {
    expect(categoryFor(undefined, { current: "production", runDeclares: false, runs: false })).toBe("production");
    expect(categoryFor("scope", { current: "production", runDeclares: false, runs: false })).toBe("scope");
    expect(categoryFor("review", { current: "unknown", runDeclares: false, runs: true })).toBe("unknown");
    expect(categoryFor("production", { current: "review", runDeclares: false, runs: true })).toBe("production");
    // A row from before categories keeps a person's hold.
    expect(categoryFor(undefined, { current: undefined, runDeclares: false, runs: false })).toBe("unknown");
  });
});
