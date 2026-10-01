import { describe, expect, test } from "bun:test";
import { groundUpdateBody, renderGoalsBrief, type GoalsBrief } from "./goalsBrief";

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

A goal_ref is a metric ref (\`in-N:key\`), a project's short id, or \`none\`.

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
`);
  });

  test("--brief drops descriptions; principles lose their own title", () => {
    const out = renderGoalsBrief(brief, { now: NOW, brief: true, principles: "# Principles\n\nLocal first.\n" });
    expect(out).not.toContain("keep using it");
    expect(out.endsWith("## Principles\n\nLocal first.\n")).toBe(true);
  });

  test("an empty workspace says so in one line", () => {
    expect(renderGoalsBrief({ workspace: "user:u", initiatives: [], projects: [] })).toBe("# Goals\n\nNo active initiatives and no project charters in this workspace.\n");
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
