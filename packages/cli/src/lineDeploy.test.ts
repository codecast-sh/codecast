import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkflowSource, validateWorkflow } from "./workflow/parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow/templates";
import { spawnSync } from "node:child_process";
import { deployEnv, deployFailureSignal, devPushLine, expandDeployCommand, failedStep, followJobs, formatDeploy, formatTargets, jobsVerdict, pinnedSha, returnDeploy, runDeployStep, waitForCi, watchDeploy } from "./lineDeploy";
import { askUntilRead, releaseRequest, requestShaFor } from "./deployCommand";

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
    expect(order).toEqual(["ci", "send", "gate", "rollout", "live", "finish", "watch"]);
    for (const s of ["ci", "send", "gate", "rollout", "live", "finish"]) expect(next(s, "failure")).toBe("returned");
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
  test("finish runs on a live deploy with the version that went out, and marks a marker target live first", async () => {
    const live = fakeServer({ sha: "abc1234def", status: "live", version: "1.2.3" });
    const out: string[] = [];
    const r = await runDeployStep({ step: "finish", deploy: "dp-3", root: tmp(), profile: { command: "x", finish: "echo floor $version $CAST_DEPLOY_VERSION" }, read: live.read, post: live.post, log: (l) => out.push(l) });
    expect(r.code).toBe(0);
    expect(out.join("")).toContain("floor 1.2.3 1.2.3");
    expect(live.posts).toEqual([]);

    const marker = fakeServer({ sha: "abc1234def", status: "running" });
    await runDeployStep({ step: "finish", deploy: "dp-3", root: tmp(), profile: { command: "x", finish: "true" }, read: marker.read, post: marker.post, log: () => {} });
    expect(marker.posts[0][1]).toMatchObject({ status: "live", sha: "abc1234def" });
    expect(marker.row.status).toBe("live");
  });

  test("finish that needs a version refuses when none was recorded; other steps still skip a live deploy", async () => {
    const s = fakeServer({ sha: "abc1234def", status: "live" });
    const r = await runDeployStep({ step: "finish", deploy: "dp-3", root: tmp(), profile: { command: "x", finish: "cast force-update $version" }, read: s.read, post: s.post, log: () => {} });
    expect(r.code).toBe(1);
    expect(r.note).toContain("no version recorded");
    const send = await runDeployStep({ step: "send", deploy: "dp-3", root: tmp(), profile: { command: "exit 9" }, read: s.read, post: s.post, log: () => {} });
    expect(send.code).toBe(0);
  });

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

  test("named jobs pass when they pass, fail when one fails, and wait otherwise", () => {
    expect(jobsVerdict(jobs(["gate", "completed", "success"], ["evals", "completed", "success"]), ["gate", "evals"], false).state).toBe("passed");
    // A gate that failed leaves the rollout job skipped: the run ends failed, and no rollout happened.
    expect(jobsVerdict(jobs(["deploy", "completed", "skipped"]), ["deploy"], true, "failure")).toMatchObject({ state: "failed", detail: "deploy was skipped: the run ended failure, so a job it needs did not pass" });
    // While the run goes on (Union's finalize runs after a failed deploy), a skip cannot be told apart yet.
    expect(jobsVerdict(jobs(["deploy", "completed", "skipped"]), ["deploy"], false).state).toBe("waiting");
    // A job its workflow chose not to run (its if: said no) in a run that passed: passed, and said.
    expect(jobsVerdict(jobs(["gate", "completed", "skipped"], ["evals", "completed", "success"]), ["gate", "evals"], true, "success")).toEqual({ state: "passed", detail: "gate: skipped by the workflow, evals: success" });
    expect(jobsVerdict(jobs(["deploy", "completed", "cancelled"]), ["deploy"], true, "cancelled").state).toBe("failed");
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

  test("follow: a job the workflow skipped in a run that passed passes and says so; one the run failed past fails", async () => {
    const view = (conclusion: string, jobs: Array<[string, string]>) => JSON.stringify({ status: "completed", conclusion, jobs: jobs.map(([name, c]) => ({ name, status: "completed", conclusion: c })) });
    const out: string[] = [];
    const passed = await followJobs({ url: "https://github.com/acme/app/actions/runs/7", jobs: ["gate", "evals"], gh: () => ({ code: 0, out: view("success", [["gate", "skipped"], ["evals", "success"]]) }), sleep: async () => {}, log: (l) => out.push(l) });
    expect(passed).toBe(0);
    expect(out).toEqual(["gate: skipped by the workflow, evals: success"]);
    const failed = await followJobs({ url: "https://github.com/acme/app/actions/runs/7", jobs: ["deploy"], gh: () => ({ code: 0, out: view("failure", [["gate", "failure"], ["deploy", "skipped"]]) }), sleep: async () => {}, log: (l) => out.push(l) });
    expect(failed).toBe(1);
    expect(out.at(-1)).toBe("deploy was skipped: the run ended failure, so a job it needs did not pass");
  });

  test("ci waits for the named workflow's newest finished run on the sha", async () => {
    const lists = [[], [{ status: "completed", conclusion: "success", url: "https://ci/1", startedAt: "2026-10-22T10:00:00Z" }]];
    const code = await waitForCi({ sha: "abc1234def", workflow: "ci.yml", repo: "acme/app", gh: () => ({ code: 0, out: JSON.stringify(lists.shift()) }), sleep: async () => {}, log: () => {} });
    expect(code).toBe(0);
    const red = await waitForCi({ sha: "abc1234def", workflow: "ci.yml", repo: "acme/app", gh: () => ({ code: 0, out: JSON.stringify([{ status: "completed", conclusion: "failure", url: "https://ci/2", startedAt: "x" }]) }), sleep: async () => {}, log: () => {} });
    expect(red).toBe(1);
  });
});

