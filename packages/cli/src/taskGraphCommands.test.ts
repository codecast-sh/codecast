import { describe, expect, test } from "bun:test";
import type { PrWaitTarget, TaskWait } from "@codecast/shared/tasks";
import {
  createPlanSteps,
  planStepBase,
  planTemplate,
  planWorkspace,
  routeBlockerRef,
  splitRefs,
  stepsFromTemplate,
  stepsFromText,
  supersededLine,
  taskGraphSections,
  waitAddedLine,
  waitBody,
  type GraphDeps,
} from "./taskGraphCommands";

const NOW = Date.UTC(2026, 9, 8, 12);

describe("routeBlockerRef", () => {
  test("tasks go to the dependency routes, everything else to the wait routes", () => {
    expect(routeBlockerRef("ct-012")).toEqual({ kind: "task", ref: "ct-12" });
    expect(routeBlockerRef("#42")).toEqual({ kind: "wait", ref: "#42", barePr: true });
    expect(routeBlockerRef("acme/api#42:checks")).toEqual({ kind: "wait", ref: "acme/api#42:checks", barePr: false });
    expect(routeBlockerRef("sd-4")).toEqual({ kind: "wait", ref: "sd-4", barePr: false });
    expect(routeBlockerRef("2h", { now: NOW })).toEqual({ kind: "wait", ref: "2h", barePr: false });
  });

  test("an unknown ref teaches the accepted forms", () => {
    expect(() => routeBlockerRef("tomorrow")).toThrow(/a task \(ct-12\), a PR \(#42/);
    expect(() => routeBlockerRef("42")).toThrow(/write #42 for a pull request or ct-42 for a task/);
  });

  test("removal also takes a wait's id, and says so when nothing matches", () => {
    expect(routeBlockerRef("wmg3k2p1x4", { removing: true })).toEqual({ kind: "wait_id", id: "wmg3k2p1x4" });
    expect(() => routeBlockerRef("whenever", { removing: true })).toThrow(/or a wait's id/);
    expect(() => routeBlockerRef("wmg3k2p1x4")).toThrow();
  });

  test("a wait id with no digit in it is still a wait id (base36 may have none)", () => {
    expect(routeBlockerRef("wmuzabcdxyz", { removing: true })).toEqual({ kind: "wait_id", id: "wmuzabcdxyz" });
    expect(routeBlockerRef("wmuzabcdxy", { removing: true })).toEqual({ kind: "wait_id", id: "wmuzabcdxy" });
  });
});

test("splitRefs trims and drops blanks", () => {
  expect(splitRefs(" ct-1, #42:checks ,,sd-3 ")).toEqual(["ct-1", "#42:checks", "sd-3"]);
  expect(splitRefs(undefined)).toEqual([]);
});

describe("waitBody", () => {
  test("carries the zone and the session; a wait id goes as wait_id", () => {
    const body = waitBody("ct-5", { kind: "wait_id", id: "wabcdef1" }, { cwd: "/nonexistent", sessionId: "sess" });
    expect(body).toMatchObject({ short_id: "ct-5", wait_id: "wabcdef1", conversation_id: "sess" });
    expect(typeof body.time_zone).toBe("string");
  });

  test("a bare #42 outside a git checkout sends no repository; the server tries the task's project", () => {
    const body = waitBody("ct-5", { kind: "wait", ref: "#42", barePr: true }, { cwd: "/" });
    expect(body.ref).toBe("#42");
    expect(body.repository).toBeUndefined();
    expect(body.conversation_id).toBeUndefined();
  });

  test("inside a git checkout, adding a bare #42 names the checkout's repository and removing it does not", () => {
    const repo = import.meta.dir;
    const r = { kind: "wait" as const, ref: "#42", barePr: true };
    expect(waitBody("ct-5", r, { cwd: repo }).repository).toMatch(/^[\w.-]+\/[\w.-]+$/);
    const removal = waitBody("ct-5", r, { cwd: repo, removing: true });
    expect(removal).toEqual({ short_id: "ct-5", ref: "#42", time_zone: expect.any(String) });
  });
});

type PrWait = Extract<TaskWait, PrWaitTarget>;
const prWait = (state: TaskWait["state"], note?: string, pr_number = 42): PrWait => ({
  id: `w${pr_number}`, kind: "pr_merged" as const, repository: "acme/api", pr_number, state, created_at: NOW, ...(note ? { note } : {}),
});

test("waitAddedLine: waiting, met at once, already there", () => {
  expect(waitAddedLine("ct-5", { wait: prWait("waiting"), met: false })).toBe("ct-5 is waiting on PR #42");
  expect(waitAddedLine("ct-5", { wait: prWait("met", "already merged"), met: true })).toBe("ct-5 has nothing to wait for: PR #42 merged already");
  expect(waitAddedLine("ct-5", { wait: prWait("waiting"), met: false, existing: true })).toBe("ct-5 was already waiting on PR #42");
  const at = Date.now() + 3_600_000;
  expect(waitAddedLine("ct-5", { wait: { id: "w2", kind: "time", at, state: "waiting", created_at: NOW }, met: false })).toMatch(/^ct-5 is waiting until (\w{3} )?\d\d:\d\d$/);
});

describe("taskGraphSections", () => {
  test("the web's order and words, waits after tasks, empty sections left out", () => {
    const sections = taskGraphSections(
      { blocked_by: ["ct-1", "ct-2", "ct-3"], waits: [prWait("waiting"), prWait("failed", "closed without merging", 7)] },
      {
        blocked_by: [
          { short_id: "ct-1", title: "Design", status: "done" },
          { short_id: "ct-2", status: "missing", missing: true },
          { short_id: "ct-3", status: "unknown" },
        ],
        blocks: [{ short_id: "ct-9", title: "Ship", status: "open" }],
        found_during: { short_id: "ct-4", title: "Audit", status: "in_progress" },
        found_here: [],
        related: [{ short_id: "ct-6", title: "Docs", status: "open" }],
        superseded_by: null,
      },
    );
    expect(sections).toEqual([
      {
        label: "Blocked by",
        holds: true,
        items: ["ct-1 Design [done]", "ct-2 (not found)", "ct-3 (status unknown)", "PR #42 merges (waiting) · w42", "PR #7 merges (failed: closed without merging) · w7"],
      },
      { label: "Blocks", items: ["ct-9 Ship [open]"] },
      { label: "Found during", items: ["ct-4 Audit [in_progress]"] },
      { label: "Related", items: ["ct-6 Docs [open]"] },
    ]);
  });

  test("nothing holds once every task closed and every wait met", () => {
    const [s] = taskGraphSections({ waits: [prWait("met", "merged")] }, { blocked_by: [{ short_id: "ct-1", title: "A", status: "dropped" }] });
    expect(s.holds).toBe(false);
    expect(s.label).toBe("Blocked by (cleared)");
    expect(s.items).toEqual(["ct-1 A [dropped]", "PR #42 merges (met: merged) · w42"]);
  });

  test("a missing task holds nothing; the wait id takes the reader's style", () => {
    const [s] = taskGraphSections({ waits: [prWait("waiting")] }, { blocked_by: [{ short_id: "ct-2", status: "missing", missing: true }] }, { waitId: (x) => `<${x}>` });
    expect(s.holds).toBe(true);
    expect(s.items[1]).toBe("PR #42 merges (waiting)< · w42>");
    expect(taskGraphSections({}, { blocked_by: [{ short_id: "ct-2", status: "missing", missing: true }] })[0].holds).toBe(false);
  });

  test("the replacement is its own line, never a section after the rest", () => {
    const links = { superseded_by: { short_id: "ct-12", title: "New plan", status: "open" } };
    expect(taskGraphSections({}, links)).toEqual([]);
    expect(supersededLine(links)).toBe("Superseded by: ct-12 New plan [open]");
    expect(supersededLine({ superseded_by: null })).toBeNull();
  });

  test("a server without links still lists the raw ids", () => {
    expect(taskGraphSections({ blocked_by: ["ct-1"], blocks: ["ct-2"] }, undefined)).toEqual([
      { label: "Blocked by", holds: true, items: ["ct-1 (status unknown)"] },
      { label: "Blocks", items: ["ct-2"] },
    ]);
  });
});

describe("plan steps", () => {
  test("stepsFromText refuses an empty list with the form", () => {
    expect(() => stepsFromText("\n \n")).toThrow(/blank line between waves/);
    expect(stepsFromText("A\n\nB\nC").map((s) => s.after)).toEqual([[], [0], [0]]);
  });

  test("stepsFromTemplate keeps only backward edges", () => {
    const steps = stepsFromTemplate({ task_templates: [{ title: "A" }, { title: "B", blocked_by_indices: [0, 1, 5] }] });
    expect(steps).toEqual([{ title: "A", after: [] }, { title: "B", after: [0] }]);
  });

  function fakeDeps(templates: unknown[] = [], here: Awaited<ReturnType<GraphDeps["workspace"]>> = { workspace: "personal" }) {
    const calls: Array<{ path: string; body: Record<string, any> }> = [];
    let n = 100;
    const deps: GraphDeps = {
      cliPost: async (path, body) => {
        calls.push({ path, body });
        if (path === "/cli/work/create") return { short_id: `ct-${++n}` };
        if (path === "/cli/plans/templates") return templates;
        return {};
      },
      sessionId: () => null,
      cwd: () => "/repo",
      printJson: () => {},
      workspace: async () => here,
    };
    return { deps, calls };
  }

  test("createPlanSteps wires waves; the first wave waits on the roots", async () => {
    const { deps, calls } = fakeDeps();
    const created = await createPlanSteps(deps, "pl-1", stepsFromText("Design\n\nAPI\nUI\n\nReview"), { roots: ["ct-7"], base: { source: "agent" } });
    expect(created.map((c) => [c.short_id, c.blocked_by])).toEqual([
      ["ct-101", ["ct-7"]],
      ["ct-102", ["ct-101"]],
      ["ct-103", ["ct-101"]],
      ["ct-104", ["ct-102", "ct-103"]],
    ]);
    expect(calls[0].body).toMatchObject({ title: "Design", plan_id: "pl-1", found_during: "none", source: "agent", blocked_by: ["ct-7"] });
    expect("after" in calls[0].body).toBe(false);
  });

  const stepsOf = async (deps: GraphDeps, name: string) => (await planTemplate(deps, name)).steps;

  test("planTemplate: built-ins chain, saved ones by name in any case, unknown lists both", async () => {
    const saved = [{ name: "Release train", goal_template: "Ship weekly", task_templates: [{ title: "Cut" }, { title: "Ship", blocked_by_indices: [0] }] }];
    const { deps } = fakeDeps(saved);
    expect((await stepsOf(deps, "Implement-Review-Fix")).map((s) => s.after)).toEqual([[], [0], [1], [2]]);
    expect((await stepsOf(deps, "release TRAIN")).map((s) => [s.title, s.after])).toEqual([["Cut", []], ["Ship", [0]]]);
    await expect(stepsOf(deps, "nope")).rejects.toThrow(/full-lifecycle, "Release train"/);
  });

  test("planTemplate: a saved template brings its plan's goal; a built-in has none", async () => {
    const { deps } = fakeDeps([{ name: "Release train", goal_template: "Ship weekly", task_templates: [{ title: "Cut" }] }]);
    expect((await planTemplate(deps, "release train")).goal).toBe("Ship weekly");
    expect((await planTemplate(deps, "full-lifecycle")).goal).toBeUndefined();
  });

  test("planTemplate: a name saved in several workspaces takes this one's, and refuses a guess", async () => {
    const saved = [
      { name: "Release", team_id: "team_a", task_templates: [{ title: "A" }] },
      { name: "release", task_templates: [{ title: "Personal" }] },
    ];
    expect((await stepsOf(fakeDeps(saved, { workspace: "team", team_id: "team_a" }).deps, "RELEASE")).map((s) => s.title)).toEqual(["A"]);
    expect((await stepsOf(fakeDeps(saved).deps, "release")).map((s) => s.title)).toEqual(["Personal"]);
    await expect(stepsOf(fakeDeps(saved, { workspace: "team", team_id: "team_b" }).deps, "release")).rejects.toThrow(/none of them this one/);
  });

  test("planStepBase stamps steps with the plan's origin and workspace", () => {
    const { deps } = fakeDeps();
    expect(planStepBase(deps, { human: true })).toEqual({ project_path: "/repo", source: "human" });
    expect(planStepBase({ ...deps, sessionId: () => "sess" })).toEqual({ project_path: "/repo", source: "agent", conversation_id: "sess" });
    expect(planStepBase(deps, { human: true, plan: { workspace: "team:t1", team_id: "t1" } })).toMatchObject({ workspace: "team", team_id: "t1" });
  });

  test("planStepBase files steps in the plan's project, under the session the plan was stamped with", () => {
    const { deps } = fakeDeps();
    expect(planStepBase(deps, { human: true, plan: { project_id: "proj1" } })).toEqual({ project_path: "/repo", project_id: "proj1", source: "human" });
    // plan create detected a session the deps would not guess: the steps follow the plan.
    expect(planStepBase(deps, { sessionId: "guessed" })).toEqual({ project_path: "/repo", source: "agent", conversation_id: "guessed" });
    expect(planStepBase({ ...deps, sessionId: () => "sess" }, { sessionId: null, human: true })).toEqual({ project_path: "/repo", source: "human" });
  });

  test("planWorkspace reads the plan's access key, else its legacy team", () => {
    expect(planWorkspace({ workspace: "team:t1" })).toEqual({ workspace: "team", team_id: "t1" });
    expect(planWorkspace({ workspace: "user:u1", team_id: "t1" })).toEqual({ workspace: "personal" });
    expect(planWorkspace({ team_id: "t2" })).toEqual({ workspace: "team", team_id: "t2" });
    expect(planWorkspace(undefined)).toEqual({});
  });

  test("createPlanSteps: a refused step names what was filed and how to add the rest", async () => {
    let n = 0;
    const deps: GraphDeps = {
      ...fakeDeps().deps,
      cliPost: async () => {
        if (++n === 3) throw new Error("Plan is in another workspace");
        return { short_id: `ct-${n}` };
      },
    };
    await expect(createPlanSteps(deps, "pl-1", stepsFromText("A\nB\nC\nD"))).rejects.toThrow(
      'Plan is in another workspace\n2 of 4 steps filed (ct-1, ct-2); "C" and the steps after it were not. Add them with: cast plan steps pl-1 -',
    );
  });

  test("planTemplate: your own copy wins; several others' copies are refused by name", async () => {
    const team = { workspace: "team" as const, team_id: "team_a" };
    const saved = [
      { name: "Release", team_id: "team_a", workspace_label: "Acme", author: "Ann", mine: false, task_templates: [{ title: "Ann's" }] },
      { name: "release", team_id: "team_a", workspace_label: "Acme", author: "Me", mine: true, task_templates: [{ title: "Mine" }] },
    ];
    expect((await stepsOf(fakeDeps(saved, team).deps, "release")).map((s) => s.title)).toEqual(["Mine"]);
    const others = [saved[0], { ...saved[1], author: "Bob", mine: false }];
    await expect(stepsOf(fakeDeps(others, team).deps, "release")).rejects.toThrow(/several people in this workspace \(Acme, by Ann; Acme, by Bob\)/);
    await expect(stepsOf(fakeDeps(others).deps, "release")).rejects.toThrow(/other workspaces \(Acme, by Ann; Acme, by Bob\), none of them this one/);
  });
});
