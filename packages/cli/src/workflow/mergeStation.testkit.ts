// The Merge station's test world: a real bare origin, a clone the change is
// built in, a fake `gh` on PATH that merges the way GitHub does (a squash of
// the PR head onto main, refusing a head that is not the one named), and a
// scripted server.
import { spawnSync } from "../proc.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExec, type Exec } from "../lineMerge";
import { runMergeStation, type MergeStationArgs } from "./mergeStation";
import type { ScratchTree } from "./mergeScratch";

export const BRANCH = "change";
export const PR = 7;
export const PR_URL = `https://github.com/o/r/pull/${PR}`;
export const T = { timeout: 60_000 };

// GitHub, as far as the station sees it: `pr view` reads the PR's state from a JSON file and its head from the
// origin; `pr merge` squashes the branch onto main in a scratch clone and pushes, unless the file says to lie.
// `advance` lands someone else's commit on main just before the squash, as a merge racing this one would, and
// `after` one just after it.
const FAKE_GH = `
const [stateFile, origin, ...args] = process.argv.slice(2);
const spawnSync = (cmd, args, o = {}) => { const r = Bun.spawnSync([cmd, ...args], { cwd: o.cwd }); return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; };
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=GitHub", "-c", "user.email=gh@example.com", ...a], { cwd, encoding: "utf-8" });
  if (r.status !== 0) { process.stderr.write("git " + a.join(" ") + ": " + r.stderr); process.exit(1); }
  return r.stdout.trim();
};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
state.calls.push(args); save();
const head = () => spawnSync("git", ["--git-dir", origin, "rev-parse", "refs/heads/${BRANCH}"], { encoding: "utf-8" }).stdout.trim();
if (args[0] === "pr" && args[1] === "view") {
  const out = { state: state.state, headRefOid: state.state === "MERGED" ? state.head : head(), url: "${PR_URL}", mergeCommit: state.mergeCommit ? { oid: state.mergeCommit } : null };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "merge") {
  if (args.includes("--admin")) { process.stderr.write("--admin is never used"); process.exit(1); }
  const named = args[args.indexOf("--match-head-commit") + 1];
  state.head = head();
  if (state.lie) { state.state = "MERGED"; state.mergeCommit = state.head; save(); process.exit(0); }
  if (named !== state.head) { process.stderr.write("Head branch was modified. Review and try the merge again."); process.exit(1); }
  const dir = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "fake-gh-"));
  git(dir, "clone", "-q", origin, "m");
  const m = dir + "/m";
  if (state.advance) {
    fs.mkdirSync(require("node:path").dirname(m + "/" + state.advance.file), { recursive: true });
    fs.writeFileSync(m + "/" + state.advance.file, state.advance.text);
    git(m, "add", state.advance.file);
    git(m, "commit", "-q", "-m", "racing: " + state.advance.file);
  }
  git(m, "merge", "-q", "--squash", "origin/${BRANCH}");
  const body = args.includes("--body") ? args[args.indexOf("--body") + 1] : "";
  git(m, "commit", "-q", "-m", "Squashed (#${PR})" + (body ? "\\n\\n" + body : ""));
  git(m, "push", "-q", "origin", "HEAD:main", ":refs/heads/${BRANCH}");
  state.state = "MERGED"; state.mergeCommit = git(m, "rev-parse", "HEAD"); save();
  if (state.after) {
    fs.writeFileSync(m + "/" + state.after.file, state.after.text);
    git(m, "add", state.after.file);
    git(m, "commit", "-q", "-m", "after: " + state.after.file);
    git(m, "push", "-q", "origin", "HEAD:main");
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.stderr.write("fake gh does not know " + args.join(" ")); process.exit(1);
`;

type Post = { path: string; body: any };

