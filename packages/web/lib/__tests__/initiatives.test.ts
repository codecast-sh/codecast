// What an initiative derives at render (initiatives-projects-role-page.md I1).
// Run: bun test lib/__tests__/initiatives.test.ts
import { test, expect } from "bun:test";
import { FIXTURE_INITIATIVES as ROWS, FIXTURE_NOW, FIXTURE_PROJECTS, FIXTURE_TASKS } from "../../components/initiatives/initiativeFixture";
import { projectTaskCounts } from "@codecast/shared/tasks";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import type { OrgTree } from "../../components/org/orgTypes";
import { goalScopeInitiativeIds, goalScopeProjectIds, groupInitiativesByStatus, initiativeProgress, initiativeSig, initiativesOfProject, ownerId, ownerSeat, progressPercent, projectInitiativeIndex, projectTrouble, subInitiatives, topLevelInitiatives } from "../initiatives";


const row = (short: string) => ROWS.find((r) => r.short_id === short)!;

test("progress counts the tasks the projects' boards would show, dropped left out", () => {
  // proj-org: 2 done of 4 (one dropped is not counted); proj-inbox: 1 done of 2.
  const p = initiativeProgress(row("in-1"), FIXTURE_TASKS);
  expect(p).toEqual({ total: 6, done: 3, in_progress: 1, open: 2 });
  expect(progressPercent(p)).toBe(50);
  expect(progressPercent(initiativeProgress(row("in-4"), FIXTURE_TASKS))).toBe(0);
});

test("a task's status change moves the bar with no stored twin", () => {
  const moved = FIXTURE_TASKS.map((t) => (t._id === "7" ? { ...t, status: "done" } : t));
  expect(initiativeProgress(row("in-1"), moved).done).toBe(4);
});

test("what the board hides is not counted: a plan's task naming no project, agent bookkeeping", () => {
  const more = [...FIXTURE_TASKS, { _id: "9", status: "done", project_id: null, plan_id: "plan-roles", source: "human" }, { _id: "10", status: "done", project_id: "proj-org", source: "agent" }];
  expect(initiativeProgress(row("in-1"), more)).toEqual({ total: 6, done: 3, in_progress: 1, open: 2 });
});

test("a project says its own trouble: past its target, or risks in its charter", () => {
  const counts = (id: string) => projectTaskCounts(FIXTURE_TASKS, [id]);
  const trouble = (id: string) => projectTrouble(FIXTURE_PROJECTS.find((p) => p._id === id)!, counts(id), FIXTURE_NOW);
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
  // The number, its history and the record are painted by the list and the page (I4, I5).
  expect(initiativeSig({ ...r, metrics: [{ key: "k", name: "K", target: "10" }] })).not.toBe(initiativeSig(r));
  expect(initiativeSig({ ...r, scoreboard: { k: { value: "4", observed_at: 1, source: "s" } } })).not.toBe(initiativeSig(r));
  expect(initiativeSig({ ...r, milestones: [{ key: "m", title: "M", done_at: 1 }] })).not.toBe(initiativeSig(r));
  expect(initiativeSig({ ...r, why: "because" })).not.toBe(initiativeSig(r));
});

test("a goal's activity covers its own projects and its sub goals', each once, and names the numbered goals", () => {
  const top = row("in-1");
  const withSub = [...ROWS, { ...row("in-2"), _id: "extra-sub", short_id: "in-9", project_ids: ["proj-billing", "proj-org"] }];
  expect(goalScopeProjectIds(top, withSub)).toEqual(["proj-org", "proj-inbox", "proj-billing"]);
  expect(goalScopeProjectIds(row("in-4"), ROWS)).toEqual([]);
  expect(goalScopeInitiativeIds(top, ROWS)).toEqual(["init-org", "init-org-sub"]);
  // A stub the server has not numbered has no row to ask about.
  expect(goalScopeInitiativeIds({ _id: "in_stub", short_id: "" }, ROWS)).toEqual([]);
});

test("the conversation an initiative opens beside: a role's seat, a person's own anchor, the root seat they host", () => {
  const tree = ORG_FIXTURE as unknown as OrgTree;
  expect(ownerSeat(tree, { kind: "role", role_id: "fixture-role-growth" })).toMatchObject({ conversationId: "fixture-growth-conv", speaker: ORG_FIXTURE.roles[0].name });
  expect(ownerSeat(tree, { kind: "user", user_id: "fixture-user-me" })).toMatchObject({ role: null, conversationId: "fixture-anchor-conv" });
  // On a workspace whose only anchor is the head of people's seat, the person who hosts it opens on that seat.
  const headSeat: OrgTree = { ...tree, roles: [{ ...tree.roles[0], handle: "head-of-people", anchor_id: "fixture-anchor" }], anchors: [{ ...tree.anchors[0], org_role_id: "fixture-role-growth" }] };
  expect(ownerSeat(headSeat, { kind: "user", user_id: "fixture-user-me" }).conversationId).toBe("fixture-anchor-conv");
  expect(ownerSeat(headSeat, { kind: "user", user_id: "fixture-user-sam" }).conversationId).toBeNull();
  expect(ownerSeat(tree, undefined).conversationId).toBeNull();
});
