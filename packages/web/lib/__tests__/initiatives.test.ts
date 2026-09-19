// What an initiative derives at render (initiatives-projects-role-page.md I1).
// Run: bun test lib/__tests__/initiatives.test.ts
import { test, expect } from "bun:test";
import { FIXTURE_INITIATIVES as ROWS, FIXTURE_NOW, FIXTURE_PLANS, FIXTURE_PROJECTS, FIXTURE_TASKS } from "../../components/initiatives/initiativeFixture";
import { computePlanProgress } from "../liveEntities";
import { groupInitiativesByStatus, initiativeProgress, initiativeSig, initiativesOfProject, ownerId, progressPercent, projectInitiativeIndex, projectTrouble, subInitiatives, tasksByProject, topLevelInitiatives } from "../initiatives";

const byProject = tasksByProject(FIXTURE_TASKS);
const row = (short: string) => ROWS.find((r) => r.short_id === short)!;

test("progress is tasks done over tasks in the initiative's projects, dropped left out", () => {
  // proj-org: 2 done of 4 (one dropped is not counted); proj-inbox: 1 done of 2.
  const p = initiativeProgress(row("in-1"), byProject);
  expect(p).toEqual({ total: 6, done: 3, in_progress: 1, open: 2 });
  expect(progressPercent(p)).toBe(50);
  expect(progressPercent(initiativeProgress(row("in-4"), byProject))).toBe(0);
});

test("a task's status change moves the bar with no stored twin", () => {
  const moved = FIXTURE_TASKS.map((t) => (t._id === "7" ? { ...t, status: "done" } : t));
  expect(initiativeProgress(row("in-1"), tasksByProject(moved)).done).toBe(4);
});

test("a task filed only under a plan counts under that plan's project", () => {
  const loose = [...FIXTURE_TASKS, { _id: "9", status: "done", project_id: null, plan_id: "plan-roles" }];
  expect(initiativeProgress(row("in-1"), tasksByProject(loose, FIXTURE_PLANS)).done).toBe(4);
  expect(initiativeProgress(row("in-1"), tasksByProject(loose)).done).toBe(3);
});

test("a project says its own trouble: past its target, or risks in its charter", () => {
  const counts = (id: string) => computePlanProgress(byProject.get(id));
  const trouble = (id: string) => projectTrouble(FIXTURE_PROJECTS.find((p) => p._id === id)!, { open: counts(id).total - counts(id).done, done: counts(id).done }, FIXTURE_NOW);
  expect(trouble("proj-inbox")).toBe("past its target");
  expect(trouble("proj-billing")).toBe("1 risk in its charter");
  expect(trouble("proj-org")).toBeNull();
});

test("the list groups top level rows by status, active first", () => {
  const groups = groupInitiativesByStatus(ROWS);
  expect(groups.map((g) => g.status)).toEqual(["active", "planned", "proposed", "completed"]);
  expect(groups[0].rows.map((r) => r.short_id)).toEqual(["in-1"]);
  expect(subInitiatives(ROWS, "init-org").map((r) => r.short_id)).toEqual(["in-2"]);
});

test("a sub initiative whose parent the viewer cannot see stands at the top", () => {
  const withoutParent = ROWS.filter((r) => r._id !== "init-org");
  expect(topLevelInitiatives(withoutParent).map((r) => r.short_id)).toContain("in-2");
});

test("a project in several initiatives lists them all and reads as one", () => {
  expect(initiativesOfProject(ROWS, "proj-inbox").map((r) => r.short_id)).toEqual(["in-1", "in-3"]);
  const index = projectInitiativeIndex(ROWS);
  expect(index.get("proj-inbox")?.short_id).toBe("in-1");
  expect(index.get("proj-billing")?.short_id).toBe("in-3");
  expect(index.has("proj-none")).toBe(false);
});

test("the owner id is the role's or the person's, and absent when nobody drives it", () => {
  expect(ownerId(row("in-1").owner)).toBe("fixture-role-growth");
  expect(ownerId(row("in-3").owner)).toBe("fixture-user-me");
  expect(ownerId(row("in-4").owner)).toBeNull();
});

test("the wake signature ignores a bare updated_at and sees a health change", () => {
  const r = row("in-1");
  expect(initiativeSig({ ...r, updated_at: r.updated_at + 1 })).toBe(initiativeSig(r));
  expect(initiativeSig({ ...r, health: "off_track" })).not.toBe(initiativeSig(r));
});
