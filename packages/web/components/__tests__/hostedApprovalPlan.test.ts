import { describe, expect, test } from "bun:test";
import { planForCard } from "../conversation/HostedApprovalCard";

describe("the approval card's plan", () => {
  test("leaves out When when the summary already says the cadence", () => {
    const md = "Every weekday at 7 AM I'll remind you to take your vitamins.\n\n**When:** Weekdays at 7:00 AM, starting today";
    expect(planForCard(md)).toBe("Every weekday at 7 AM I'll remind you to take your vitamins.");
  });

  test("keeps When, unbolded, when the summary does not", () => {
    const md = "**What I'll do**\n\n> Tell me the weather\n\n**When:** Every day at 8:00 AM, starting Wednesday, October 7";
    expect(planForCard(md)).toBe("**What I'll do**\n\n> Tell me the weather\n\nWhen: Every day at 8:00 AM, starting Wednesday, October 7");
  });

  test("a plan with no When is untouched", () => {
    expect(planForCard("Send Dana the notes.")).toBe("Send Dana the notes.");
  });
});
