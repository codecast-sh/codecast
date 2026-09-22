import { describe, expect, test } from "bun:test";
import { computeCoverage, type CoverageInputs } from "./orgCoverage";

// Coverage (docs/architecture/initiatives-projects-role-page.md I1, I2): pure
// over rows, so the before count the analyzer states, the work outside any
// project and the initiative's own gaps are asserted with plain fixtures.

const role = (id: string, handle: string, project_ids: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ _id: id, handle, status: "active", scope: { project_ids, plan_ids: [] }, reports_to: { kind: "user" }, ...extra });

const base = (over: Partial<CoverageInputs> = {}): CoverageInputs => ({
  projects: [
    { _id: "p_growth", short_id: "pj-1", title: "Growth", status: "active" },
    { _id: "p_platform", short_id: "pj-2", title: "Platform", status: "active", owner_role_id: "r_platform" },
    { _id: "p_brand", short_id: "pj-3", title: "Brand", status: "active" },
    { _id: "p_idle", short_id: "pj-4", title: "Nothing open", status: "active" },
    { _id: "p_paused", short_id: "pj-5", title: "Paused", status: "paused" },
  ],
  plans: [
    { _id: "pl_a", short_id: "pl-1", title: "Pricing page", status: "active", project_id: "p_brand" },
    { _id: "pl_loose", short_id: "pl-2", title: "Loose plan", status: "active" },
    { _id: "pl_idea", short_id: "pl-3", title: "An idea with no tasks", status: "draft" },
    { _id: "pl_closed", short_id: "pl-4", title: "Closed and loose", status: "done" },
  ],
  tasks: [
    { status: "open", project_id: "p_growth", source: "human" },
    { status: "in_progress", project_id: "p_platform", source: "human" },
    { status: "done", project_id: "p_idle", source: "human" },
    { status: "open", project_id: "p_paused", source: "human" },
    { status: "open", plan_id: "pl_loose", source: "meeting" },
    { status: "open", plan_id: "pl_closed", source: "human" },
    { status: "open", source: "human" },
    { status: "dropped", source: "human" },
    // Off the board (isOnProjectBoard): an agent's own task, its suggestion,
    // an unpromoted insight, a dismissed row. None is work to cover, on a
    // project, a plan or loose, so the counts here match the page's.
    { status: "open", project_id: "p_growth", source: "agent" },
    { status: "open", project_id: "p_growth", source: "agent", triage_status: "suggested" },
    { status: "open", project_id: "p_idle", source: "insight" },
    { status: "open", plan_id: "pl_loose", source: "agent", triage_status: "dismissed" },
    { status: "open", source: "agent" },
    // On the board although an agent filed them: promoted, or assigned to someone.
    { status: "open", project_id: "p_platform", source: "agent", promoted: true },
    { status: "open", project_id: "p_platform", source: "agent", assignee: "u_ada" },
  ],
  roles: [role("r_platform", "platform"), role("r_a", "design", ["p_brand"]), role("r_b", "marketing", ["p_brand"]), role("r_root", "chief-of-staff")],
  areas: [
    { repository: "acme/app", path_prefix: "packages/web", commits_30d: 40, authors: [], sessions_30d: 12, project_id: "p_platform" },
    { repository: "acme/tools", path_prefix: "", commits_30d: 9, authors: [], sessions_30d: 3 },
    { repository: "acme/old", path_prefix: "", commits_30d: 0, authors: [], sessions_30d: 0 },
  ],
  initiatives: [],
  ...over,
});