describe("a deploy.toml written for a newer cast", () => {
  test("its unknown keys are named, and the targets still read", async () => {
    const { parseDeployTargetsText, deployTargetWarnings } = await import("./workspace/deployTargetsFile");
    const entries = parseDeployTargetsText(`[[target]]\nname = "production"\nrun = "./deploy.sh"\ncanary = "x"\n`, []);
    expect(entries.map((e) => e.target.name)).toEqual(["production"]);
    expect(deployTargetWarnings(entries)).toEqual([".codecast/deploy.toml: target production: 'canary' is not a key this cast reads, so it is ignored (a newer cast's step? cast update; a typo? fix it)"]);
  });
});

// `cast deploy --sha 3117e08fd` once made dp-2322 of main's head: the request named no sha, and the first step took
// origin's head. A deploy that names its sha runs every step on it.
describe("a deploy pinned to a commit", () => {
  test("every step, CI first, runs on the deploy's own sha, not origin's head", async () => {
    const s = fakeServer({ sha: "3117e08fd0000000000000000000000000000000", status: "requested" });
    const ran: string[] = [];
    const exec = async (cmd: string, env: NodeJS.ProcessEnv) => { ran.push(`${cmd} | ${env.CAST_DEPLOY_SHA}`); return 0; };
    const head = () => ({ sha: "cd98ab98c0000000000000000000000000000000", branch: "main" });
    for (const step of ["ci", "send"] as const) {
      await runDeployStep({ step, deploy: "dp-3", root: tmp(), profile: { command: "./send.sh $sha", ci: "cast line deploy ci --sha $sha" }, read: s.read, post: s.post, exec, head, log: () => {} });
    }
    expect(ran).toEqual([
      "cast line deploy ci --sha '3117e08fd0000000000000000000000000000000' | 3117e08fd0000000000000000000000000000000",
      "./send.sh '3117e08fd0000000000000000000000000000000' | 3117e08fd0000000000000000000000000000000",
    ]);
    expect(s.posts.find(([p]) => p === "/cli/line/deploy/report")?.[1]).toMatchObject({ status: "running", sha: "3117e08fd0000000000000000000000000000000" });
  });

  test("cast deploy --sha asks for that commit; with none, the server sends main's head", () => {
    expect(releaseRequest("acme/app", "cli", "3117e08fd0000000000000000000000000000000", false)).toEqual({ repository: "acme/app", target: "cli", action: "deploy", sha: "3117e08fd0000000000000000000000000000000" });
    expect(releaseRequest("acme/app", "web", null, true)).toEqual({ repository: "acme/app", target: "web", action: "deploy", here: true });
  });

  test("the named commit is read in full, and refused when it is not on origin's default branch", () => {
    const root = fs.realpathSync(tmp());
    const git = (...a: string[]) => spawnSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).stdout.trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "a");
    const a = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", a);
    git("checkout", "-q", "-b", "side");
    git("commit", "-q", "--allow-empty", "-m", "b");
    const b = git("rev-parse", "HEAD");
    expect(pinnedSha(root, a.slice(0, 9), "main")).toEqual({ sha: a });
    expect(pinnedSha(root, b.slice(0, 9), "main")).toEqual({ error: `${b.slice(0, 10)} is not on origin/main: a deploy makes a commit of the default branch live, so land it there first` });
    expect(pinnedSha(root, "0123456789", "main")).toEqual({ error: "0123456789 is not a commit in this checkout: fetch it, or name it by a longer sha" });
  });
});

