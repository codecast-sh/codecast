import { describe, expect, test } from "bun:test";
import { leadScopeChange, ownerOf, ownsWork, projectLeadOf, projectsWithoutAnOwnerAmongWatchers, scopeListsProject, watchersLabel, type LeadRole } from "./orgLead";

type Role = LeadRole & { _id: string; handle: string };

const role = (handle: string, project_ids: string[], extra: Partial<Role> = {}): Role => ({
  _id: `role_${handle}`,
  handle,
  status: "active",
  scope: { project_ids, plan_ids: [] },
  reports_to: { kind: "user" },
  ...extra,
});

const under = (parent: Role): Partial<Role> => ({ reports_to: { kind: "role", role_id: parent._id } });

const platform = { _id: "proj_platform" };

describe("projectLeadOf", () => {
  test("the role the project names leads it, whatever any scope says", () => {
    const growth = role("growth", []);
    const eng = role("eng", ["proj_platform"]);
    const lead = projectLeadOf({ ...platform, owner_role_id: growth._id }, [growth, eng]);
    expect(lead).toEqual({ kind: "lead", role: growth, by: "owner" });
  });

  test("with no named owner, the one role whose scope lists the project leads it", () => {
    const eng = role("eng", ["proj_platform"]);
    const growth = role("growth", ["proj_site"]);
    expect(projectLeadOf(platform, [eng, growth])).toEqual({ kind: "lead", role: eng, by: "scope" });
  });

  test("two roles on separate lines that both list it watch it; neither leads", () => {
    const eng = role("eng", ["proj_platform"]);
    const growth = role("growth", ["proj_platform", "proj_site"]);
    const lead = projectLeadOf(platform, [eng, growth]);
    expect(lead.kind).toBe("watchers");
    expect(lead.kind === "watchers" && lead.roles.map((r) => r.handle)).toEqual(["eng", "growth"]);
  });

  test("naming one of the watchers settles it", () => {
    const eng = role("eng", ["proj_platform"]);
    const growth = role("growth", ["proj_platform"]);
    expect(projectLeadOf({ ...platform, owner_role_id: growth._id }, [eng, growth])).toEqual({ kind: "lead", role: growth, by: "owner" });
  });

  test("a parent and the child under it both list the project: the child, closest to the work, leads", () => {
    const head = role("head", ["proj_platform", "proj_site"]);
    const lead = role("platform", ["proj_platform"], under(head));
    expect(projectLeadOf(platform, [head, lead])).toEqual({ kind: "lead", role: lead, by: "scope" });
  });

  test("a grandparent steps aside too, and two children under one parent still tie", () => {
    const head = role("head", ["proj_platform"]);
    const mid = role("mid", ["proj_platform"], under(head));
    const a = role("a", ["proj_platform"], under(mid));
    const b = role("b", ["proj_platform"], under(mid));
    expect(projectLeadOf(platform, [head, mid, a])).toEqual({ kind: "lead", role: a, by: "scope" });
    const tie = projectLeadOf(platform, [head, mid, a, b]);
    expect(tie.kind === "watchers" && tie.roles.map((r) => r.handle)).toEqual(["a", "b"]);
  });

  test("an ancestor steps aside even when the role between them does not list the project", () => {
    const head = role("head", ["proj_platform"]);
    const mid = role("mid", ["proj_other"], under(head));
    const leaf = role("leaf", ["proj_platform"], under(mid));
    expect(projectLeadOf(platform, [head, mid, leaf])).toEqual({ kind: "lead", role: leaf, by: "scope" });
  });

  test("a retired role leads nothing: a project that names one falls through to its scope", () => {
    const old = role("old", ["proj_platform"], { status: "retired" });
    const eng = role("eng", ["proj_platform"]);
    expect(projectLeadOf({ ...platform, owner_role_id: old._id }, [old, eng])).toEqual({ kind: "lead", role: eng, by: "scope" });
    expect(projectLeadOf({ ...platform, owner_role_id: old._id }, [old])).toEqual({ kind: "none" });
  });

  test("a paused role still leads", () => {
    const eng = role("eng", ["proj_platform"], { status: "paused" });
    expect(projectLeadOf(platform, [eng])).toEqual({ kind: "lead", role: eng, by: "scope" });
  });

  test("a whole workspace role leads only what no narrower role covers (S26)", () => {
    const head = role("head-of-people", []);
    const eng = role("eng", ["proj_platform"]);
    expect(projectLeadOf(platform, [head])).toEqual({ kind: "lead", role: head, by: "workspace" });
    expect(projectLeadOf(platform, [head, eng])).toEqual({ kind: "lead", role: eng, by: "scope" });
    expect(projectLeadOf({ _id: "proj_site" }, [head, eng])).toEqual({ kind: "lead", role: head, by: "workspace" });
  });

  test("the area falls back to the whole workspace role when its lead retires", () => {
    const head = role("head-of-people", []);
    const eng = role("eng", ["proj_platform"], { status: "retired" });
    expect(projectLeadOf(platform, [head, eng])).toEqual({ kind: "lead", role: head, by: "workspace" });
  });

  test("a role with no scope leads nothing; the Head of People leads what nobody covers", () => {
    expect(projectLeadOf(platform, [role("ops", [])])).toEqual({ kind: "none" });
    const head = role("head-of-people", []);
    expect(projectLeadOf(platform, [head, role("ops", [])])).toEqual({ kind: "lead", role: head, by: "workspace" });
  });

  test("a scope that names only one of the project's plans does not lead the project", () => {
    const planOnly = role("launch", [], { scope: { project_ids: [], plan_ids: ["plan_of_platform"] } });
    expect(projectLeadOf(platform, [planOnly])).toEqual({ kind: "none" });
  });

  test("ids compare as strings, so a document id and its string form agree", () => {
    const id = { toString: () => "proj_platform" };
    const eng = role("eng", [], { scope: { project_ids: [id], plan_ids: [] } });
    expect(scopeListsProject(eng, "proj_platform")).toBe(true);
    expect(projectLeadOf({ _id: id }, [eng]).kind).toBe("lead");
  });

  test("no project, or roles that have not loaded, is no lead", () => {
    expect(projectLeadOf(null, [])).toEqual({ kind: "none" });
    expect(projectLeadOf(platform, null)).toEqual({ kind: "none" });
  });

  test("a cycle in a corrupt reporting chain ends, and still names the matches", () => {
    const a = role("a", ["proj_platform"], { reports_to: { kind: "role", role_id: "role_b" } });
    const b = role("b", ["proj_platform"], { reports_to: { kind: "role", role_id: "role_a" } });
    const lead = projectLeadOf(platform, [a, b]);
    expect(lead.kind === "watchers" && lead.roles.length).toBe(2);
  });
});

