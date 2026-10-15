import { describe, expect, test } from "bun:test";
import { bareVerbAnswers, trialWords } from "../fixDecision";

// A trial decision reads in the session's own words: only an answer that is a bare routing verb loses its line.
describe("trial decision answers", () => {
  const own = [
    { label: "Rework it so the email leads with what is waiting on them", description: "Three wordings opened with the call in 24 of 26 reruns." },
    { label: "Ship the rewrite as built", description: "It changes about 127 emails a week." },
    { label: "Drop the rewrite and keep today's email", description: "Replies run about one in five either way." },
  ];
  const bare = [
    { label: "Ship", description: "Recorded as approved as built; nothing merges." },
    { label: "[R] Revise", description: "Your note goes back to the builder." },
    { label: "Drop", description: "Recorded as not wanted." },
  ];

  test("answers the session wrote keep what it wrote under them", () => {
    expect(trialWords({ question: "After an unanswered call, what should the email lead with?", options: own }).options).toEqual(own);
    expect(bareVerbAnswers(own)).toBe(false);
  });

  test("bare verbs stay bare, and the fixed controls may stand in for them", () => {
    expect(trialWords({ question: "Ship this change? A headline", options: bare })).toEqual({ question: "Would you ship this? A headline", options: [{ label: "Ship" }, { label: "[R] Revise" }, { label: "Drop" }] });
    expect(bareVerbAnswers(bare)).toBe(true);
  });

  test("one answer in the session's words keeps the whole decision its own", () => {
    expect(bareVerbAnswers([bare[0], own[0], bare[2]])).toBe(false);
  });
});
