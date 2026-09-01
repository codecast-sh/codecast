import { describe, expect, test } from "bun:test";
import {
  minePhrases,
  normalizeForMatch,
  parseMinedProfile,
  rankInputs,
  sanitizeSuggestions,
} from "./composerSuggestions";

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
  test("legacy strings and {text} objects pass, capped at 2 by default", () => {
    expect(
      sanitizeSuggestions(["alpha one", { text: "beta two" }, "gamma three", "delta four"], null),
    ).toEqual(["alpha one", "beta two"]);
  });

  test("confidence gates: <0.7 dropped, third pill needs >=0.85", () => {
    expect(
      sanitizeSuggestions(
        [
          { text: "low ball guess", confidence: 0.5 },
          { text: "solid answer", confidence: 0.9 },
          { text: "decent answer", confidence: 0.75 },
        ],
        null,
      ),
    ).toEqual(["solid answer", "decent answer"]);
    expect(
      sanitizeSuggestions(
        [
          { text: "option a", confidence: 0.95 },
          { text: "option b", confidence: 0.9 },
          { text: "option c", confidence: 0.88 },
        ],
        null,
      ),
    ).toEqual(["option a", "option b", "option c"]);
    expect(
      sanitizeSuggestions(
        [
          { text: "option a", confidence: 0.95 },
          { text: "option b", confidence: 0.9 },
          { text: "option c", confidence: 0.8 },
        ],
        null,
      ),
    ).toEqual(["option a", "option b"]);
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

  test("replayed historical messages are dropped, applied habits survive", () => {
    const banned = new Set(
      ["think of 5 ways this feature can be better", "you need to test this more thoroughly"].map(normalizeForMatch),
    );
    expect(
      sanitizeSuggestions(
        [
          { text: "Think of 5 ways this feature can be better.", confidence: 0.9 },
          { text: "think of 5 ways the pill row could be better", confidence: 0.85 },
          { text: "you need to test this more thoroughly", confidence: 0.9 },
        ],
        null,
        banned,
      ),
    ).toEqual(["think of 5 ways the pill row could be better"]);
  });

  test("non-array input yields no suggestions", () => {
    expect(sanitizeSuggestions({ suggestions: ["x"] }, null)).toEqual([]);
    expect(sanitizeSuggestions("proceed", null)).toEqual([]);
  });

  test("a full reusable prompt survives; only a pasted wall is dropped", () => {
    const longPrompt =
      "you are a world class product engineer and designer, you push the final mile to polish a product to incredible detail and thoughtfulness. when you think you are done and its perfect, do another 10 rounds of iteration to improve it. do work that you are extremely proud of. I believe in you.";
    expect(sanitizeSuggestions([{ text: longPrompt, confidence: 0.9 }], null)).toEqual([longPrompt]);
    expect(sanitizeSuggestions(["x".repeat(1001)], null)).toEqual([]);
  });

  test("a reusable prompt removed from the ban set comes back as a pill", () => {
    const reusable = "plan, and task this out deeply, bind to it and then run a deep workflow against it";
    const banned = new Set([reusable, "fix the linkedin urls in team.ts"].map(normalizeForMatch));
    // The action deletes mined prompts from the ban set before sanitizing.
    banned.delete(normalizeForMatch(reusable));
    expect(
      sanitizeSuggestions(
        [
          { text: reusable, confidence: 0.9 },
          { text: "fix the linkedin urls in team.ts", confidence: 0.9 },
        ],
        null,
        banned,
      ),
    ).toEqual([reusable]);
  });
});

describe("parseMinedProfile", () => {
  test("reads patterns and full-text prompts, dropping under-supported and nudge entries", () => {
    const mined = parseMinedProfile({
      patterns: [
        { pattern: "demands e2e verification before accepting work", example: "verify it e2e first", count: 4 },
        { pattern: "one-off", example: "whatever", count: 1 },
        { pattern: "nudge habit", example: "continue", count: 9 },
      ],
      prompts: [
        { text: "build all of the above and then find 10 ways it can be clearer, fix those 10, validate, and repeat 5 times", count: 3 },
        { text: "go ahead", count: 6 },
        { text: "ship it now", count: 2 },
      ],
    });
    expect(mined?.patterns.map((p) => p.pattern)).toEqual([
      "demands e2e verification before accepting work",
    ]);
    expect(mined?.prompts.map((p) => p.count)).toEqual([3]);
    expect(mined?.prompts[0].text.startsWith("build all of the above")).toBe(true);
  });

  test("legacy bare-array output reads as patterns only", () => {
    const mined = parseMinedProfile([
      { pattern: "asks for a polished summary page", example: "publish a full page", count: 2 },
    ]);
    expect(mined?.patterns.length).toBe(1);
    expect(mined?.prompts).toEqual([]);
  });

  test("garbage yields null", () => {
    expect(parseMinedProfile("nope")).toBeNull();
    expect(parseMinedProfile({ patterns: [], prompts: [] })).toBeNull();
  });
});