describe("coverage", () => {
  test("counts the active projects with work and names each lead by the one rule", () => {
    const c = computeCoverage(base());
    // An open task or an open plan is work; a project with neither, or a paused one, is not a seat to fill.
    expect(c.projects.map((p) => p.title)).toEqual(["Growth", "Platform", "Brand"]);
    expect([c.with_lead, c.with_work]).toEqual([1, 3]);
    // The counts are the board's: Growth's agent rows do not count, and
    // Platform's promoted and assigned ones do.
    expect(c.projects[0]).toMatchObject({ open_tasks: 1, open_plans: 0, initiatives: [] });
    expect(c.projects[0].lead).toBeUndefined();
    expect(c.projects[1]).toMatchObject({ lead: "@platform", lead_by: "owner", open_tasks: 3 });
    // Two roles on separate lines list Brand and it names neither: watched, not led.
    expect(c.projects[2]).toMatchObject({ watchers: ["@design", "@marketing"], open_plans: 1 });
    expect(c.projects[2].lead).toBeUndefined();
  });

  test("a paused lead is not a lead: the project counts as without one and names the paused role", () => {
    const c = computeCoverage(base({ roles: [role("r_platform", "platform", [], { status: "paused" }), role("r_root", "chief-of-staff")] }));
    expect([c.with_lead, c.with_lead_paused, c.with_work]).toEqual([0, 1, 3]);
    expect(c.projects[1]).toMatchObject({ lead_paused: "@platform", lead_by: "owner" });
    expect(c.projects[1].lead).toBeUndefined();
  });

  test("a whole workspace role covers nothing, so a chief of staff never hides an uncovered project", () => {
    const c = computeCoverage(base({ roles: [role("r_root", "chief-of-staff")] }));
    expect([c.with_lead, c.with_work]).toEqual([0, 3]);
  });

  test("lists the work outside any project: open plans with none, loose tasks, areas that resolved to none", () => {
    const { outside } = computeCoverage(base());
    // A plan with no tasks is an idea, and a closed plan is history: neither is work to cover.
    expect(outside.plans).toEqual([{ short_id: "pl-2", title: "Loose plan", open_tasks: 1 }]);
    expect(outside.open_tasks).toBe(1);
    expect(outside.areas).toEqual([{ repository: "acme/tools", path_prefix: "", commits_30d: 9, sessions_30d: 3 }]);
  });

  test("reads an initiative from the top down: its owner, its health, and which of its projects have no lead", () => {
    const c = computeCoverage(base({
      userNames: { u_ada: "Ada" },
      initiatives: [
        { _id: "i_done", short_id: "in-1", title: "Shipped", status: "completed", health: "on_track", project_ids: ["p_growth"] },
        { _id: "i_plan", short_id: "in-2", title: "Next year", status: "planned", health: "none", owner: { kind: "user", user_id: "u_ada" }, project_ids: [] },
        { _id: "i_launch", short_id: "in-3", title: "Launch", status: "active", health: "at_risk", health_at: 5, target_date: 9, project_ids: ["p_growth", "p_platform", "p_idle", "p_gone"], parent_initiative_id: "i_plan" },
        { _id: "i_retired", short_id: "in-4", title: "Owned by a retired role", status: "active", health: "none", owner: { kind: "role", role_id: "r_old" }, project_ids: [] },
        { _id: "i_led", short_id: "in-5", title: "Driven", status: "active", health: "on_track", owner: { kind: "role", role_id: "r_platform" }, project_ids: ["p_platform"] },
      ],
      roles: [...base().roles, role("r_old", "old", [], { status: "retired" })],
    }));
    // Closed initiatives are left out; active ones come first.
    expect(c.initiatives.map((i) => i.short_id)).toEqual(["in-3", "in-4", "in-5", "in-2"]);
    expect([c.active_initiatives, c.active_without_owner]).toEqual([3, 2]);
    const launch = c.initiatives[0];
    expect(launch).toMatchObject({ health: "at_risk", health_at: 5, target_date: 9, parent: "in-2", projects_without_lead: 1 });
    expect(launch.owner).toBeUndefined();
    // A project the viewer cannot read is dropped; one with no work is listed and asks for no lead.
    expect(launch.projects.map((p) => [p.title, p.has_work, p.lead])).toEqual([["Growth", true, undefined], ["Platform", true, "@platform"], ["Nothing open", false, undefined]]);
    expect(c.initiatives[1].owner).toBeUndefined();
    expect(c.initiatives[2].owner).toEqual({ kind: "role", handle: "@platform" });
    expect(c.initiatives[3].owner).toEqual({ kind: "user", name: "Ada" });
    // A project says which open initiatives it serves, and never a closed one.
    expect(c.projects.find((p) => p.title === "Growth")!.initiatives).toEqual(["in-3"]);
    expect(c.projects.find((p) => p.title === "Platform")!.initiatives).toEqual(["in-3", "in-5"]);
  });
});
