import { describe, expect, test } from "bun:test";
import { leadScopeChange, projectLeadOf, projectsWithoutAnOwnerAmongWatchers, scopeListsProject, watchersLabel, type LeadRole } from "./orgLead";

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

  test("a whole workspace scope is the root's view, never a claim on a project", () => {
    const chief = role("chief-of-staff", []);
    expect(projectLeadOf(platform, [chief])).toEqual({ kind: "none" });
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
    const chief = role("chief-of-staff", []);
    expect(leadScopeChange("proj_platform", chief, [chief])).toEqual({ kind: "whole_workspace" });
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
