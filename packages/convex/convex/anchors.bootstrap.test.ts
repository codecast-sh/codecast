import { describe, expect, test } from "bun:test";
import { bootstrapMessage } from "./anchors";
import { isBootstrapPrompt } from "@codecast/shared/contracts";

// A role's opening message (org-roles-standing.md T1): who it is and whom it
// reports to, what it owns, how it wakes, that its sessions stay out of the
// person's inbox, and that its brief is its memory, in about 200 plain words.
const opening = (startsOnItsOwn: boolean) => bootstrapMessage({
  name: "Calling", scopeType: "team", scopeLabel: "the Union workspace", teamName: "Union",
  role: { handle: "calling", scopeNames: ["project Callers & Call Management"], parentName: "Chief of Staff (@chief-of-staff)", startsOnItsOwn },
});

describe("a role's opening message", () => {
  test("says who it is, whom it reports to, what it owns, how it wakes, how it passes a request up and where it remembers", () => {
    const m = opening(true);
    expect(m.startsWith("You are **Calling**, the standing agent for the **Calling** role (@calling) in Union. You report to Chief of Staff (@chief-of-staff).")).toBe(true);
    expect(m).toContain("You own project Callers & Call Management");
    expect(m).toContain("Start every turn with `cast brief`");
    expect(m).toContain("stay out of the person's inbox");
    expect(m).not.toContain("cast escalate");
    expect(m).toContain("What you cannot answer goes up");
    expect(m).toContain("Your brief is your memory between turns");
    expect(m).toContain("`## Where it stands`");
    expect(m).toContain("`cast spawn`");
    expect(opening(false)).toContain("You do not start work on your own");
    expect(m.split(/\s+/).length).toBeLessThan(260);
    expect(isBootstrapPrompt(m)).toBe(true);
  });

  test("the chief of staff's is the right hand's, which the inbox still knows as the seat's", () => {
    const m = bootstrapMessage({ name: "Chief of Staff", scopeType: "team", scopeLabel: "the Union workspace", teamName: "Union", role: { handle: "chief-of-staff", scopeNames: [], parentName: "Ashot", startsOnItsOwn: false } });
    expect(m.startsWith("You are the Chief of Staff for Union. You report to Ashot, as their right hand")).toBe(true);
    expect(m).toContain("keep Ashot's goals in view");
    // The review is one of its jobs, run by its routine, not its opening.
    expect(m).not.toContain("## Talk it through");
    expect(m.endsWith("Read `cast brief` now.")).toBe(true);
    expect(m.split(/\s+/).length).toBeLessThan(260);
    expect(isBootstrapPrompt(m)).toBe(true);
  });
});
