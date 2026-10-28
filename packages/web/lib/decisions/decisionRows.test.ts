import { describe, expect, test } from "bun:test";
import { arrangeDecisions, decisionKindOf, decisionOwner, decisionView, filterCounts, inTab, tabCounts, viewFields } from "./decisionRows";

// The Decisions list's model: one owner per decision, the tabs, the filters,
// the groups (Unassigned always drawn in the Team view by owner) and the
// order (escalated, then blocking, then the worst finding, then the oldest).

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const row = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, short_id: `sd-${id}`, status: "pending", blocking: true, created_at: NOW - H, options: [{ label: "Yes" }, { label: "No" }], question: `Q${id}`, ...over,
}) as any;
const label = (axis: string, v: string) => `${axis}:${v}`;
const ctx = { me: "u1", now: NOW, label };

describe("decisionOwner", () => {
  test("a pass wins, then the holder, then the one person asked; nobody is Unassigned", () => {
    expect(decisionOwner(row("a", { passed_to: { kind: "user", id: "u2" }, holder: { kind: "user", id: "u1" } }))).toEqual({ kind: "user", id: "u2" });
    expect(decisionOwner(row("b", { holder: { kind: "role", id: "r1" } }))).toEqual({ kind: "role", id: "r1" });
    expect(decisionOwner(row("c", { asked_user_ids: ["u3"] }))).toEqual({ kind: "user", id: "u3" });
    expect(decisionOwner(row("d", { asked_user_ids: [] }))).toBeNull();
    // An older row with no people set is its asker's.
    expect(decisionOwner(row("e", { user_id: "u4" }))).toEqual({ kind: "user", id: "u4" });
  });
});

describe("tabs", () => {
  const rows = [
    row("mine", { holder: { kind: "user", id: "u1" } }),
    row("theirs", { holder: { kind: "user", id: "u2" } }),
    row("nobody", { asked_user_ids: [] }),
    row("up", { holder: { kind: "user", id: "u1" }, escalated: { by: "u2", at: NOW, note: "n", to: ["u1"] } }),
    row("done", { status: "answered", holder: { kind: "user", id: "u1" }, resolved_at: NOW, escalated: { by: "u2", at: NOW, note: "n", to: ["u1"] } }),
  ];
  test("Mine is what I own and is open; Team every open one; Answered the settled ones", () => {
    expect(tabCounts(rows, "u1")).toEqual({ mine: 2, team: 4, unassigned: 1, escalated: 1, answered: 1 });
    // An answered row keeps its escalation stamp, but it is no longer escalated.
    expect(inTab(rows[4], "escalated", "u1")).toBe(false);
  });
});

describe("arrangeDecisions", () => {
  const rows = [
    row("old", { holder: { kind: "user", id: "u2" }, created_at: NOW - 5 * H, category: "scope", area_project_id: "p1" }),
    row("sev", { holder: { kind: "user", id: "u2" }, problem_severity: 9, category: "approach", area_project_id: "p2" }),
    row("adv", { holder: { kind: "user", id: "u1" }, blocking: false, category: "scope" }),
    row("esc", { holder: { kind: "user", id: "u1" }, escalated: { by: "u2", at: NOW, note: "n", to: ["u1"] }, created_at: NOW - 1000 }),
  ];
  test("the Team view groups by owner, the most urgent group first, and draws Unassigned even when empty", () => {
    const { groups } = arrangeDecisions(rows, decisionView({ tab: "team" }), ctx);
    expect(groups!.map((g) => [g.key, g.items.map((d) => d._id)])).toEqual([
      ["user:u1", ["esc", "adv"]],
      ["user:u2", ["sev", "old"]],
      ["none", []],
    ]);
    expect(groups![2].label).toBe("owner:none");
  });

  test("a second grouping folds into one header", () => {
    const { groups } = arrangeDecisions(rows, decisionView({ tab: "team", group: "category", sub: "owner" }), ctx);
    expect(groups!.map((g) => g.label)).toEqual(["category:unknown · owner:user:u1", "category:approach · owner:user:u2", "category:scope · owner:user:u2", "category:scope · owner:user:u1"]);
  });

  test("filters narrow, each filter's counts read with the others applied", () => {
    const view = decisionView({ tab: "team", owner: "user:u2", blocking: "blocking" });
    expect(arrangeDecisions(rows, view, ctx).items.map((d) => d._id)).toEqual(["sev", "old"]);
    expect(Object.fromEntries(filterCounts(rows, view, "u1", NOW, "owner"))).toEqual({ "user:u1": 1, "user:u2": 2 });
    expect(arrangeDecisions(rows, decisionView({ tab: "team", area: "p1,p2", group: "none" }), ctx).items.map((d) => d._id)).toEqual(["sev", "old"]);
    expect(arrangeDecisions(rows, decisionView({ tab: "team", age: "3d", group: "none" }), ctx).items).toEqual([]);
  });

  test("most impact: urgent first, then the people its problem reached, its findings, the worst one's severity", () => {
    const flows = [
      row("few", { problem_reach: 1, problem_findings: 9, problem_severity: 9 }),
      row("many", { problem_reach: 4, problem_findings: 1 }),
      row("found", { problem_findings: 6, problem_severity: 2 }),
      row("bad", { problem_findings: 6, problem_severity: 8 }),
      row("calm", { blocking: false, problem_reach: 9 }),
    ];
    const by = (sort: string) => arrangeDecisions(flows, decisionView({ tab: "team", group: "none", sort }), ctx).items.map((d) => d._id);
    expect(by("impact")).toEqual(["many", "few", "bad", "found", "calm"]);
    expect(by("findings")).toEqual(["few", "bad", "found", "many", "calm"]);
  });

  test("sorts by age or severity on request, either way", () => {
    expect(arrangeDecisions(rows, decisionView({ tab: "team", group: "none", sort: "age" }), ctx).items.map((d) => d._id)).toEqual(["old", "sev", "adv", "esc"]);
    expect(arrangeDecisions(rows, decisionView({ tab: "team", group: "none", sort: "age", dir: "desc" }), ctx).items[0]._id).toBe("esc");
    expect(arrangeDecisions(rows, decisionView({ tab: "team", group: "none", sort: "severity" }), ctx).items[0]._id).toBe("sev");
  });
});

describe("views", () => {
  test("a view stores only what differs from its tab's default, and reads back the same", () => {
    const v = decisionView({ tab: "team", owner: "none", sort: "age" });
    expect(viewFields(v)).toEqual({ tab: "team", owner: "none", sort: "age" });
    expect(decisionView(viewFields(v))).toEqual(v);
    // Mine starts flat, Team by owner; nonsense falls to the default.
    expect(decisionView({}).group).toBe("none");
    expect(decisionView({ tab: "team" }).group).toBe("owner");
    expect(decisionView({ tab: "bogus", sort: "nope" })).toEqual(decisionView({}));
  });
});

test("a change card or the flow's decide gate is a Fix, another run's ask a flow step, else a question", () => {
  expect(decisionKindOf({ card: { change: "anything" } as any })).toBe("fix");
  expect(decisionKindOf({ workflow_run_id: "r", gate_node_id: "decide" } as any)).toBe("fix");
  expect(decisionKindOf({ workflow_run_id: "r", gate_node_id: "review" } as any)).toBe("step");
  expect(decisionKindOf({})).toBe("question");
});
