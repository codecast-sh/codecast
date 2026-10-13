import { describe, expect, test } from "bun:test";
import { actionsRun, namedChecks } from "./lineFixChecks";

const check = (name: string, conclusion: string | undefined, status = "completed") => ({ name, status, conclusion, updated_at: 0, url: `https://gh/${name}` });

describe("a fix commit answers for the checks the problem's CI run failed", () => {
  test("a finding's Actions run link names its repository and run", () => {
    expect(actionsRun("https://github.com/Union-AI/union-mobile/actions/runs/38315407325")).toEqual({ repository: "Union-AI/union-mobile", run_id: "38315407325" });
    expect(actionsRun("https://github.com/Union-AI/union-mobile/pull/3")).toBeNull();
  });
  test("ct-59687: `test` failed on ac5c98b; on fc0d85b it passed, and a Vercel deploy's red is another check", () => {
    const checks = [check("test", "success"), check("evals", "success"), check("checks", "skipped"), check("outreach-dashboard - aivery-app", "failure")];
    const { named, others } = namedChecks(checks, ["test"]);
    expect(named).toEqual([{ name: "test", ok: true, url: "https://gh/test" }]);
    expect(others.map((c) => c.name)).toEqual(["evals", "checks", "outreach-dashboard - aivery-app"]);
  });
  test("a check the fix commit skipped, did not run, or is still running answers nothing yet", () => {
    expect(namedChecks([check("test", "skipped")], ["test"]).named[0].ok).toBeNull();
    expect(namedChecks([check("test", undefined, "in_progress")], ["test"]).named[0].ok).toBeNull();
    expect(namedChecks([], ["test"]).named[0].ok).toBeNull();
    expect(namedChecks([check("test", "failure")], ["test"]).named[0].ok).toBe(false);
  });
});
