// The role scope model (lib/roleScope; org-roles-run-work.md R3): what the
// hover card and the role page's Scope tab both paint from.
import { describe, expect, test } from "bun:test";
import { buildRoleScope, charterLead, dailyLimitLine, groupsLine, planStateLine, projectStateLine, sessionsLine, sourceFromCard, sourceFromTree } from "../roleScope";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import type { OrgRole, OrgTree } from "../../components/org/orgTypes";

const TODAY = "2026-09-18";
const growth = ORG_FIXTURE.roles[0];
const seo: OrgRole = {
  ...growth, _id: "fixture-role-seo", short_id: "or-2", name: "SEO lead", handle: "seo",
  scope: { project_ids: [], plan_ids: ["fixture-plan-seo"] }, reports_to: { kind: "role", role_id: growth._id },
  scope_names: { projects: [], plans: [{ id: "fixture-plan-seo", title: "SEO and AI citations", short_id: "pl-88" }] },
};
const tree: OrgTree = { ...ORG_FIXTURE, roles: [{ ...growth, caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000 }, counters: { day: TODAY, hands: 1, wakes: 3, tokens: 1200 } }, seo] };

const rows = {
  projects: [{ _id: "fixture-project-growth", title: "Growth", short_id: "pr-4", status: "active" }],
  plans: [
    { _id: "fixture-plan-seo", title: "SEO and AI citations", short_id: "pl-88", status: "active", project_id: "fixture-project-growth" },
    { _id: "fixture-plan-ads", title: "Paid search", short_id: "pl-90", status: "active", project_id: "fixture-project-growth" },
    { _id: "fixture-plan-old", title: "Old launch", short_id: "pl-12", status: "done", project_id: "fixture-project-growth" },
  ],
  tasks: [
    { _id: "t1", status: "open", project_id: "fixture-project-growth", plan_id: "fixture-plan-seo", assignee: growth._id },
    { _id: "t2", status: "in_progress", project_id: "fixture-project-growth", plan_id: "fixture-plan-seo", assignee: growth._id },
    { _id: "t3", status: "done", project_id: "fixture-project-growth", plan_id: "fixture-plan-seo", assignee: "fixture-user-me" },
    { _id: "t4", status: "dropped", project_id: "fixture-project-growth", plan_id: "fixture-plan-seo" },
    // No project of its own: it counts under its plan's project.
    { _id: "t5", status: "open", plan_id: "fixture-plan-ads" },
  ],
  roles: tree.roles,
  sessions: [
    { state: "needs_input" as const, task_id: "t1" },
    { state: "working" as const, task_id: "t5" },
    { state: "working" as const, task_id: null },
  ],
};

describe("buildRoleScope", () => {
  const model = buildRoleScope(sourceFromTree(tree, tree.roles[0]), rows, TODAY);

  test("a project is one card: its state, that this role leads it, its plans and its sessions inside", () => {
    expect(model.projects).toHaveLength(1);
    const p = model.projects[0];
    expect(p).toMatchObject({ title: "Growth", ref: "pr-4", open: 3, done: 1, leads: true, partial: false });
    expect(projectStateLine(p)).toBe("3 open tasks · 1 done");
    // Plans live inside their project, never beside it.
    expect(p.plans.map((pl) => pl.ref)).toEqual(["pl-90", "pl-88"]);
    expect(model.loosePlans).toEqual([]);
    // A session bound to a task with no project still lands in the plan's project.
    expect(groupsLine(p.sessions)).toBe("1 waiting on a person · 1 working");
  });

  test("a plan carries live progress; dropped tasks leave the total", () => {
    const named = model.projects[0].plans.find((p) => p.ref === "pl-88")!;
    expect(named).toMatchObject({ done: 1, total: 3 });
    expect(planStateLine(named)).toBe("1 of 3 done");
  });

  test("an open plan of a project in scope is in scope; a finished one is not pulled in", () => {
    expect(model.projects[0].plans.map((p) => p.ref)).not.toContain("pl-12");
    expect(planStateLine(model.projects[0].plans.find((p) => p.ref === "pl-90")!)).toBe("0 of 1 done");
  });

  test("a plan in no project goes in the last group, and filing it moves it and its work into the project", () => {
    const loose = { ...rows, plans: rows.plans.map((p) => (p._id === "fixture-plan-seo" ? { ...p, project_id: undefined } : p)), tasks: rows.tasks.map((t) => ({ ...t, project_id: undefined })) };
    const before = buildRoleScope(sourceFromTree(tree, tree.roles[0]), loose, TODAY);
    expect(before.loosePlans.map((p) => p.ref)).toEqual(["pl-88"]);
    expect(before.projects[0].open).toBe(1);
    // The one gesture: the plan row takes the project; the tasks follow at render.
    const filed = { ...loose, plans: loose.plans.map((p) => (p._id === "fixture-plan-seo" ? { ...p, project_id: "fixture-project-growth" } : p)) };
    const after = buildRoleScope(sourceFromTree(tree, tree.roles[0]), filed, TODAY);
    expect(after.loosePlans).toEqual([]);
    expect(after.projects[0]).toMatchObject({ open: 3, done: 1 });
  });

  test("a role whose scope names only a plan sees that plan inside its project, marked as partial", () => {
    const child = buildRoleScope(sourceFromTree(tree, seo), rows, TODAY);
    expect(child.projects).toHaveLength(1);
    expect(child.projects[0]).toMatchObject({ title: "Growth", partial: true, leads: false });
    expect(child.projects[0].plans.map((p) => p.ref)).toEqual(["pl-88"]);
  });

  test("sessions read by who acts next, in a person's words", () => {
    expect(model.sessions!.total).toBe(growth.total);
    expect(sessionsLine(model.sessions!)).toMatch(/waiting on a person/);
    expect(sessionsLine(model.sessions!)).not.toMatch(/needs_input|Needs input/);
  });

  test("who it reports to, who reports to it, and what it owns", () => {
    expect(model.reportsTo).toMatchObject({ kind: "user", name: "Ashot Petrosian" });
    expect(model.reports).toEqual([{ kind: "role", short_id: "or-2", name: "SEO lead", handle: "seo", avatar: undefined }]);
    expect(model.owned.open).toBe(2);
    expect(model.owned.byStatus.map((s) => `${s.count} ${s.label}`)).toEqual(["1 in progress", "1 open"]);
  });

  test("a role under another names that role as its parent", () => {
    const child = buildRoleScope(sourceFromTree(tree, seo), rows, TODAY);
    expect(child.reportsTo).toMatchObject({ kind: "role", short_id: "or-1", handle: "growth" });
    expect(child.whole).toBe(false);
  });

  test("an empty scope is the whole workspace: every project the store holds", () => {
    const chief: OrgRole = { ...growth, scope: { project_ids: [], plan_ids: [] }, scope_names: { projects: [], plans: [] } };
    const whole = buildRoleScope(sourceFromTree({ ...tree, roles: [chief] }, chief), { ...rows, roles: [chief] }, TODAY);
    expect(whole.whole).toBe(true);
    expect(whole.projects.map((p) => p.title)).toEqual(["Growth"]);
    // The whole workspace is a view of everything, never a claim on one project.
    expect(whole.projects[0].leads).toBe(false);
  });
});

