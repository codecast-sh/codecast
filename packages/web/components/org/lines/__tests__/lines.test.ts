// The lines' pure parts (cohesive build spec §6): a project's line facts
// counted by the board's rule, the lead a line names, the words a role and a
// person line say, and the grid's breakpoints as the stylesheet writes them
// (the browser check measures them; this keeps the numbers from drifting).
// Run: cd packages/web && bun test components/org/lines
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_FIXTURE_PROJECTS, COMPANY_FIXTURE_TASKS, COMPANY_FIXTURE_TREE } from "../../../company/companyFixture";
import { rolesInTreeOrder } from "../../staffingModel";
import { lineProjectOf, namedLead } from "../lineData";

const roles = rolesInTreeOrder(COMPANY_FIXTURE_TREE);
const ctx = { tree: COMPANY_FIXTURE_TREE, roles, tasks: COMPANY_FIXTURE_TASKS };
const project = (short: string) => COMPANY_FIXTURE_PROJECTS.find((p) => p.short_id === short)!;

describe("a project's line facts", () => {
  test("the board's count, what is moving under it, its lead, its colour and target", () => {
    expect(lineProjectOf(project("pr-6"), ctx)).toMatchObject({ id: "union-proj-network", short_id: "pr-6", status: "active", color: "blue", counts: { open: 9, done: 12 }, sessions: null, lead: null });
    const quality = lineProjectOf(project("pr-12"), ctx);
    expect(quality.lead?.handle).toBe("agent-quality");
    expect(quality.sessions).toMatchObject({ working: 2, needs_input: 1 });
  });

  test("no tasks is no count; a filling cache says it is counting", () => {
    expect(lineProjectOf(project("pr-4"), ctx).counts).toBeNull();
    expect(lineProjectOf(project("pr-6"), { ...ctx, tasksCounted: false }).counts).toBe("counting");
  });

  test("without the tree nothing is moving and nobody leads", () => {
    expect(lineProjectOf(project("pr-12"), { tree: null, roles: [], tasks: [] })).toMatchObject({ sessions: null, lead: null, counts: null });
  });

  test("a role that covers the whole workspace is nobody's named lead", () => {
    const everything = { ...roles[0], scope: { project_ids: [], plan_ids: [] } };
    expect(namedLead(project("pr-6"), [everything])).toBeNull();
    expect(namedLead(project("pr-12"), roles)?.handle).toBe("agent-quality");
  });
});

describe("the words a line says", () => {
  test("a role carries what it leads, else the goal it owns, else its charter", async () => {
    const { roleCarries } = await import("../lineFacts");
    expect(roleCarries({ leads: [{ title: "Calling program" }], goals: [], charter: "x" })).toBe("leads Calling program");
    expect(roleCarries({ leads: [{ title: "A" }, { title: "B" }, { title: "C" }], goals: [] })).toBe("leads A +2");
    expect(roleCarries({ leads: [], goals: [{ title: "Win the network" }] })).toBe("owns Win the network");
    expect(roleCarries({ leads: [], goals: [], charter: "Reads every call." })).toBe("Reads every call.");
    expect(roleCarries({ leads: [], goals: [], charter: "  " })).toBeNull();
  });

  test("a person carries their goals, roles and live sessions; since names the month, and the year when it is not this one", async () => {
    const { personCarries, sinceWord } = await import("../lineFacts");
    // Only live sessions count, in the words Now uses; finished ones say nothing about now.
    expect(personCarries({ goals: [1], roles: [1, 2], sessions: { working: 2, needs_input: 1, done: 40, dormant: 3, idle: 0 } })).toBe("1 goal · 2 roles · 2 sessions at work, 1 waiting on input");
    expect(personCarries({ goals: [1], roles: [1, 2], sessions: { working: 0, needs_input: 0, done: 140, dormant: 0, idle: 0 } })).toBe("1 goal · 2 roles");
    // Beside a Serves and a Carries that name them, only what is live is left.
    expect(personCarries({ goals: [1], roles: [1, 2], sessions: { working: 2, needs_input: 0, done: 9, dormant: 0, idle: 0 } }, { named: true })).toBe("2 sessions at work");
    expect(personCarries({ goals: [1], roles: [1], sessions: null }, { named: true })).toBeNull();
    expect(personCarries({ goals: [1], roles: [1, 2], sessions: null }, { rolesShown: true })).toBe("1 goal");
    expect(personCarries({ goals: [], roles: [], sessions: null })).toBeNull();
    const now = Date.UTC(2026, 9, 7, 12);
    expect(sinceWord(Date.UTC(2026, 5, 3, 12), now)).toBe("since Jun");
    expect(sinceWord(Date.UTC(2025, 10, 3, 12), now)).toBe("since Nov 2025");
  });
});

describe("the grid", () => {
  const css = readFileSync(join(import.meta.dir, "..", "lines.css"), "utf8");
  test("answers to its container, never the window", () => {
    expect(css).toMatch(/\.ol-scope \{ container: ol \/ inline-size; \}/);
    expect(css).not.toMatch(/@media \((min|max)-width/);
  });
  test("seven columns from 860px, five below it with the owner as a face, four under 640px with the measure gone too", () => {
    expect(css).toMatch(/grid-template-columns: calc\(14px \+ var\(--ol-indent\)\) 20px minmax\(170px, 1fr\) 116px 172px;\s*grid-template-areas: "chev glyph title state measure";/);
    expect(css).toMatch(/\.ol-owner \{ grid-area: owner; display: none; \}/);
    expect(css).toMatch(/@container ol \(min-width: 860px\) \{[^}]*\}[\s\S]*?\.ol-owner \{ display: flex; \}\s*\.ol-face \{ display: none; \}\s*\.ol-answer-words \{ display: inline; \}/);
    expect(css).toMatch(/@container ol \(min-width: 860px\) \{\s*\.ol-line \{\s*grid-template-columns: calc\(14px \+ var\(--ol-indent\)\) 20px minmax\(0, 1fr\) 140px 124px 184px 64px;/);
    expect(css).toMatch(/\.ol-date \{ grid-area: date; display: none;/);
    expect(css).toMatch(/@container ol \(max-width: 639px\) \{[\s\S]*grid-template-columns: calc\(14px \+ var\(--ol-indent\)\) 20px minmax\(0, 1fr\) 112px;[\s\S]*\.ol-owner, \.ol-measure, \.ol-compact \.ol-owner \{ display: none; \}/);
  });
  test("the wide ghost spans never outrank the narrow grid's placement", () => {
    expect(css).not.toMatch(/:not\(\[data-owned\]\) \.ol-title/);
    expect(css).toMatch(/\.ol-line\[data-ghost\]:where\(:not\(\[data-owned\]\)\) \.ol-title/);
  });
  test("a name ends where its text ends and a short word after it stays whole", () => {
    expect(css).toMatch(/\.ol-name \{ flex: 0 1 auto; min-width: 0;/);
    expect(css).toMatch(/\.ol-sub \{ flex: 0 0 auto;/);
  });
  test("an opened body's text starts on the title column at every width", () => {
    expect(css).toMatch(/margin: 0 0 4px calc\(14px \+ 20px \+ 8px \+ var\(--ol-indent, 0px\)\);\s*padding: 6px 0 8px 13px;/);
    expect(css).not.toMatch(/\.ol-body \{ margin-left/);
  });
});