describe("a release with no --sha", () => {
  test("pins the head it was planned at for a target whose command takes $sha, and nothing else", () => {
    const planned = "b".repeat(40);
    expect(requestShaFor({ command: "./deploy.sh --sha $sha" }, { pinned: null, planned, carrying: false })).toBe(planned);
    // Sends the tree it runs in: it ships what it holds, so pinning would only refuse it.
    expect(requestShaFor({ command: "scripts/cut-cli-release.sh" }, { pinned: null, planned, carrying: false })).toBeNull();
    // A change flow's Deploy: main's head, whatever it carries.
    expect(requestShaFor({ command: "./deploy.sh --sha $sha" }, { pinned: null, planned, carrying: true })).toBeNull();
    // --sha names the commit for every target; the server refuses a tree-sending one it cannot send.
    expect(requestShaFor({ command: "scripts/cut-cli-release.sh" }, { pinned: "c".repeat(40), planned, carrying: false })).toBe("c".repeat(40));
  });

  test("a head codecast has not read yet is asked for again, up to the wait; any other refusal is not", async () => {
    let t = 0;
    let calls = 0;
    const log: string[] = [];
    const notYet = new Error("bbbb is not a commit on acme/app's default branch as codecast has read it: push it ...");
    const ask = async () => { calls++; if (calls < 3) throw notYet; return { short_id: "dp-9" }; };
    expect(await askUntilRead(ask, { sleep: async (ms) => { t += ms; }, now: () => t, log: (l) => log.push(l) })).toEqual({ short_id: "dp-9" });
    expect([calls, t, log.length]).toEqual([3, 20_000, 1]);
    t = 0;
    await expect(askUntilRead(async () => { throw notYet; }, { sleep: async (ms) => { t += ms; }, now: () => t })).rejects.toThrow("as codecast has read it");
    expect(t).toBe(120_000);
    let other = 0;
    await expect(askUntilRead(async () => { other++; throw new Error("dp-8 is already going out to cli"); }, { sleep: async () => {}, now: () => 0 })).rejects.toThrow("already going out");
    expect(other).toBe(1);
  });
});

describe("cast line deploy show", () => {
  const base = { short_id: "dp-9", target: "backend", sha: "7975db5eed352f8839223ea71023225380a5af86", status: "live", live_at: 1, trigger: "outside", source: "cast ship mark", started_by: { name: "Ashot" }, carries: [] };

  test("a push from uncommitted files says so, with where it came from and what it changed", () => {
    const text = formatDeploy({ ...base, dirty: 78, pushed_via: "deploy.sh", machine: "MacBook-Pro-182", adds: ["table:voiceprints", "index:voiceprints.by_user"], drops: ["fn:old:gone"] });
    expect(text).toContain("pushed by deploy.sh on MacBook-Pro-182 · 78 uncommitted files went out with 7975db5");
    expect(text).toContain("added 2\n  table:voiceprints\n  index:voiceprints.by_user");
    expect(text).toContain("dropped 1\n  fn:old:gone");
  });

  test("a clean deploy reads as before", () => {
    const text = formatDeploy(base);
    expect(text).not.toContain("pushed");
    expect(text).not.toContain("added");
    expect(text).toContain("carried 0");
  });

  test("a long list is cut at twenty", () => {
    const adds = Array.from({ length: 25 }, (_, i) => `fn:m:f${i}`);
    expect(formatDeploy({ ...base, adds })).toContain("… and 5 more");
  });
});

describe("cast line deploy targets", () => {
  const NOW = 1_700_000_000_000;
  const queue = { known: true, commits: 0, untouched: 0, groups: [], shown: 0, head_ci: "passed" };
  const live = { short_id: "dp-9", sha: "7975db5eed352f88", live_at: NOW - 3_600_000, created_at: NOW - 3_600_000 };
  const push = { sha: "1a2b3c4d5e", machine: "ana-mac", by: "Ana", at: NOW - 3 * 60_000, dirty: 2, adds_count: 0, drops_count: 0 };

  test("a dev push on top of the live deploy reads as one line under it", () => {
    const lines = formatTargets({ targets: [{ name: "backend", live, open: null, queue, dev_push: push }] }, NOW).split("\n");
    expect(lines[0]).toStartWith("backend  live: dp-9 7975db5ee");
    expect(lines[1]).toBe("  uncommitted push · ana-mac · Ana · 3m ago · 2 files");
    expect(lines[2]).toBe("  nothing waiting");
  });

  test("with no dev push, nothing is added", () => {
    expect(formatTargets({ targets: [{ name: "backend", live, open: null, queue, dev_push: null }] }, NOW)).not.toContain("push");
  });

  test("what the push added and dropped, and a clean tree's sha", () => {
    expect(devPushLine({ ...push, by: null, adds_count: 1, drops_count: 2 }, NOW)).toBe("uncommitted push · ana-mac · 3m ago · 2 files · added 1 · dropped 2");
    expect(devPushLine({ ...push, dirty: 0, at: NOW - 5_000 }, NOW)).toBe("dev push of 1a2b3c4 · ana-mac · Ana · just now");
  });
});
