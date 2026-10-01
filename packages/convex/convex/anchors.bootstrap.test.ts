import { describe, expect, test } from "bun:test";
import { bootstrapMessage } from "./anchors";
import { isBootstrapPrompt } from "@codecast/shared/contracts";

// A role's opening message (org-roles-standing.md T1): who it is and whom it
// reports to, what it looks after, how it wakes, that its sessions stay out of the
// person's inbox, and that its brief is its memory, in about 200 plain words.
const opening = (startsOnItsOwn: boolean) => bootstrapMessage({
  name: "Calling", scopeType: "team", scopeLabel: "the Union workspace", teamName: "Union",
  role: { handle: "calling", scopeNames: ["project Callers & Call Management"], parentName: "Head of People (@head-of-people)", parentHandle: "head-of-people", startsOnItsOwn },
});

describe("a role's opening message", () => {
  test("says who it is, whom it reports to, what it looks after, how it wakes, how it passes a request up and where it remembers", () => {
    const m = opening(true);
    expect(m.startsWith("You are the **Calling** (@calling) in Union. You report to Head of People (@head-of-people).")).toBe(true);
    expect(m).toContain("You look after project Callers & Call Management");
    expect(m).toContain('cast role wake @head-of-people "<what they will decide and why>"');
    expect(m).toContain("Start every turn with `cast brief`");
    expect(m).toContain("stay out of the person's inbox");
    expect(m).not.toContain("cast escalate");
    expect(m).toContain("What you cannot answer goes up");
    expect(m).toContain("Your brief is your memory between turns");
    expect(m).toContain("`## Where it stands`");
    expect(m).toContain("a session you start under you");
    expect(opening(false)).toContain("You do not start work on your own");
    expect(m.split(/\s+/).length).toBeLessThan(260);
    expect(isBootstrapPrompt(m)).toBe(true);
  });

  // Scope is opt in (org-staffing.md S26).
  test("a role with no scope is told it looks after no area, never that the workspace is its own", () => {
    const m = bootstrapMessage({ name: "Release", scopeType: "team", scopeLabel: "the Union workspace", teamName: "Union", role: { handle: "release", scopeNames: [], parentName: "Ashot", startsOnItsOwn: true } });
    expect(m).toContain("You look after no area of your own: you run your routine and answer what you are asked.");
    expect(m).not.toMatch(/whole workspace|You own/);
    expect(m).toContain("Raise it in this thread");
    expect(isBootstrapPrompt(m)).toBe(true);
  });

  test("the head of people's is the right hand's, which the inbox still knows as the seat's", () => {
    const m = bootstrapMessage({ name: "Head of People", scopeType: "team", scopeLabel: "the Union workspace", teamName: "Union", role: { handle: "head-of-people", scopeNames: [], parentName: "Ashot", startsOnItsOwn: false } });
    expect(m.startsWith("You are the Head of People for Union. You report to Ashot, as their right hand")).toBe(true);
    expect(m).toContain("keep Ashot's goals in view");
    // The review is one of its jobs, run by its routine, not its opening.
    expect(m).not.toContain("## Talk it through");
    expect(m.endsWith("Read `cast brief` now.")).toBe(true);
    expect(m.split(/\s+/).length).toBeLessThan(260);
    expect(isBootstrapPrompt(m)).toBe(true);
  });
});
