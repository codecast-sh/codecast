import { describe, expect, test } from "bun:test";
import { actionsRun, filesOnBoth, firstCarrying, namedChecks } from "./lineFixChecks";

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

describe("since which deploy a commit is in production (ct-58847: #3850)", () => {
  // The real order around Oct 10: 64b0d43e8 does not contain e14601a557, 2b488df70 and every later deploy does.
  const deploys = ["6339c3b28", "e280e423e", "64b0d43e8", "2b488df70", "0dc60c5fe", "749b15f1b", "9eab5b625", "fc0d85ba6"];
  const carriesFrom = (i: number) => { const asked: string[] = []; return { asked, carries: async (d: string) => { asked.push(d); return deploys.indexOf(d) >= i; } }; };
  test("the first deploy that carries it, asking a few, not every one", async () => {
    const c = carriesFrom(3);
    expect(await firstCarrying(deploys, c.carries)).toBe("2b488df70");
    expect(c.asked.length).toBeLessThanOrEqual(4);
  });
  test("none when the newest deploy does not carry it; the first when all do", async () => {
    expect(await firstCarrying(deploys, carriesFrom(99).carries)).toBeNull();
    expect(await firstCarrying(deploys, carriesFrom(0).carries)).toBe("6339c3b28");
    expect(await firstCarrying([], carriesFrom(0).carries)).toBeNull();
  });
});

describe("filesOnBoth", () => {
  test("names the branch's files the base changed too, in the branch's order", () => {
    expect(filesOnBoth([{ filename: "a.ts" }, { filename: "b.ts" }, { filename: "c.ts" }], [{ filename: "c.ts" }, { filename: "a.ts" }, { filename: "z.ts" }])).toEqual(["a.ts", "c.ts"]);
    expect(filesOnBoth([{ filename: "a.ts" }], [])).toEqual([]);
  });
});
