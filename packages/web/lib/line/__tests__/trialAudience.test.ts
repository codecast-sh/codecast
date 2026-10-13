import { describe, expect, test } from "bun:test";
import { trialCardIsFor } from "../trialAudience";

const role = { _id: "or", short_id: "or-39", name: "Agent Quality lead", handle: "agent-quality" };

describe("who a trial card waits on", () => {
  test("a judge fix a role owns waits only on the people it is asked of", () => {
    const card = { decision: { asked: ["lead-person"], for_role: role } };
    expect(trialCardIsFor(card, "lead-person")).toBe(true);
    expect(trialCardIsFor(card, "trial-owner")).toBe(false);
    expect(trialCardIsFor(card, null)).toBe(false);
  });

  test("a practice card no role owns, or one no session posted, is listed as before", () => {
    expect(trialCardIsFor({ decision: { asked: ["trial-owner"], for_role: null } }, "someone")).toBe(true);
    expect(trialCardIsFor({ decision: null }, "someone")).toBe(true);
    expect(trialCardIsFor({}, null)).toBe(true);
  });
});
