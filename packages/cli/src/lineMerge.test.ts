import { describe, expect, test } from "bun:test";
import { checksGreen, mergeBranch, runMergeStep, type Exec, type MergeCheck } from "./lineMerge";

// The line's merge step (the-line.md L12), driven with a scripted git/gh and
// a scripted server: what it merges, what it leaves to a person, and that a
// refusal is one line and exit 0 rather than a failed run.

type Call = { cmd: string; args: string[] };
function scripted(answers: Record<string, { status?: number; stdout?: string; stderr?: string }>): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(" ")}`;
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
    const a = hit?.[1] ?? {};
    return { status: a.status ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { exec, calls };
}

const allowed: MergeCheck = { allowed: true, reason: null, on: true, used: 1, limit: 3, role: { handle: "growth", short_id: "or-1", name: "Growth" }, task: { short_id: "ct-7", title: "Add", pr_url: null } };

describe("checksGreen", () => {
  test("every check must conclude well; pending or failed refuses, unknown shapes refuse", () => {
    expect(checksGreen([{ name: "ci", conclusion: "SUCCESS" }, { name: "lint", conclusion: "SKIPPED" }]).green).toBe(true);
    expect(checksGreen([{ name: "ci", conclusion: "FAILURE" }])).toEqual({ green: false, detail: "ci=FAILURE" });
    expect(checksGreen([{ name: "ci", state: "PENDING" }]).green).toBe(false);
    expect(checksGreen([]).green).toBe(true);
    expect(checksGreen(undefined).green).toBe(false);
  });
});

describe("mergeBranch", () => {
  test("without a pull request: fast forward push of the branch head onto the default branch, then the branch is deleted", () => {
    const { exec, calls } = scripted({ "git rev-parse origin/codecast/line-ct-7": { stdout: "abc123def456\n" } });
    const out = mergeBranch({ cwd: "/repo", branch: "codecast/line-ct-7", into: "main", pr_url: null, exec });
    expect(out).toEqual({ kind: "merged", sha: "abc123def456", into: "main", via: "push" });
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "fetch origin codecast/line-ct-7 main",
      "rev-parse origin/codecast/line-ct-7",
      "merge-base --is-ancestor origin/main origin/codecast/line-ct-7",
      "push origin abc123def456:refs/heads/main",
      "push origin --delete codecast/line-ct-7",
    ]);
  });

  test("a branch behind the default branch is left, never merged", () => {
    const { exec, calls } = scripted({ "git rev-parse": { stdout: "abc\n" }, "git merge-base": { status: 1 } });
    const out = mergeBranch({ cwd: "/repo", branch: "b", into: "main", pr_url: null, exec });
    expect(out).toEqual({ kind: "left", reason: "b is behind main; rebase it first" });
    expect(calls.some((c) => c.args[0] === "push")).toBe(false);
  });

  test("with a pull request: checks must be green and the PR open, then gh merges with a rebase", () => {
    const pr = "https://github.com/o/r/pull/5";
    const red = scripted({ "git rev-parse": { stdout: "abc\n" }, "gh pr view": { stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] }) } });
    expect(mergeBranch({ cwd: "/repo", branch: "b", into: "main", pr_url: pr, exec: red.exec })).toEqual({ kind: "left", reason: "checks are not green: ci=FAILURE" });
    expect(red.calls.some((c) => c.args[0] === "pr" && c.args[1] === "merge")).toBe(false);

    const green = scripted({ "git rev-parse": { stdout: "abc\n" }, "gh pr view": { stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }] }) } });
    expect(mergeBranch({ cwd: "/repo", branch: "b", into: "main", pr_url: pr, exec: green.exec })).toEqual({ kind: "merged", sha: "abc", into: "main", via: "pr" });
    expect(green.calls.find((c) => c.args[0] === "pr" && c.args[1] === "merge")?.args).toEqual(["pr", "merge", pr, "--rebase", "--delete-branch"]);
  });
});

describe("runMergeStep", () => {
  test("asks the server first and leaves the merge when the line says no, touching no git", async () => {
    const posts: Array<{ path: string; body: any }> = [];
    const { exec, calls } = scripted({});
    const post = async (path: string, body: any) => { posts.push({ path, body }); return { ...allowed, allowed: false, reason: "merge is off for this line" }; };
    const out = await runMergeStep({ cwd: "/repo", run_id: "run_1", branch: "b", into: "main", post, exec });
    expect(out.outcome).toEqual({ kind: "left", reason: "merge is off for this line" });
    expect(posts.map((p) => p.path)).toEqual(["/cli/line/merge/check", "/cli/work/comment"]);
    expect(posts[0].body).toEqual({ run_id: "run_1" });
    expect(posts[1].body).toMatchObject({ short_id: "ct-7", comment_type: "blocker" });
    expect(calls).toHaveLength(0);
  });

  test("merges when allowed and records the merge on the run with the branch, sha and target", async () => {
    const posts: Array<{ path: string; body: any }> = [];
    const { exec } = scripted({ "git rev-parse": { stdout: "abc123\n" } });
    const post = async (path: string, body: any) => { posts.push({ path, body }); return path.endsWith("/check") ? allowed : { used: 2, limit: 3 }; };
    const lines: string[] = [];
    const out = await runMergeStep({ cwd: "/repo", run_id: "run_1", branch: "b", into: "main", post, exec, log: (l) => lines.push(l) });
    expect(out.outcome.kind).toBe("merged");
    expect(posts[1]).toEqual({ path: "/cli/line/merge/record", body: { run_id: "run_1", sha: "abc123", branch: "b", into: "main" } });
    expect(lines).toEqual(["merged b into main at abc123 (2 of 3 today)"]);
  });

  test("a server that cannot be read leaves the merge to a person instead of throwing", async () => {
    const { exec } = scripted({});
    const out = await runMergeStep({ cwd: "/repo", run_id: "run_1", branch: "b", into: "main", post: async () => { throw new Error("offline"); }, exec });
    expect(out.outcome).toEqual({ kind: "left", reason: "could not read the merge allowance: offline" });
  });

  test("a merge left to a person says so on the task as a blocker naming the branch", async () => {
    const posts: Array<{ path: string; body: any }> = [];
    const { exec } = scripted({});
    const post = async (path: string, body: any) => {
      posts.push({ path, body });
      if (path.endsWith("/check")) throw new Error("This run was not started by a role's line, so it has no merge authority to merge under");
      return { ok: true };
    };
    const out = await runMergeStep({ cwd: "/repo", run_id: "run_1", branch: "codecast/line-ct-7", into: "main", task: "ct-7", post, exec });
    expect(out.outcome.kind).toBe("left");
    expect(posts[1].path).toBe("/cli/work/comment");
    expect(posts[1].body).toMatchObject({ short_id: "ct-7", comment_type: "blocker" });
    expect(posts[1].body.text).toContain("codecast/line-ct-7 is not on main");
    expect(posts[1].body.text).toContain("no merge authority");
  });

  test("a landed merge posts no blocker", async () => {
    const posts: string[] = [];
    const { exec } = scripted({ "git rev-parse": { stdout: "abc123\n" } });
    const post = async (path: string) => { posts.push(path); return path.endsWith("/check") ? allowed : { used: 2, limit: 3 }; };
    await runMergeStep({ cwd: "/repo", run_id: "run_1", branch: "b", into: "main", task: "ct-7", post, exec });
    expect(posts).toEqual(["/cli/line/merge/check", "/cli/line/merge/record"]);
  });
});
