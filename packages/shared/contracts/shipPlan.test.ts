import { describe, expect, test } from "bun:test";
import { resolveShipPlan, shipBrief, shipProgress, type ShipFacts } from "./shipPlan";

const base: ShipFacts = {
  target: { kind: "task", id: "t1" },
  label: "ct-42 Fix the login race",
  repository: "acme/app",
  branch: "fix-login",
  base: "main",
  projectPath: "/src/app",
  taskShortId: "ct-42",
  profile: null,
  pr: null,
  lineGate: null,
  sessionShortId: null,
};
const profile = { check: "bun test", ship: "./ship.sh $branch", merge: { auto: false, method: "squash" as const } };

describe("resolveShipPlan", () => {
  test("no profile: the cast-ship flow opens a PR and never merges from a task", () => {
    const plan = resolveShipPlan(base);
    expect(plan.procedure).toBe("cast_ship");
    expect(plan.checks).toEqual(["cast ws check"]);
    expect(plan.pr).toEqual({ action: "open" });
    expect(plan.merge.will).toBe(false);
    expect(plan.blocked).toBeNull();
    expect(plan.steps.join(" ")).toContain("opens a pull request into main");
    expect(plan.steps[0]).toBe("Starts a ship session in /src/app.");
    expect(plan.steps.join(" ")).not.toContain("Merges");
  });

  test("profile present: its check and ship command run; merge follows merge.auto", () => {
    const plan = resolveShipPlan({ ...base, profile });
    expect(plan.procedure).toBe("profile_command");
    expect(plan.checks).toEqual(["bun test"]);
    expect(plan.command).toBe("./ship.sh $branch");
    expect(plan.merge.will).toBe(false);
    const auto = resolveShipPlan({ ...base, profile: { ...profile, ship: null, merge: { auto: true, method: "rebase" } } });
    expect(auto.procedure).toBe("cast_ship");
    expect(auto.merge).toMatchObject({ will: true, method: "rebase" });
    expect(auto.merge.why).toContain("merge.auto");
  });

  test("PR already open: shepherds it from its head branch, and only the PR page merges", () => {
    const pr = { repository: "acme/app", number: 12, state: "open", head_ref: "fix-login-2", base_ref: "release" };
    const fromTask = resolveShipPlan({ ...base, pr });
    expect(fromTask.pr).toEqual({ action: "shepherd", repository: "acme/app", number: 12 });
    expect(fromTask.branch).toBe("fix-login-2");
    expect(fromTask.base).toBe("release");
    expect(fromTask.merge.will).toBe(false);
    const fromPr = resolveShipPlan({ ...base, target: { kind: "pull_request", id: "p1" }, pr });
    expect(fromPr.merge.will).toBe(true);
    expect(fromPr.merge.why).toContain("pull request");
  });

  test("a merged or closed PR blocks; so does a missing checkout", () => {
    expect(resolveShipPlan({ ...base, pr: { repository: "acme/app", number: 3, state: "merged" } }).blocked).toContain("already merged");
    expect(resolveShipPlan({ ...base, pr: { repository: "acme/app", number: 3, state: "closed" } }).blocked).toContain("closed");
    expect(resolveShipPlan({ ...base, projectPath: null }).blocked).toContain("No checkout");
  });

  test("a change on the base branch moves to a new branch named after the work", () => {
    const plan = resolveShipPlan({ ...base, branch: "main", target: { kind: "conversation", id: "c1" }, taskShortId: null, sessionShortId: "jx7abcd" });
    expect(plan.newBranch).toBe(true);
    expect(plan.branch).toBe("ship/jx7abcd");
    expect(plan.steps[0]).toContain("from session jx7abcd's changes");
    expect(plan.steps[1]).toContain("new branch ship/jx7abcd");
  });

  test("a line run at its card: Ship answers the card, and the line lands it its own way", () => {
    const plan = resolveShipPlan({ ...base, profile, lineGate: { decisionId: "d1" } });
    expect(plan.procedure).toBe("line_gate");
    expect(plan.steps[1]).toContain("./ship.sh $branch");
    const merges = resolveShipPlan({ ...base, lineGate: { decisionId: "d1" } });
    expect(merges.merge.will).toBe(true);
    expect(merges.steps[1]).toContain("merge step");
  });
});

describe("shipBrief", () => {
  test("names the branch, the task, the checks and whether to merge", () => {
    const plan = resolveShipPlan({ ...base, profile: { ...profile, ship: null } });
    const brief = shipBrief(plan, base);
    expect(brief).toContain("Branch: fix-login");
    expect(brief).toContain("Task: ct-42");
    expect(brief).toContain("`bun test`");
    expect(brief).toContain("gh pr create");
    expect(brief).toContain("Do not merge.");
  });
});

describe("shipProgress", () => {
  test("folds the session row and the PR into one phase", () => {
    expect(shipProgress({ session: null }).phase).toBe("starting");
    expect(shipProgress({ session: { thread_state: "Checks running", thread_state_status: "working" } }).phase).toBe("checks");
    expect(shipProgress({ session: { thread_state: "Failed: tsc", thread_state_status: "blocked" } })).toMatchObject({ phase: "failed", text: "Failed: tsc" });
    const pr_status = { repository: "acme/app", number: 12, state: "open" };
    expect(shipProgress({ session: { pr_status }, pr: { state: "open", checks: [{ name: "ci", status: "in_progress" }] } }).phase).toBe("checks");
    expect(shipProgress({ session: { pr_status }, pr: { state: "open", checks: [{ name: "lint", status: "completed", conclusion: "failure" }] } })).toMatchObject({ phase: "failed", text: "Failed: lint" });
    expect(shipProgress({ session: { pr_status }, pr: { state: "open", checks: [{ name: "ci", status: "completed", conclusion: "success" }] } }).phase).toBe("pr_open");
    expect(shipProgress({ session: { pr_status: { ...pr_status, state: "merged" } } }).phase).toBe("merged");
  });
});