describe("leadScopeChange: what naming a lead does to the role's scope", () => {
  test("a scope that does not list the project gains it", () => {
    const growth = role("growth", ["proj_site"]);
    expect(leadScopeChange("proj_platform", growth, [growth])).toEqual({ kind: "add" });
  });

  test("a scope that already lists it is left alone", () => {
    const eng = role("eng", ["proj_platform"]);
    expect(leadScopeChange("proj_platform", eng, [eng])).toEqual({ kind: "listed" });
  });

  test("a whole workspace scope is never narrowed to the one project", () => {
    const head = role("head-of-people", []);
    expect(leadScopeChange("proj_platform", head, [head])).toEqual({ kind: "whole_workspace" });
  });

  test("a role under a parent that does not look after the project keeps its scope", () => {
    const head = role("head", ["proj_site"]);
    const lead = role("lead", ["proj_site"], under(head));
    expect(leadScopeChange("proj_platform", lead, [head, lead])).toEqual({ kind: "outside_parent", parent: head });
  });

  test("a parent that lists the project, or looks after everything, lets the child gain it", () => {
    const head = role("head", ["proj_site", "proj_platform"]);
    const root = role("root", []);
    const a = role("a", ["proj_site"], under(head));
    const b = role("b", ["proj_site"], under(root));
    expect(leadScopeChange("proj_platform", a, [head, a])).toEqual({ kind: "add" });
    expect(leadScopeChange("proj_platform", b, [root, b])).toEqual({ kind: "add" });
  });
});

describe("the words and the analyzer's list", () => {
  test("two is a word, more is a number", () => {
    expect(watchersLabel(2)).toBe("two roles watch this");
    expect(watchersLabel(3)).toBe("3 roles watch this");
  });

  test("lists only the projects several roles watch with no owner", () => {
    const eng = role("eng", ["proj_platform", "proj_api"]);
    const growth = role("growth", ["proj_platform", "proj_site"]);
    const rows = projectsWithoutAnOwnerAmongWatchers(
      [{ _id: "proj_platform" }, { _id: "proj_api" }, { _id: "proj_site", owner_role_id: growth._id }, { _id: "proj_empty" }],
      [eng, growth],
    );
    expect(rows.map((r) => [r.project._id, r.roles.map((x) => x.handle)])).toEqual([["proj_platform", ["eng", "growth"]]]);
  });
});

