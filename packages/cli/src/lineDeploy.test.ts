import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkflowSource, validateWorkflow } from "./workflow/parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow/templates";
import { deployEnv, deployFailureSignal, expandDeployCommand, failedStep, followJobs, jobsVerdict, returnDeploy, runDeployStep, waitForCi, watchDeploy } from "./lineDeploy";

// The line's deploy stage (deploys.md DP2, DP8, DP9): each step runs a
// profile command with no model keys, judges one sha, and a failed one comes
// back to the line as a finding. Synthetic data only.

describe("the deploy path's environment", () => {
  test("model and cloud keys never reach the deploy path; the deploy's own vars do", () => {
    const env = deployEnv({ PATH: "/bin", OPENROUTER_API_KEY: "x", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "x", FAL_KEY: "x", GH_TOKEN: "keep" }, { id: "dp-3", sha: "abc" });
    expect(Object.keys(env).sort()).toEqual(["CAST_DEPLOY_ID", "CAST_DEPLOY_SHA", "GH_TOKEN", "PATH"]);
  });

  test("$sha, $deploy and $actor expand quoted", () => {
    expect(expandDeployCommand("./deploy.sh --sha $sha --actor $actor # $deploy", { sha: "abc", deploy: "dp-3", actor: "Ana O'Neil" }))
      .toBe(`./deploy.sh --sha 'abc' --actor 'Ana O'\\''Neil' # 'dp-3'`);
  });
});

describe("the line-deploy graph", () => {
  test("is shipped, valid, runs the steps in order and sends every failure back to the line", () => {
    const g = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES["line-deploy"]);
    expect(validateWorkflow(g)).toEqual([]);
    const next = (from: string, outcome: string) => g.edges.find((e) => e.from === from && e.condition === `outcome = ${outcome}`)?.to;
    const order = ["ci"];
    while (next(order[order.length - 1], "success")) order.push(next(order[order.length - 1], "success")!);
    expect(order).toEqual(["ci", "send", "gate", "rollout", "live", "watch"]);
    for (const s of ["ci", "send", "gate", "rollout", "live"]) expect(next(s, "failure")).toBe("returned");
  });
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "line-deploy-"));

function fakeServer(deploy: Record<string, any>) {
  const posts: Array<[string, any]> = [];
  const row: Record<string, any> = { short_id: "dp-3", status: "requested", target: "production", carries: [], started_by: { name: "@release" }, ...deploy };
  const post = async (p: string, b: any) => {
    posts.push([p, b]);
    if (p === "/cli/line/deploy/report") {
      if (b.sha && !row.sha) row.sha = b.sha;
      if (b.url) row.url = b.url;
      if (b.run_id && !row.run_id) row.run_id = b.run_id;
      if (["requested", "running"].includes(row.status)) row.status = b.status;
    }
    if (p === "/cli/signal/add") return { short_id: "sg-1", task_short_id: "ct-90" };
    return {};
  };
  return { row, posts, post, read: async () => ({ ...row }) };
}