describe("initiatives", () => {
  const init = (over: Record<string, unknown>) => ({ _id: "i", short_id: "in-1", title: "T", status: "active", health: "none", project_ids: [], ...over }) as never;
  test("the ones the role drives come first, then the ones its projects carry; closed ones are left out", () => {
    const model = buildRoleScope(sourceFromTree(tree, tree.roles[0]), {
      ...rows,
      initiatives: [
        init({ _id: "i1", short_id: "in-1", title: "Double organic signups", health: "at_risk", project_ids: ["fixture-project-growth"] }),
        init({ _id: "i2", short_id: "in-2", title: "Own the category", owner: { kind: "role", role_id: growth._id } }),
        init({ _id: "i3", short_id: "in-3", title: "Done already", status: "completed", project_ids: ["fixture-project-growth"] }),
        init({ _id: "i4", short_id: "in-4", title: "Somebody else's", project_ids: ["another-project"] }),
      ],
    }, TODAY);
    expect(model.initiatives.map((i) => [i.ref, i.owned, i.projects])).toEqual([["in-2", true, 0], ["in-1", false, 1]]);
  });
  test("none in the store, none in the view", () => {
    expect(buildRoleScope(sourceFromTree(tree, tree.roles[0]), rows, TODAY).initiatives).toEqual([]);
  });
});

describe("the card's answer stands in for the tree", () => {
  test("names and limits come from the card; counts still come from the rows", () => {
    const source = sourceFromCard({
      _id: growth._id, short_id: "or-1", name: "Head of Growth", handle: "growth", charter: "Owns organic search.",
      reports_to: { kind: "user", name: "Ashot Petrosian" },
      scope: { projects: [{ id: "fixture-project-growth", title: "Growth", short_id: "pr-4" }], plans: [] },
      caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 1 }, counters: null,
    });
    const model = buildRoleScope(source, rows, TODAY);
    expect(model.projects[0]).toMatchObject({ title: "Growth", open: 3 });
    expect(model.sessions).toBeNull();
    expect(model.limit).toBe("woke 0 of 40 times today · started 0 of 6 sessions");
  });
});

describe("words", () => {
  test("the charter's first sentence and first paragraph, minus a heading", () => {
    const c = charterLead("# Charter\n\nOwns search. Reports weekly.\nStill the first paragraph.\n\nSecond paragraph.");
    expect(c.sentence).toBe("Owns search.");
    expect(c.paragraph).toBe("Owns search. Reports weekly. Still the first paragraph.");
    expect(c.more).toBe(true);
    expect(charterLead("")).toEqual({ sentence: "", paragraph: "", more: false });
  });

  test("the daily limit says limit, wakes and sessions; yesterday's use reads as none", () => {
    const caps = { hands_per_day: 1, wakes_per_day: 40, tokens_per_day: 1 };
    expect(dailyLimitLine(caps, { day: TODAY, hands: 1, wakes: 3, tokens: 0 }, TODAY)).toBe("woke 3 of 40 times today · started 1 of 1 session");
    expect(dailyLimitLine(caps, { day: "2026-09-17", hands: 1, wakes: 3, tokens: 0 }, TODAY)).toBe("woke 0 of 40 times today · started 0 of 1 session");
    expect(dailyLimitLine(null, null, TODAY)).toBeNull();
    expect(dailyLimitLine({ ...caps, hands_per_day: 0 }, null, TODAY)).toBe("woke 0 of 40 times today · may not start sessions");
  });

  test("a quiet or paused project says so", () => {
    expect(projectStateLine({ status: "paused", open: 0, done: 0 })).toBe("paused · nothing open");
  });
});
