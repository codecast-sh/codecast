import { describe, expect, test } from "bun:test";
import { rankInputs, sanitizeSuggestions } from "./composerSuggestions";

const DAY = 24 * 60 * 60 * 1000;

describe("rankInputs", () => {
  const now = 100 * DAY;

  test("counts case-insensitive repeats and keeps the newest casing", () => {
    const { frequent } = rankInputs(
      [
        { text: "Proceed", ts: now - 10 * DAY },
        { text: "proceed", ts: now - 1 * DAY },
        { text: "run the tests", ts: now - 2 * DAY },
        { text: "run the tests", ts: now - 3 * DAY },
        { text: "one-off message", ts: now - 1 * DAY },
      ],
      now,
    );
    const texts = frequent.map((f) => f.text);
    expect(texts).toContain("proceed");
    expect(texts).toContain("run the tests");
    // Singletons are style evidence (recent), not habits (frequent).
    expect(texts).not.toContain("one-off message");
  });

  test("recency boosts break count ties toward what's current", () => {
    const { frequent } = rankInputs(
      [
        { text: "old habit", ts: now - 30 * DAY },
        { text: "old habit", ts: now - 29 * DAY },
        { text: "new habit", ts: now - 1 * DAY },
        { text: "new habit", ts: now - 2 * DAY },
      ],
      now,
    );
    expect(frequent[0].text).toBe("new habit");
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
});

describe("sanitizeSuggestions", () => {
  test("accepts strings and {text} objects, capped at 3", () => {
    expect(
      sanitizeSuggestions(["a", { text: "b" }, "c", "d"], null),
    ).toEqual(["a", "b", "c"]);
  });

  test("drops refusal prose, dupes, quotes, and the last user message", () => {
    expect(
      sanitizeSuggestions(
        ['"proceed"', "Proceed", "I cannot predict this", "run tests", "commit it"],
        "run tests",
      ),
    ).toEqual(["proceed", "commit it"]);
  });

  test("non-array input yields no suggestions", () => {
    expect(sanitizeSuggestions({ suggestions: ["x"] }, null)).toEqual([]);
    expect(sanitizeSuggestions("proceed", null)).toEqual([]);
  });

  test("over-long pills are dropped", () => {
    expect(sanitizeSuggestions(["x".repeat(121)], null)).toEqual([]);
  });
});