describe("a deploy step", () => {
  test("the first step fixes the sha and names the run; the next reads that sha back", async () => {
    const s = fakeServer({});
    const out: string[] = [];
    const ci = await runDeployStep({ step: "ci", deploy: "dp-3", root: tmp(), profile: { command: "x", ci: "echo ci on $sha" }, runId: "run_9", read: s.read, post: s.post, log: (l) => out.push(l), head: () => ({ sha: "abc1234def", branch: "main" }) });
    expect(ci.code).toBe(0);
    expect(out.join("")).toContain("ci on abc1234def");
    expect(s.posts[0][1]).toMatchObject({ status: "running", sha: "abc1234def", run_id: "run_9" });
    const send = await runDeployStep({ step: "send", deploy: "dp-3", root: tmp(), profile: { command: "echo $CAST_DEPLOY_SHA; echo https://github.com/acme/app/actions/runs/42" }, read: s.read, post: s.post, log: () => {}, head: () => ({ sha: "fffffff000", branch: "main" }) });
    expect(send.code).toBe(0);
    expect(s.row.url).toBe("https://github.com/acme/app/actions/runs/42");
    expect(s.row.sha).toBe("abc1234def");
  });

  test("a step the profile leaves out passes with a note, and a red one fails with its tail", async () => {
    const s = fakeServer({ sha: "abc1234def", status: "running", run_id: "r" });
    const gate = await runDeployStep({ step: "gate", deploy: "dp-3", root: tmp(), profile: { command: "x" }, read: s.read, post: s.post, log: () => {} });
    expect(gate).toEqual({ code: 0, note: "No gate in [line.deploy]: Gate passes." });
    const live = await runDeployStep({ step: "live", deploy: "dp-3", root: tmp(), profile: { command: "x", live: "echo not yet >&2; exit 4" }, read: s.read, post: s.post, log: () => {} });
    expect(live.code).toBe(4);
    expect(live.note).toContain("not yet");
  });

  test("a model key in this shell does not reach a step", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-not-real";
    try {
      const s = fakeServer({ sha: "abc1234def", status: "running", run_id: "r" });
      const r = await runDeployStep({ step: "live", deploy: "dp-3", root: tmp(), profile: { command: "x", live: 'test -z "$OPENROUTER_API_KEY"' }, read: s.read, post: s.post, log: () => {} });
      expect(r.code).toBe(0);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});

describe("watch and return", () => {
  test("the watch station reports live with the profile's watch days", async () => {
    const s = fakeServer({ sha: "abc1234def", status: "running", carries: [{ task_id: "t" }] });
    expect(await watchDeploy({ deploy: "dp-3", watchDays: 7, read: s.read, post: s.post })).toContain("watched for 7 days");
    expect(s.posts[0][1]).toMatchObject({ status: "live", watch_days: 7 });
  });

  test("a failed step marks the deploy failed and files one finding per project, target and step", async () => {
    const s = fakeServer({ sha: "abc1234def", status: "running", project_id: "proj_1", url: "https://github.com/acme/app/actions/runs/42", carries: [{ task_id: "t", task_short_id: "ct-1", task_title: "Totals" }] });
    const run = { run: { node_statuses: [{ node_id: "ci", status: "completed" }, { node_id: "send", status: "completed" }, { node_id: "gate", status: "failed" }, { node_id: "returned", status: "running" }] } };
    const r = await returnDeploy({ deploy: "dp-3", runId: "r", note: "gate refused: 3 cases moved", scope: { workspace: "team", team_id: "team_1" }, read: s.read, readRun: async () => run, post: s.post });
    expect(r.step).toBe("gate");
    const [, failed] = s.posts.find(([p]) => p === "/cli/line/deploy/report")!;
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.note).toContain("Stopped at Gate");
    const [, signal] = s.posts.find(([p]) => p === "/cli/signal/add")!;
    expect(signal).toMatchObject({ source: "deploy", kind: "regression", issue: true, fingerprint: "deploy:proj_1:production:gate", title: "Deploy to production stopped at Gate", project: "proj_1", team_id: "team_1", evidence_url: "https://github.com/acme/app/actions/runs/42" });
    expect(signal.detail_md).toContain("ct-1 Totals");
    expect(signal.detail_md).toContain("3 cases moved");
  });

  test("the failed step is the last failed station before Returned", () => {
    expect(failedStep([{ node_id: "ci", status: "failed" }, { node_id: "ci", status: "completed" }, { node_id: "live", status: "failed" }])).toBe("live");
    expect(failedStep([])).toBeNull();
    expect(deployFailureSignal({ short_id: "dp-1", target: "backend" }, null, null).fingerprint).toBe("deploy:workspace:backend:step");
  });
});

describe("following the deploy path's own run", () => {
  const jobs = (...j: Array<[string, string, string | null]>) => j.map(([name, status, conclusion]) => ({ name, status, conclusion, databaseId: 7 }));

  test("named jobs pass when they pass or are skipped, fail when one fails, and wait otherwise", () => {
    expect(jobsVerdict(jobs(["gate", "completed", "success"], ["evals", "completed", "skipped"]), ["gate", "evals"], false).state).toBe("passed");
    expect(jobsVerdict(jobs(["gate", "completed", "success"], ["evals", "in_progress", null]), ["gate", "evals"], false).state).toBe("waiting");
    expect(jobsVerdict(jobs(["gate", "completed", "failure"]), ["gate", "evals"], false)).toMatchObject({ state: "failed" });
    expect(jobsVerdict(jobs(["gate", "completed", "success"]), ["gate", "evals"], true)).toMatchObject({ state: "failed", detail: "the run finished with no job named evals" });
  });

  test("follow polls the run until its jobs settle, and prints a failed job's log", async () => {
    const views = [
      { status: "in_progress", jobs: jobs(["deploy", "queued", null]) },
      { status: "completed", jobs: jobs(["deploy", "completed", "failure"]) },
    ];
    const calls: string[][] = [];
    const out: string[] = [];
    const gh = (args: string[]) => { calls.push(args); return args.includes("--log-failed") ? { code: 0, out: "verify: health never reported the sha" } : { code: 0, out: JSON.stringify(views.shift()) }; };
    const code = await followJobs({ url: "https://github.com/acme/app/actions/runs/42", jobs: ["deploy"], gh, sleep: async () => {}, log: (l) => out.push(l) });
    expect(code).toBe(1);
    expect(calls[0]).toEqual(["run", "view", "42", "--repo", "acme/app", "--json", "status,conclusion,jobs"]);
    expect(out.join("\n")).toContain("health never reported the sha");
    expect(await followJobs({ url: null, jobs: ["deploy"], gh, log: () => {} })).toBe(1);
  });

  test("ci waits for the named workflow's newest finished run on the sha", async () => {
    const lists = [[], [{ status: "completed", conclusion: "success", url: "https://ci/1", startedAt: "2026-10-22T10:00:00Z" }]];
    const code = await waitForCi({ sha: "abc1234def", workflow: "ci.yml", repo: "acme/app", gh: () => ({ code: 0, out: JSON.stringify(lists.shift()) }), sleep: async () => {}, log: () => {} });
    expect(code).toBe(0);
    const red = await waitForCi({ sha: "abc1234def", workflow: "ci.yml", repo: "acme/app", gh: () => ({ code: 0, out: JSON.stringify([{ status: "completed", conclusion: "failure", url: "https://ci/2", startedAt: "x" }]) }), sleep: async () => {}, log: () => {} });
    expect(red).toBe(1);
  });
});
