import { describe, expect, test } from "bun:test";
import { minePhrases, rankInputs, sanitizeSuggestions } from "./composerSuggestions";

const DAY = 24 * 60 * 60 * 1000;

describe("minePhrases", () => {
  test("finds a phrase recurring inside different sentences", () => {
    const phrases = minePhrases([
      "fix the bug and add a regression test for it",
      "before you fix it add a regression test please",
      "add a regression test then deploy",
      "unrelated message about something else entirely",
    ]);
    expect(phrases.some((p) => p.text.includes("add a regression test"))).toBe(true);
  });

  test("counts once per message — repetition inside one message doesn't inflate", () => {
    const phrases = minePhrases([
      "make it beautiful, really make it beautiful, make it beautiful now",
      "another message entirely about other things",
      "third message with different content here",
    ]);
    // Appears in only 1 of 3 messages → below the ≥3 support floor.
    expect(phrases.some((p) => p.text.includes("make it beautiful"))).toBe(false);
  });

  test("prefers the longer phrase when support is comparable", () => {
    const phrases = minePhrases([
      "work hard on this problem with agents",
      "please work hard on this problem today",
      "work hard on this problem and iterate",
    ]);
    const texts = phrases.map((p) => p.text);
    expect(texts).toContain("work hard on this problem");
    // The contained shorter fragment must not appear alongside it.
    expect(texts).not.toContain("work hard on this");
  });
});

describe("rankInputs", () => {
  const now = 100 * DAY;

  test("frequent keeps repeated multi-word inputs, never one/two-word nudges", () => {
    const { frequent } = rankInputs(
      [
        { text: "continue", ts: now - 1 * DAY },
        { text: "continue", ts: now - 2 * DAY },
        { text: "continue", ts: now - 3 * DAY },
        { text: "go", ts: now - 1 * DAY },
        { text: "go", ts: now - 2 * DAY },
        { text: "run the full test suite", ts: now - 2 * DAY },
        { text: "run the full test suite", ts: now - 3 * DAY },
      ],
      now,
    );
    const texts = frequent.map((f) => f.text);
    expect(texts).toContain("run the full test suite");
    expect(texts).not.toContain("continue");
    expect(texts).not.toContain("go");
  });

  test("recent list is newest-first and distinct", () => {
    const { recent } = rankInputs(
      [
        { text: "first", ts: now - 3 * DAY },
        { text: "second", ts: now - 2 * DAY },
        { text: "second", ts: now - 1 * DAY },
      ],
      now,
    );
    expect(recent).toEqual(["second", "first"]);
  });

  test("phrases are mined from the same rows", () => {
    const { phrases } = rankInputs(
      [
        { text: "verify with screenshots before you finish", ts: now - 1 * DAY },
        { text: "always verify with screenshots after ui work", ts: now - 2 * DAY },
        { text: "and verify with screenshots at the end", ts: now - 3 * DAY },
      ],
      now,
    );
    expect(phrases.some((p) => p.text.includes("verify with screenshots"))).toBe(true);
  });
});

describe("sanitizeSuggestions", () => {
  test("accepts strings and {text} objects, capped at 3", () => {
    expect(
      sanitizeSuggestions(["alpha one", { text: "beta two" }, "gamma three", "delta four"], null),
    ).toEqual(["alpha one", "beta two", "gamma three"]);
  });

  test("drops refusal prose, dupes, quotes, and the last user message", () => {
    expect(
      sanitizeSuggestions(
        ['"deploy the fix"', "Deploy the fix", "I cannot predict this", "run tests now", "commit it all"],
        "run tests now",
      ),
    ).toEqual(["deploy the fix", "commit it all"]);
  });

  test("drops bare continuation nudges", () => {
    expect(
      sanitizeSuggestions(["continue", "go ahead", "Do it!", "lgtm", "deploy and verify the fix"], null),
    ).toEqual(["deploy and verify the fix"]);
  });

  test("non-array input yields no suggestions", () => {
    expect(sanitizeSuggestions({ suggestions: ["x"] }, null)).toEqual([]);
    expect(sanitizeSuggestions("proceed", null)).toEqual([]);
  });

  test("over-long pills are dropped", () => {
    expect(sanitizeSuggestions(["x".repeat(121)], null)).toEqual([]);
  });
});
