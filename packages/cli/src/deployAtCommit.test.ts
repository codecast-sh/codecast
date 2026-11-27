// A deploy step in a checkout behind the deploy's commit runs what that commit declares (deployAtCommit.ts): dp-3789
// ran a behind checkout's send script, which refused while a release was in flight where main's waits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandAtCommit } from "./deployAtCommit";
import { deployProfileFor, runDeployStep } from "./lineDeploy";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: os.tmpdir() };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: ENV, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string, mode = 0o644) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text, { mode }); };

const TARGETS = (run: string) => `[[target]]\nname = "cli"\nrun = "${run}"\npolicy = "release"\n`;
let dir = "", checkout = "", other = "", old = "", landed = "";
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-deploy-at-")));
  checkout = path.join(dir, "checkout");
  fs.mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  write(checkout, "scripts/send.sh", "#!/bin/bash\necho \"old send from $0 for $1\"\nexit 1\n", 0o755);
  write(checkout, "scripts/send.py", "#!/usr/bin/env python3\nprint('old')\n", 0o755);
  write(checkout, ".codecast/deploy.toml", TARGETS("scripts/send.sh"));
  git(checkout, "add", "-A");
  git(checkout, "commit", "-qm", "base");
  old = git(checkout, "rev-parse", "HEAD");
  // main moves on elsewhere; the checkout fetches it but stays where it is (others' edits keep it from levelling).
  other = path.join(dir, "other");
  git(dir, "clone", "-q", checkout, other);
  git(checkout, "remote", "add", "origin", other);
  write(other, "scripts/send.sh", "#!/bin/bash\necho \"new send from $0 for $1 at $CAST_DEPLOY_SHA\"\n", 0o755);
  write(other, "scripts/send.py", "#!/usr/bin/env python3\nprint('new')\n", 0o755);
  write(other, ".codecast/deploy.toml", TARGETS("scripts/send.sh $sha"));
  git(other, "commit", "-qam", "send waits");
  landed = git(other, "rev-parse", "HEAD");
  git(checkout, "fetch", "-q", "origin");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a deploy step in a checkout behind its commit", () => {
  test("runs the commit's copy of a shell script, from the checkout's root with $0 its path", async () => {
    const at = await commandAtCommit(checkout, landed, "scripts/send.sh 'abc'");
    expect(at.command).toBe(`bash -c "$CAST_DEPLOY_SCRIPT" 'scripts/send.sh' 'abc'`);
    expect(at.said).toContain(`behind ${landed.slice(0, 7)}`);
    const out = execFileSync("bash", ["-c", at.command], { cwd: checkout, env: { ...process.env, ...at.env }, encoding: "utf8" });
    expect(out.trim()).toBe("new send from scripts/send.sh for abc at");
  });

  test("leaves a command alone when the checkout holds the commit, the copy matches, or it is no shell script", async () => {
    expect((await commandAtCommit(checkout, old, "scripts/send.sh")).command).toBe("scripts/send.sh");
    expect((await commandAtCommit(checkout, landed, "cast force-update 1.2.3")).command).toBe("cast force-update 1.2.3");
    expect((await commandAtCommit(checkout, landed, "./missing.sh")).command).toBe("./missing.sh");
    const py = await commandAtCommit(checkout, landed, "scripts/send.py");
    expect(py.command).toBe("scripts/send.py");
    expect(py.said).toContain("not a shell script");
    expect((await commandAtCommit(checkout, "f".repeat(40), "scripts/send.sh")).command).toBe("scripts/send.sh");
  });

  test("a commit the checkout has not fetched is fetched first; one origin lacks is said plainly", async () => {
    write(other, "scripts/send.sh", "#!/bin/bash\necho newest\n", 0o755);
    git(other, "commit", "-qam", "newer");
    const newest = git(other, "rev-parse", "HEAD");
    const at = await commandAtCommit(checkout, newest, "scripts/send.sh");
    expect(at.env.CAST_DEPLOY_SCRIPT).toContain("echo newest");
    const gone = await commandAtCommit(checkout, "e".repeat(40), "scripts/send.sh");
    expect(gone.command).toBe("scripts/send.sh");
    expect(gone.said).toContain("cannot fetch it from origin");
    git(other, "reset", "-q", "--hard", landed);
  });

  test("a script that runs itself again from disk is not said to run as the commit has it", async () => {
    write(other, "scripts/deploy.sh", "#!/bin/bash\n[ -t 0 ] || exec bun run.ts -- \"$PWD/deploy.sh\" \"$@\"\necho deploy\n", 0o755);
    git(other, "add", "-A");
    git(other, "commit", "-qm", "deploy.sh");
    const withDeploy = git(other, "rev-parse", "HEAD");
    write(checkout, "scripts/deploy.sh", "#!/bin/bash\necho old\n", 0o755);
    const at = await commandAtCommit(checkout, withDeploy, "scripts/deploy.sh");
    expect(at.said).toContain("runs itself again from this checkout's copy");
    fs.rmSync(path.join(checkout, "scripts/deploy.sh"));
    git(other, "reset", "-q", "--hard", landed);
  });

  test("a deploy that names no commit yet reads the target as origin's head declares it", async () => {
    // The commit renamed nothing here, but its run line differs from the checkout's: origin's head is the authority.
    expect((await deployProfileFor({ target: "cli", action: "deploy", sha: null }, checkout)).profile?.command).toBe("scripts/send.sh $sha");
  });

  test("the send reads the target from the commit's deploy.toml and runs the commit's script", async () => {
    const { profile } = await deployProfileFor({ target: "cli", action: "deploy", sha: landed }, checkout);
    expect(profile?.command).toBe("scripts/send.sh $sha");
    expect((await deployProfileFor({ target: "cli", action: "deploy", sha: old }, checkout)).profile?.command).toBe("scripts/send.sh");
    const posts: any[] = [];
    const row = { short_id: "dp-9", status: "running", target: "cli", sha: landed, started_by: { name: "t" } };
    const out: string[] = [];
    const r = await runDeployStep({ step: "send", deploy: "dp-9", root: checkout, profile, read: async () => row, post: async (_p, b) => { posts.push(b); return {}; }, log: (l) => out.push(l) });
    expect(r.code).toBe(0);
    expect(out.join("")).toContain(`new send from scripts/send.sh for ${landed} at ${landed}`);
  });
});
