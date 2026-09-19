import { describe, expect, test } from "bun:test";
import { goalSectionMatchesPerson, parseGoalLine, parseGoalSections } from "./roleGoals";

// Goals in a role's brief (org-roles-run-work.md R6): one section per person,
// one goal per line, the priority in parentheses, the matches as short ids.

describe("parseGoalSections", () => {
  test("reads sections per person, priorities and the refs on each line", () => {
    const brief = [
      "Growth is steady",
      "Status: working",
      "",
      "## Goals: Ashot",
      "1. Ship the org feature by October (high) — ct-52526, pl-711, jx7csbd",
      "2. Close the fundraising deck",
      "- Hire a designer (low) jx7abcde",
      "",
      "## Goals for Samvit",
      "1. Land the matching rewrite (HIGH): ct-100",
      "",
      "## Pitfalls",
      "1. Not a goal",
    ].join("\n");
    const sections = parseGoalSections(brief);
    expect(sections.map((s) => s.person)).toEqual(["Ashot", "Samvit"]);
    expect(sections[0].goals).toHaveLength(3);
    expect(sections[0].goals[0]).toMatchObject({ text: "Ship the org feature by October", priority: "high", refs: { sessions: ["jx7csbd"], tasks: ["ct-52526"], plans: ["pl-711"] } });
    expect(sections[0].goals[1]).toMatchObject({ text: "Close the fundraising deck", priority: null, refs: { sessions: [], tasks: [], plans: [] } });
    expect(sections[0].goals[2]).toMatchObject({ text: "Hire a designer", priority: "low", refs: { sessions: ["jx7abcde"] } });
    expect(sections[1].goals[0]).toMatchObject({ text: "Land the matching rewrite", priority: "high", refs: { tasks: ["ct-100"] } });
  });

  test("a brief with no goal section has no goals, and a heading closes a section", () => {
    expect(parseGoalSections("Growth is steady\n\n## Decisions\n1. UTM is newsletter")).toEqual([]);
    expect(parseGoalSections("## Goals: Me\n1. A\n## Other\n1. B")[0].goals.map((g) => g.text)).toEqual(["A"]);
  });

  test("a line that is only refs is not a goal", () => {
    expect(parseGoalLine("- ct-1, pl-2")).toBeNull();
    expect(parseGoalLine("prose without a bullet")).toBeNull();
  });
});

describe("goalSectionMatchesPerson", () => {
  test("first name, full name and email local part all name the same person", () => {
    const ashot = { name: "Ashot Petrosian", email: "ashot@x.ai" };
    expect(goalSectionMatchesPerson("Ashot", ashot)).toBe(true);
    expect(goalSectionMatchesPerson("ashot petrosian", ashot)).toBe(true);
    expect(goalSectionMatchesPerson("ashot@x.ai", ashot)).toBe(true);
    expect(goalSectionMatchesPerson("Samvit", ashot)).toBe(false);
    expect(goalSectionMatchesPerson("", ashot)).toBe(false);
  });
});
