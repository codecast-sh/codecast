// Run: cd packages/shared && bun test contracts/priorityDerive.test.ts
import { describe, expect, test } from "bun:test";
import { attributePlans, bestSession, isWorkflowSession, nextActionOf, orderSessions, type ActionMilestone, type PlanFacts } from "./priorityDerive";

const plan = (id: string, size: number, status = "active"): PlanFacts => ({ id, short_id: id, title: id, done: 0, total: size, size, status });
// The doc's shapes: pl-1075 "Every change merges green through one flow" (37 tasks), pl-619 a 140-task program.
const PLANS = new Map([plan("pl-1075", 37), plan("pl-619", 140), plan("pl-88", 6, "abandoned"), plan("pl-12", 5)].map((p) => [p.id, p]));
const planOf = (id: string) => PLANS.get(id);

describe("attributePlans", () => {
  test("pri-57: pl-1075 holds tasks from every task-bearing milestone, so it is the priority's plan, shown once", () => {
    const a = attributePlans([
      { key: "s1", taskPlans: ["pl-1075", "pl-1075"] },
      { key: "s2", taskPlans: ["pl-1075"] },
      { key: "s3", taskPlans: [] },
      { key: "s4", taskPlans: ["pl-1075", "pl-1075", "pl-12"] },
    ], planOf);
    expect(a.priority?.short_id).toBe("pl-1075");
    // Never repeated on a line.
    for (const k of ["s1", "s2", "s3", "s4"]) expect(a.steps.get(k)!.plan).toBeNull();
  });

  test("pri-24: pl-1075 is only 'Deploy drops the eval job''s plan; pl-619 only inside an expanded milestone", () => {
    const a = attributePlans([
      { key: "deploy-drops", taskPlans: ["pl-1075", "pl-1075", null] },
      { key: "s2", taskPlans: ["pl-619"] },
      { key: "s3", taskPlans: ["pl-619", null] },
      { key: "s4", taskPlans: [] },
    ], planOf);
    // pl-619 covers two of three task-bearing milestones but is a program: never the priority's.
    expect(a.priority).toBeNull();
    expect(a.steps.get("deploy-drops")!.plan?.short_id).toBe("pl-1075");
    expect(a.steps.get("s2")!.plan).toBeNull();
    expect(a.steps.get("s2")!.part_of.map((p) => p.short_id)).toEqual(["pl-619"]);
    expect(a.steps.get("s3")!.part_of.map((p) => p.short_id)).toEqual(["pl-619"]);
    expect(a.steps.get("deploy-drops")!.part_of).toEqual([]);
  });

  test("abandoned plans are ignored; a plan holding under half a milestone's tasks is not its plan", () => {
    const a = attributePlans([
      { key: "s1", taskPlans: ["pl-88", "pl-88"] },
      { key: "s2", taskPlans: ["pl-12", null, null] },
      { key: "s3", taskPlans: [null] },
    ], planOf);
    expect(a.priority).toBeNull();
    expect(a.steps.get("s1")!.plan).toBeNull();
    expect(a.steps.get("s2")!.plan).toBeNull();
  });
});

const s = (state: any, last_active_at: number, workflow = false, id = `${state}${last_active_at}`) => ({ id, state, workflow, last_active_at });
type S = ReturnType<typeof s>;
const m = (key: string, sessions: S[], tier: "critical" | "polish" = "critical", done = false): ActionMilestone<S> => ({ key, tier, done, sessions });

describe("nextActionOf", () => {
  test("Answer outranks Resume, Open and Start, on any open milestone, polish too", () => {
    const a = nextActionOf([m("s1", [s("working", 5)]), m("s2", []), m("p1", [s("needs_you", 3)], "polish")]);
    expect(a?.kind).toBe("answer");
    expect(a?.milestone.key).toBe("p1");
  });

  test("Answer goes to the most recently waiting session a person drives before a workflow run's", () => {
    const a = nextActionOf([m("s1", [s("needs_you", 1, false, "old"), s("needs_you", 9, true, "run")]), m("s2", [s("needs_you", 5, false, "new")])]);
    expect(a?.session?.id).toBe("new");
  });

  test("someone else's session never asks the viewer: no Answer for it", () => {
    const theirs = { ...s("needs_you", 9, false, "theirs"), mine: false };
    const a = nextActionOf([m("s1", [theirs, s("dormant", 1, false, "mine")])]);
    expect([a?.kind, a?.session?.id]).toEqual(["resume", "mine"]);
  });

  test("a done milestone's ask is not the priority's action", () => {
    expect(nextActionOf([m("s1", [s("needs_you", 1)], "critical", true), m("s2", [s("dormant", 1)])])?.kind).toBe("resume");
  });

  test("otherwise the first open critical milestone: Open, Resume, or Start", () => {
    expect(nextActionOf([m("s1", [s("working", 1)])])?.kind).toBe("open");
    expect(nextActionOf([m("s1", [s("idle", 1)])])?.kind).toBe("resume");
    expect(nextActionOf([m("s1", [s("killed", 9), s("done", 9)])])?.kind).toBe("start");
    expect(nextActionOf([m("s1", [], "critical", true), m("s2", [])])?.milestone.key).toBe("s2");
    expect(nextActionOf([m("p1", [], "polish")])).toBeNull();
  });

  test("a person's session ranks above a workflow run, and a closed run is never best", () => {
    expect(bestSession([s("working", 9, true, "run"), s("dormant", 1, false, "mine")])?.id).toBe("mine");
    expect(bestSession([s("killed", 9, true, "run")])).toBeUndefined();
    expect(orderSessions([s("killed", 9, true, "closed-run"), s("working", 1, true, "run"), s("idle", 1, false, "mine")]).map((x) => x.id)).toEqual(["mine", "run", "closed-run"]);
  });
});

test("isWorkflowSession: a run's field, or a subagent titled as a step", () => {
  expect(isWorkflowSession({ is_workflow_sub: true })).toBe(true);
  expect(isWorkflowSession({ workflow_run_id: "r1" })).toBe(true);
  expect(isWorkflowSession({ workflow_run_id: "r1", is_workflow_primary: true })).toBe(false);
  expect(isWorkflowSession({ is_subagent: true, parent_conversation_id: "p", title: "Review · ct-98544 tidy" })).toBe(true);
  expect(isWorkflowSession({ is_subagent: true, parent_conversation_id: "p", title: "Deploy redesign" })).toBe(false);
});