export function setup(opts: { lie?: boolean; advance?: { file: string; text: string }; after?: { file: string; text: string } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "merge-station-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const runDir = join(root, "run");
  const bin = join(root, "bin");
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (dir: string, file: string, text: string) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  for (const [k, v] of [["user.name", "Builder"], ["user.email", "builder@example.com"]]) git(work, "config", k, v);
  const commit = (file: string, text: string, message: string) => {
    write(work, file, text);
    git(work, "add", file);
    git(work, "commit", "-q", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };
  const numbered = (n: number, edit?: [number, string]) => Array.from({ length: n }, (_, i) => (edit && edit[0] === i ? edit[1] : `line ${i}`)).join("\n") + "\n";
  commit("a.txt", "one\n", "start");
  commit("shared.txt", numbered(40), "shared");
  git(work, "push", "-q", "origin", "main");
  let mainSha = git(work, "rev-parse", "HEAD");
  /** Files committed straight to main (the line profile, say); returns main's new head. */
  const onMain = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) { write(work, f, t); git(work, "add", f); }
    git(work, "commit", "-q", "-m", "profile");
    git(work, "push", "-q", "origin", "main");
    return (mainSha = git(work, "rev-parse", "HEAD"));
  };
  /** The change: a branch off main, pushed (what the PR station leaves). */
  const branch = (file: string, text: string, message = `change: ${file}`) => {
    git(work, "checkout", "-q", "-b", BRANCH);
    const sha = commit(file, text, message);
    git(work, "push", "-q", "origin", BRANCH);
    git(work, "checkout", "-q", "main");
    return sha;
  };
  /** Someone else's commit lands on main. */
  let n = 0;
  const advanceMain = (file: string, text: string, message = `main: ${file}`) => {
    const other = join(root, `other-${n++}`);
    git(root, "clone", "-q", origin, other);
    write(other, file, text);
    git(other, "add", file);
    git(other, "-c", "user.name=Teammate", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
    git(other, "push", "-q", "origin", "main");
    return git(other, "rev-parse", "HEAD");
  };

  const stateFile = join(root, "gh-state.json");
  writeFileSync(stateFile, JSON.stringify({ state: "OPEN", calls: [], ...(opts.lie ? { lie: true } : {}), ...(opts.advance ? { advance: opts.advance } : {}), ...(opts.after ? { after: opts.after } : {}) }));
  mkdirSync(bin);
  writeFileSync(join(root, "fake-gh.js"), FAKE_GH);
  writeFileSync(join(bin, "gh"), `#!/bin/bash\nexec bun ${JSON.stringify(join(root, "fake-gh.js"))} ${JSON.stringify(stateFile)} ${JSON.stringify(origin)} "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const exec: Exec = (cmd, args, cwd, env) => defaultExec(cmd, args, cwd, { ...env, PATH: `${bin}:${process.env.PATH}` });
  const gh = () => JSON.parse(readFileSync(stateFile, "utf-8")) as { calls: string[][]; state: string; mergeCommit?: string };

  mkdirSync(runDir);
  /** CI's verdict: green on `head`, tested against main as it stands unless told otherwise; the reviewer read `head`
   *  and said ship unless told otherwise. */
  const ci = (head: string, tested = mainSha, extra: Record<string, unknown> = {}, reviewed = head) => {
    writeFileSync(join(runDir, "ci.json"), JSON.stringify({ green: true, head_sha: head, tested_main_sha: tested, failing: [], preexisting: [], reran: false, timed_out: false, ...extra }));
    writeFileSync(join(runDir, "review.json"), JSON.stringify({ verdict: "ship", head_sha: reviewed, round: "r1", findings: [] }));
    proof.review = { verdict: "ship", head_sha: reviewed, node_id: "review" };
  };
  /** What the server holds for the run: the reviewer's recorded verdict and head, and the recorded rebase links. */
  const proof: { review: { verdict: string; head_sha: string; node_id: string } | null; rebases: Array<{ from: string; to: string }> } = { review: null, rebases: [] };

  // A plain detached worktree in place of an acquired one: the station's own scratch checkout, removed after.
  const trees: string[] = [];
  const scratch = async (repo: string, at: string): Promise<ScratchTree> => {
    const path = join(root, `tree-${trees.length}`);
    git(repo, "worktree", "add", "-q", "--detach", path, at);
    trees.push(path);
    return { path, setup: async () => {}, release: async () => { git(repo, "worktree", "remove", "--force", path); } };
  };

  const posts: Post[] = [];
  const answers: Record<string, (body: any) => any> = {
    "/cli/workflow-runs/clear": () => ({ node_id: "merge" }),
    "/cli/line/merge/check": () => ({ allowed: true, reason: null }),
    "/cli/line/merge/record": () => ({ used: 0, limit: null }),
    "/cli/deploys/ship-pass": () => ({ pass: "p1", deploys: [] }),
    "/cli/repo-lease": (body) => (body.op === "release" ? { released: true } : { held: true, expires_at: Date.now() + 600_000 }),
    "/cli/workflow-runs/rebase": (body) => { proof.rebases.push({ from: body.from, to: body.to }); return { attempt: 1 }; },
    "/cli/workflow-runs/merge-proof": () => structuredClone(proof),
    "/cli/model/call": () => { throw new Error("no model in this test"); },
  };
  const post = async (path: string, body: any) => { posts.push({ path, body: structuredClone(body) }); return answers[path](body); };
  const logged: string[] = [];
  const run = (extra: Partial<MergeStationArgs> = {}) =>
    runMergeStation({ cwd: work, pr: PR, branch: BRANCH, runDir, runId: "run_1", into: "main", repository: "o/r", post, exec, scratch, wait: () => {}, log: (l) => logged.push(l), ...extra });
  const originMain = () => git(root, "--git-dir", origin, "rev-parse", "refs/heads/main");
  const originBranch = () => spawnSync("git", ["--git-dir", origin, "rev-parse", "-q", "--verify", `refs/heads/${BRANCH}`], { encoding: "utf-8" }).stdout.trim();
  const merged = () => gh().calls.some((c) => c[0] === "pr" && c[1] === "merge");
  /** A line profile whose before-merge step `name` deploys api/**, sending the deploy target `backend`. */
  const profile = (run: string, name = "convex") => onMain({
    ".codecast/workspace.toml": `[[ship.deploy]]\nname = "${name}"\nwhen = ["api/**"]\nrun = ${JSON.stringify(run)}\nstage = "before_push"\n`,
    ".codecast/deploy.toml": `[[target]]\nname = "backend"\nship = "${name}"\nlive = "marker"\npolicy = "release"\n`,
  });
  return { root, work, runDir, origin, git, write, commit, numbered, branch, advanceMain, onMain, profile, ci, proof, answers, posts, logged, run, gh, merged, originMain, originBranch, trees, exec,
    main: () => mainSha, done: () => rmSync(root, { recursive: true, force: true }) };
}
