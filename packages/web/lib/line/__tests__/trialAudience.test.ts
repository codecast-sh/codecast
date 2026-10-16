import { describe, expect, test } from "bun:test";
import { trialCardIsFor } from "../trialAudience";

describe("who a trial card waits on", () => {
  test("a judge fix a role owns waits only on the people it is asked of", () => {
    const card = { audience: { asked: ["lead-person"] } };
    expect(trialCardIsFor(card, "lead-person")).toBe(true);
    expect(trialCardIsFor(card, "trial-owner")).toBe(false);
    expect(trialCardIsFor(card, null)).toBe(false);
  });

  test("a practice card no role owns is listed as before", () => {
    expect(trialCardIsFor({ audience: null }, "someone")).toBe(true);
    expect(trialCardIsFor({}, null)).toBe(true);
  });
});
