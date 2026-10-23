// A flow derived from its owner role (flows.md FL0): one per role leading a project here, its projects grouped, its
// steps the role's slug or the shipped one, its decider the person the role's reporting line ends at.
import { describe, expect, test } from "bun:test";
import { deciderOf, flowNeeds, flowOf, ownedFlows } from "../ownedFlows";

const role = (id: string, handle: string, over: Record<string, unknown> = {}) => ({
  _id: id, short_id: `or-${id}`, scope_type: "team", host_user_id: "u", name: `${handle} lead`, handle, status: "active",
  scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: "boss" }, ...over,
}) as never;
const lead = (id: string, on = true) => ({ role: { id, handle: "", paused: false }, on, slots: 5, busy: null, hands: null, handsCap: null });

describe("owned flows", () => {
  const roles = [
    role("1", "calling", { reports_to: { kind: "role", role_id: "3" }, line_workflow_slug: "line-pr-9", line_merge: true, review_backend: "codex" }),
    role("2", "deals"),
    role("3", "head", { reports_to: { kind: "user", user_id: "ashot" } }),
    role("4", "gone", { status: "retired" }),
  ];
  const projects = [{ _id: "p1", title: "Callers" }, { _id: "p2", title: "Deals" }, { _id: "p3", title: "Call ideas" }, { _id: "p4", title: "Old" }, { _id: "p5", title: "Nobody's" }];
  const admissions = new Map([["p1", lead("1")], ["p2", lead("2", false)], ["p3", lead("1")], ["p4", lead("4")]]) as never;

  test("one flow per leading role, by owner name; a retired owner and a project nobody leads make none", () => {
    const flows = ownedFlows(projects, admissions, roles);
    expect(flows.map((f) => [f.owner.handle, f.projects.map((p) => p.title), f.on, f.steps, f.merge, f.reviewAgent, f.deciderId])).toEqual([
      ["calling", ["Callers", "Call ideas"], true, "line-pr-9", true, "codex", "ashot"],
      ["deals", ["Deals"], false, "line", false, null, "boss"],
    ]);
    expect(flowOf(flows, "deals")?.owner.handle).toBe("deals");
    expect(flowOf(flows, "nope")).toBeNull();
  });

  test("the decider is where the reporting line ends; a loop ends nowhere", () => {
    expect(deciderOf(role("9", "x", { reports_to: { kind: "role", role_id: "8" } }), [role("8", "y", { reports_to: { kind: "role", role_id: "9" } }), role("9", "x", { reports_to: { kind: "role", role_id: "8" } })])).toBeNull();
  });

  test("a flow's needs are the ones from its projects", () => {
    const [calling] = ownedFlows(projects, admissions, roles);
    expect(flowNeeds([{ projectId: "p1" }, { projectId: "p2" }, { projectId: "p3" }, { projectId: null }], calling)).toEqual([{ projectId: "p1" }, { projectId: "p3" }]);
  });
});
