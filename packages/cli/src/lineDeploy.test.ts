import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deployEnv, expandDeployCommand, runDeploy } from "./lineDeploy";

// The line's deploy stage, run here (deploys.md DP2): the team's deploy path
// runs with no model keys, reports running then live or failed.

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

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "line-deploy-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf-8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  return dir;
}

describe("running a deploy", () => {
  test("reports running, then live, and names the run a path prints", async () => {
    const posts: any[] = [];
    const r = await runDeploy({
      root: repo(), deploy: "dp-3", command: "echo going; echo https://github.com/acme/app/actions/runs/42", actor: "Ana",
      post: async (p, b) => { posts.push([p, b]); return {}; }, log: () => {},
    });
    expect(r.status).toBe("live");
    expect(posts.map(([, b]) => b.status)).toEqual(["running", "live"]);
    expect(posts[1][1].url).toBe("https://github.com/acme/app/actions/runs/42");
  });

  test("a path that exits non-zero fails the deploy with its output's tail", async () => {
    const posts: any[] = [];
    const r = await runDeploy({ root: repo(), deploy: "dp-4", command: "echo broke >&2; exit 3", actor: "Ana", post: async (p, b) => { posts.push(b); return {}; }, log: () => {} });
    expect(r.status).toBe("failed");
    expect(posts[1]).toMatchObject({ status: "failed" });
    expect(posts[1].note).toContain("exited 3");
    expect(posts[1].note).toContain("broke");
  });

  test("a model key in this shell does not reach the deploy path", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-not-real";
    try {
      const r = await runDeploy({ root: repo(), deploy: "dp-5", command: 'test -z "$OPENROUTER_API_KEY"', actor: "Ana", post: async () => ({}), log: () => {} });
      expect(r.status).toBe("live");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});