describe("ownerOf: work belongs to the most specific role that covers it (S26)", () => {
  const head = role("head-of-people", []);
  const growth = role("growth", ["proj_site"]);
  const launch = role("launch", [], { scope: { project_ids: [], plan_ids: ["plan_launch"] } });

  test("a Head of People plus one lead: the lead's project is the lead's, the rest the Head of People's", () => {
    const roles = [head, growth];
    expect(ownerOf({ project_id: "proj_site" }, roles)).toEqual({ kind: "owner", role: growth });
    expect(ownerOf({ project_id: "proj_platform" }, roles)).toEqual({ kind: "owner", role: head });
    expect(ownerOf({}, roles)).toEqual({ kind: "owner", role: head });
    expect(ownsWork(head, { project_id: "proj_site" }, roles)).toBe(false);
  });

  test("remove the lead and its work falls back to the Head of People", () => {
    const roles = [head, { ...growth, status: "retired" }];
    expect(ownerOf({ project_id: "proj_site" }, roles)).toEqual({ kind: "owner", role: head });
  });

  test("a role naming the plan is more specific than one naming the plan's project", () => {
    const roles = [head, growth, launch];
    expect(ownerOf({ project_id: "proj_site", plan_id: "plan_launch" }, roles)).toEqual({ kind: "owner", role: launch });
    expect(ownerOf({ project_id: "proj_site", plan_id: "plan_other" }, roles)).toEqual({ kind: "owner", role: growth });
  });

  test("a lead reporting to the Head of People still owns its area: the Head of People, above it, steps aside", () => {
    const lead = role("growth", ["proj_site"], under(head));
    expect(ownerOf({ project_id: "proj_site" }, [head, lead])).toEqual({ kind: "owner", role: lead });
  });

  test("scope is opt in: a role with no scope owns nothing, and the Head of People keeps the remainder", () => {
    const unscoped = role("ops", [], under(head));
    expect(ownerOf({}, [head, unscoped])).toEqual({ kind: "owner", role: head });
    expect(ownerOf({}, [head, role("ops", [])])).toEqual({ kind: "owner", role: head });
    expect(ownerOf({ project_id: "proj_platform" }, [role("ops", [])])).toEqual({ kind: "none" });
  });

  test("work nobody covers, with no whole workspace role, has no owner", () => {
    expect(ownerOf({ project_id: "proj_platform" }, [growth])).toEqual({ kind: "none" });
    expect(ownerOf({}, null)).toEqual({ kind: "none" });
  });
});

// The rename (org-staffing.md S30): the old handle still names the Head of
// People, and a Chief of Staff never covers the workspace.
describe("isHeadOfPeopleRole and the whole workspace after the rename", () => {
  test("either handle, unless the row is a chief", () => {
    expect(isHeadOfPeopleRole({ handle: HEAD_OF_PEOPLE_HANDLE })).toBe(true);
    expect(isHeadOfPeopleRole({ handle: LEGACY_HEAD_OF_PEOPLE_HANDLE })).toBe(true);
    expect(isHeadOfPeopleRole({ handle: LEGACY_HEAD_OF_PEOPLE_HANDLE, chief: { reach: "global" } })).toBe(false);
    expect(isHeadOfPeopleRole({ handle: "growth" })).toBe(false);
  });
  test("a chief with no scope owns nothing; a legacy row still covers the remainder", () => {
    const chief = { _id: "c", handle: "chief-of-staff", chief: { reach: "global" }, scope: { project_ids: [], plan_ids: [] } };
    const legacy = { _id: "h", handle: "chief-of-staff", scope: { project_ids: [], plan_ids: [] } };
    expect(isWholeWorkspaceRole(chief)).toBe(false);
    expect(isWholeWorkspaceRole(legacy)).toBe(true);
    expect(ownerOf({ project_id: "p1" }, [chief])).toEqual({ kind: "none" });
    expect(ownerOf({ project_id: "p1" }, [legacy])).toEqual({ kind: "owner", role: legacy });
  });
});
