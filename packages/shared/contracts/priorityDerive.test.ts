// Run: cd packages/shared && bun test contracts/priorityDerive.test.ts
import { describe, expect, test } from "bun:test";
import { attributePlans, isWorkflowSession, milestoneStateOf, orderByState, orderSessions, type PlanFacts } from "./priorityDerive";

const plan = (id: string, size: number, status = "active"): PlanFacts => ({ id, short_id: id, title: id, done: 0, total: size, size, status });
// The doc's shapes: pl-1075 "Every change merges green through one flow" (37 tasks), pl-619 a 140-task program.
const PLANS = new Map([plan("pl-1075", 37), plan("pl-619", 143), plan("pl-88", 6, "abandoned"), plan("pl-12", 5), plan("pl-60", 60)].map((p) => [p.id, p]));
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
      { key: "s3", taskPlans: [null] },
      { key: "s4", taskPlans: [null, null] },
    ], planOf);
    // pl-619 (143 tasks) covers one of four task-bearing milestones: coverage keeps it off the priority.
    expect(a.priority).toBeNull();
    expect(a.steps.get("deploy-drops")!.plan?.short_id).toBe("pl-1075");
    expect(a.steps.get("s2")!.plan).toBeNull();
    expect(a.steps.get("s2")!.part_of.map((p) => p.short_id)).toEqual(["pl-619"]);
    expect(a.steps.get("deploy-drops")!.part_of).toEqual([]);
  });

  test("a 60-task plan covering half or more of the task-bearing milestones is the priority's plan: the size cap is only a milestone's", () => {
    const a = attributePlans([
      { key: "s1", taskPlans: ["pl-60", "pl-60"] },
      { key: "s2", taskPlans: ["pl-60", null] },
      { key: "s3", taskPlans: [null] },
      { key: "s4", taskPlans: ["pl-619"] },
    ], planOf);
    expect(a.priority?.short_id).toBe("pl-60");
    // Never repeated as a milestone's own plan or its "part of".
    for (const k of ["s1", "s2"]) expect([a.steps.get(k)!.plan, a.steps.get(k)!.part_of]).toEqual([null, []]);
    expect(a.steps.get("s4")!.part_of.map((p) => p.short_id)).toEqual(["pl-619"]);
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
const m = (sessions: S[], done = false) => ({ done, sessions });
const OWN = { canStart: true };

describe("milestoneStateOf", () => {
  test("needs you > working > dormant > idle, whatever order the sessions come in", () => {
    expect(milestoneStateOf(m([s("idle", 9), s("working", 1), s("needs_you", 3), s("dormant", 5)]), OWN).kind).toBe("needs_you");
    expect(milestoneStateOf(m([s("idle", 9), s("dormant", 5), s("working", 1)]), OWN).kind).toBe("working");
    expect(milestoneStateOf(m([s("idle", 9), s("dormant", 5)]), OWN).kind).toBe("dormant");
    expect(milestoneStateOf(m([s("idle", 9)]), OWN).kind).toBe("idle");
  });

  test("the session to answer is the most recent ask; a workflow run's ask counts too", () => {
    const st = milestoneStateOf(m([s("needs_you", 1, false, "old"), s("needs_you", 9, true, "run"), s("working", 20)]), OWN);
    expect([st.kind, st.session?.id]).toEqual(["needs_you", "run"]);
  });

  test("a state is the viewer's final verdict: a teammate's session that asks the viewer makes the milestone Needs you", () => {
    // The sidebar holds it under Needs You (a cast decide addressed to the viewer), so its state arrives as needs_you.
    const theirs = { ...s("needs_you", 9, false, "theirs"), mine: false };
    expect(milestoneStateOf(m([theirs, s("working", 1, false, "mine")]), OWN)).toEqual({ kind: "needs_you", session: theirs });
    expect(orderByState([s("working", 20, false, "mine"), theirs]).map((x) => x.id)).toEqual(["theirs", "mine"]);
  });

  test("done is done, whatever still asks on it", () => {
    expect(milestoneStateOf(m([s("needs_you", 1)], true), OWN)).toEqual({ kind: "done" });
  });

  test("no live session: start on the owner's own active priority, else nothing", () => {
    expect(milestoneStateOf(m([s("killed", 9), s("done", 9)]), OWN).kind).toBe("start");
    expect(milestoneStateOf(m([]), OWN).kind).toBe("start");
    expect(milestoneStateOf(m([]), { canStart: false }).kind).toBe("none");
  });
});

test("orderByState: the sidebar's order, then the most recent; closed last", () => {
  const list = [s("killed", 99, false, "closed"), s("idle", 5, false, "idle"), s("working", 1, true, "run"), s("working", 3, false, "work"), s("needs_you", 0, false, "ask")];
  expect(orderByState(list).map((x) => x.id)).toEqual(["ask", "work", "run", "idle", "closed"]);
});

test("orderSessions: a person's session ranks above a workflow run, and every closed session last, a person's included", () => {
  expect(orderSessions([s("killed", 9, true, "closed-run"), s("working", 1, true, "run"), s("idle", 1, false, "mine")]).map((x) => x.id)).toEqual(["mine", "run", "closed-run"]);
  expect(orderSessions([s("done", 99, false, "closed-mine"), s("idle", 1, true, "run")]).map((x) => x.id)).toEqual(["run", "closed-mine"]);
});

test("orderSessions orders the server's own states: someone else's needs_you there ranks as idle", () => {
  const theirs = { ...s("needs_you", 9, false, "theirs"), mine: false };
  expect(orderSessions([theirs, s("dormant", 1, false, "mine")]).map((x) => x.id)).toEqual(["mine", "theirs"]);
});

test("isWorkflowSession: a run's field, or a subagent titled as a step", () => {
  expect(isWorkflowSession({ is_workflow_sub: true })).toBe(true);
  expect(isWorkflowSession({ workflow_run_id: "r1" })).toBe(true);
  expect(isWorkflowSession({ workflow_run_id: "r1", is_workflow_primary: true })).toBe(false);
  expect(isWorkflowSession({ is_subagent: true, parent_conversation_id: "p", title: "Review · ct-98544 tidy" })).toBe(true);
  expect(isWorkflowSession({ is_subagent: true, parent_conversation_id: "p", title: "Deploy redesign" })).toBe(false);
});
