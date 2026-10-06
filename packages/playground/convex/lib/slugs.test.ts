import { describe, expect, test } from "bun:test";
import { APP_NAME_MAX, SLUG_STEM_MAX, cleanAppName, isSlug, makeSlug, nameFromPrompt, slugStem } from "./slugs";

describe("slugs", () => {
  test("a stem is lowercase ascii words joined by hyphens", () => {
    expect(slugStem("Frog Choir!")).toBe("frog-choir");
    expect(slugStem("  Crème   Brûlée -- 2 ")).toBe("creme-brulee-2");
  });

  test("a long name is cut on a word boundary", () => {
    const stem = slugStem("a guestbook where every visitor plants a tiny planet");
    expect(stem).toBe("a-guestbook-where-every-visitor");
    expect(stem.length).toBeLessThanOrEqual(SLUG_STEM_MAX);
  });

  test("a single giant word is truncated; nothing usable becomes app", () => {
    expect(slugStem("x".repeat(80))).toHaveLength(SLUG_STEM_MAX);
    expect(slugStem("!!! ???")).toBe("app");
    expect(slugStem("🐸🎶")).toBe("app");
  });

  test("makeSlug appends a tail and the result is a valid slug", () => {
    expect(makeSlug("Frog choir", "k3x9")).toBe("frog-choir-k3x9");
    const slug = makeSlug("Frog choir");
    expect(slug).toMatch(/^frog-choir-[a-z2-9]{4}$/);
    expect(isSlug(slug)).toBe(true);
    expect(isSlug(makeSlug("x".repeat(80)))).toBe(true);
  });

  test("isSlug refuses anything a route or a typo could produce", () => {
    for (const bad of ["", "Frog", "frog--choir", "-frog", "frog-", "frog/choir", "a".repeat(60), 7]) {
      expect(isSlug(bad)).toBe(false);
    }
  });
});

describe("app names", () => {
  test("cleanAppName trims, folds whitespace and caps", () => {
    expect(cleanAppName("  Haiku \n Wall ")).toBe("Haiku Wall");
    expect(cleanAppName("   ")).toBeNull();
    expect(cleanAppName(null)).toBeNull();
    expect(cleanAppName("y".repeat(100))).toHaveLength(APP_NAME_MAX);
  });

  test("nameFromPrompt keeps the subject of the first clause", () => {
    expect(nameFromPrompt("a frog choir, one note per person")).toBe("Frog choir");
    expect(nameFromPrompt("make me a guestbook where every visitor plants a tiny planet")).toBe("Guestbook");
    expect(nameFromPrompt("Build a pixel art board for the whole office")).toBe("Pixel art board");
    expect(nameFromPrompt("snake game with power ups")).toBe("Snake game");
    expect(nameFromPrompt("Please create the tiniest drum machine ever made")).toBe("Tiniest drum machine ever");
    expect(nameFromPrompt("   ")).toBe("Untitled");
  });
});
