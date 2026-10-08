import { describe, expect, test } from "bun:test";
import { briefGoalRefs, compactPrinciples, goalRefLabel, groundUpdateBody, renderGoalsBrief, type GoalsBrief } from "./goalsBrief";

const NOW = Date.UTC(2026, 9, 2, 12);
const DAY = 86_400_000;

const brief: GoalsBrief = {
  workspace: "team:t1",
  workspace_name: "Codecast",
  initiatives: [
    {
      short_id: "in-12", title: "Retention", priority: "p1", owner: "@growth", health: "at_risk",
      description: "Teams that try it\nkeep using it.",
      metrics: [{ key: "week4_retention", name: "Week 4 retention", target: "40%" }],
      scoreboard: { week4_retention: { value: "31%", observed_at: NOW - 3 * DAY, source: "posthog" } },
      project_short_ids: ["pj-b"],
    },
    {
      short_id: "in-2", title: "Activation", priority: "p0", health: "none",
      metrics: [{ key: "first_session", name: "First session in 10 min", target: "80%" }],
      project_short_ids: [],
    },
  ],
  projects: [
    { short_id: "pj-b", title: "Onboarding", status: "active", priority: "p1", owner_role: "@growth", goal: "A new team runs an agent on day one", success_metrics: ["day 1 agent run 70%"], non_goals: ["billing"], risks: [] },
    { short_id: "pj-a", title: "Sync", status: "planning", goal: "No lost writes" },
  ],
};

describe("renderGoalsBrief", () => {
  test("prints initiatives by priority with metric refs, then project charters", () => {
    expect(renderGoalsBrief(brief, { now: NOW })).toBe(`# Goals of Codecast

A goal_ref is a metric ref (\`in-N:key\`), a project's short id, \`line\`, or \`none\`.

## Initiatives

### in-2 Activation (p0)
- \`in-2:first_session\` First session in 10 min: not reported yet, target 80%

### in-12 Retention (p1, owner @growth, at risk)
Teams that try it keep using it.
- \`in-12:week4_retention\` Week 4 retention: 31% of 40%, behind (3 days ago), from posthog
- projects: pj-b

## Projects

### pj-b Onboarding (p1, owner @growth, active)
- goal: A new team runs an agent on day one
- success: day 1 agent run 70%
- non-goals: billing

### pj-a Sync (planning)
- goal: No lost writes

## The line

- \`line\` the line doing its job: fewer expectation breaks a day, most new signals joining a cause it already knows, the fixes it ships holding, and every station working. Only a change to the line itself serves it.
`);
  });

  test("--brief drops descriptions; principles lose their own title", () => {
    const out = renderGoalsBrief(brief, { now: NOW, brief: true, principles: "# Principles\n\nLocal first.\n" });
    expect(out).not.toContain("keep using it");
    expect(out.endsWith("## Principles\n\nLocal first.\n")).toBe(true);
  });

  test("principles over the cap render as ids and titles, whole principles only", () => {
    const area = (name: string, n: number) =>
      `## ${name}\n\n` + Array.from({ length: n }, (_, i) => `### PR-${name.toLowerCase()}-${i + 1} Title ${i + 1}\n\n${"Body text. ".repeat(60)}\n\nWhy: because.\n`).join("\n");
    const file = `# Principles\n\nIntro.\n\n${area("Code", 3)}\n${area("Design", 2)}`;
    const out = renderGoalsBrief(brief, { now: NOW, brief: true, principles: file });
    expect(out).toContain("## Principles\n\n- Code: PR-code-1 Title 1; PR-code-2 Title 2; PR-code-3 Title 3\n- Design: PR-design-1 Title 1; PR-design-2 Title 2\n\nFull text: docs/principles.md.\n");
    expect(out).not.toContain("Body text");
  });

  test("a compact form still over the cap drops whole principles and counts them", () => {
    const body = "## Code\n\n### PR-code-1 First\n\n### PR-code-2 Second\n\n### PR-code-3 Third";
    expect(compactPrinciples(body, 70)).toBe("- Code: PR-code-1 First\n\nFull text: docs/principles.md (2 more).");
  });

  test("a compact form names every file the principles came from", () => {
    const body = "## Code\n\n### PR-code-1 First\n\n## Store\n\n### CC-store-1 Second";
    expect(compactPrinciples(body, 200, ["https://x/principles.md", "docs/line/principles.md"])).toBe(
      "- Code: PR-code-1 First\n- Store: CC-store-1 Second\n\nFull text: https://x/principles.md, docs/line/principles.md.",
    );
  });

  test("an empty workspace says so in one line, and still offers the line's own goal", () => {
    const out = renderGoalsBrief({ workspace: "user:u", initiatives: [], projects: [] });
    expect(out).toStartWith("# Goals\n\nNo active initiatives and no project charters in this workspace.\n");
    expect(out).toContain("\n- `line` the line doing its job");
  });

  test("one project's brief names the project before the workspace", () => {
    const out = renderGoalsBrief({ workspace: "team:t", workspace_name: "Union", project_title: "Agent Quality", initiatives: [], projects: [] });
    expect(out).toStartWith("# Goals of Agent Quality (Union)\n");
    expect(out).toContain("This project has no charter and no active initiative carries it.");
  });

  test("the order is stable whatever order the rows arrive in", () => {
    const reversed = { ...brief, initiatives: [...brief.initiatives].reverse(), projects: [...brief.projects].reverse() };
    expect(renderGoalsBrief(reversed, { now: NOW })).toBe(renderGoalsBrief(brief, { now: NOW }));
  });
});

describe("groundUpdateBody", () => {
  test("maps the flags to the wire fields, normalizing case and dashes", () => {
    expect(groundUpdateBody({ goalRef: " in-12:week4_retention ", category: "Prompt", risk: "plan", readiness: "needs-context", readinessNote: " no repro yet " }))
      .toEqual({ goal_ref: "in-12:week4_retention", category: "prompt", risk: "plan", readiness: "needs_context", readiness_note: "no repro yet" });
  });

  test("empty strings clear, absent flags stay out", () => {
    expect(groundUpdateBody({ category: "", goalRef: "" })).toEqual({ category: "", goal_ref: "" });
    expect(groundUpdateBody({})).toEqual({});
  });

  test("a bad value names the flag and its choices", () => {
    expect(() => groundUpdateBody({ risk: "high" })).toThrow('--risk must be one of low, review, plan (or "" to clear)');
    expect(() => groundUpdateBody({ category: "docs" })).toThrow("--category must be one of code, prompt, ux, infra, data");
  });
});

describe("goalRefLabel", () => {
  test("names a project ref by its title and charter goal, a metric ref by its initiative and metric, and nothing else", () => {
    expect(goalRefLabel(brief, "pj-b")).toEqual({ name: "Onboarding", why: "A new team runs an agent on day one" });
    expect(goalRefLabel(brief, "in-12:week4_retention")).toEqual({ name: "Retention: Week 4 retention", why: "target 40%" });
    expect(goalRefLabel(brief, "none")).toBeNull();
    // A change to the line itself serves the line's own health (LM8), which every brief offers.
    expect(goalRefLabel(brief, "line")?.name).toBe("The line");
    expect(briefGoalRefs(brief).has("line")).toBe(true);
    expect(goalRefLabel(brief, "pj-zz")).toBeNull();
  });
});
