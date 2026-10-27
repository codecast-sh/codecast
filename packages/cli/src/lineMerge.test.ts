import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractSessionTrailer } from "@codecast/shared/blame";
import { checksGreen, defaultExec, mergeBranch, runMergeStep, type Exec, type MergeCheck } from "./lineMerge";

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

/** A bare origin whose main has one commit, and a clone of it (`work`) where the branch `b` is built and pushed. */
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "line-merge-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  for (const [k, v] of [["user.name", "Line Host"], ["user.email", "host@example.com"]]) git(work, "config", k, v);
  const write = (dir: string, file: string, text: string) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };
  const commit = (file: string, text: string, message: string, author = "Builder <builder@example.com>") => {
    write(work, file, text);
    git(work, "add", file);
    git(work, "commit", "-q", "--author", author, "-m", message);
    return git(work, "rev-parse", "HEAD");
  };
  commit("a.txt", "one\n", "start");
  git(work, "push", "-q", "origin", "main");
  /** main moved on by someone else: a commit pushed from a second clone. */
  const advanceMain = (file: string, text: string) => {
    const other = join(root, `other-${file.replace(/\W/g, "-")}`);
    git(root, "clone", "-q", origin, other);
    write(other, file, text);
    git(other, "add", file);
    git(other, "-c", "user.name=Teammate", "-c", "user.email=t@example.com", "commit", "-q", "-m", `main: ${file}`);
    git(other, "push", "-q", "origin", "main");
  };
  const log = (ref: string) => git(work, "log", "--format=%s|%an", ref).split("\n");
  return { origin, work, git, commit, advanceMain, log, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("mergeBranch", () => {
  test("without a pull request: a branch that contains the default branch lands as a fast forward of its head, then the branch is deleted", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      const head = r.commit("b.txt", "fix\n", "fix: b");
      r.git(r.work, "push", "-q", "origin", "b");
      expect(mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null })).toEqual({ kind: "merged", sha: head, into: "main", via: "push" });
      expect(r.git(r.origin, "rev-parse", "main")).toBe(head);
      expect(r.git(r.origin, "branch", "--list", "b")).toBe("");
    } finally { r.done(); }
  });

  test("a branch the default branch moved past, with no file in common, lands its own commits replayed on top: authors, messages and session trailers kept, history flat", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("b.txt", "repro\n", "test: repro\n\nCodecast-Session: https://codecast.sh/conversation/jx7prove");
      r.commit("c.txt", "fix\n", "fix: c\n\nCodecast-Session: https://codecast.sh/conversation/jx7build");
      r.git(r.work, "push", "-q", "origin", "b");
      r.advanceMain("m.txt", "main moved\n");
      const out = mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null });
      expect(out.kind).toBe("merged");
      r.git(r.work, "fetch", "-q", "origin");
      expect(out.kind === "merged" && out.sha).toBe(r.git(r.work, "rev-parse", "origin/main"));
      expect(r.log("origin/main")).toEqual(["fix: c|Builder", "test: repro|Builder", "main: m.txt|Teammate", "start|Builder"]);
      expect(r.git(r.work, "log", "--format=%B", "-1", "origin/main")).toBe("fix: c\n\nCodecast-Session: https://codecast.sh/conversation/jx7build");
      expect(r.git(r.work, "rev-list", "--merges", "--count", "origin/main")).toBe("0");
      expect(r.git(r.work, "ls-tree", "--name-only", "origin/main").split("\n")).toEqual(["a.txt", "b.txt", "c.txt", "m.txt"]);
      expect(r.git(r.origin, "branch", "--list", "b")).toBe("");
    } finally { r.done(); }
  });

  test("a branch that merged the default branch in lands without that merge: its own commits on top, the same tree as the two merged", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("b.txt", "repro\n", "test: repro");
      r.advanceMain("m.txt", "first\n");
      r.git(r.work, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
      r.commit("c.txt", "fix\n", "fix: c");
      r.git(r.work, "push", "-q", "origin", "b");
      r.advanceMain("n.txt", "second\n");
      expect(mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null }).kind).toBe("merged");
      r.git(r.work, "fetch", "-q", "origin");
      expect(r.log("origin/main").map((l) => l.split("|")[0])).toEqual(["fix: c", "test: repro", "main: n.txt", "main: m.txt", "start"]);
      expect(r.git(r.work, "ls-tree", "--name-only", "origin/main").split("\n")).toEqual(["a.txt", "b.txt", "c.txt", "m.txt", "n.txt"]);
    } finally { r.done(); }
  });

  test("a branch whose files the default branch also changed is left, naming them, and nothing is pushed", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("a.txt", "one\nfix\n", "fix: a");
      r.git(r.work, "push", "-q", "origin", "b");
      r.advanceMain("a.txt", "zero\none\n");
      const main = r.git(r.origin, "rev-parse", "main");
      expect(mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null })).toEqual({ kind: "left", reason: "b is behind main, which changed files it touches (a.txt); build it again on main first" });
      expect(r.git(r.origin, "rev-parse", "main")).toBe(main);
      expect(r.git(r.origin, "branch", "--list", "b")).toBe("b");
    } finally { r.done(); }
  });

  test("run from a subdirectory of the repository (a line's project path), files the default branch also changed are still seen", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("app/x.txt", "fix\n", "fix: x");
      r.git(r.work, "push", "-q", "origin", "b");
      r.advanceMain("app/x.txt", "main's x\n");
      expect(mergeBranch({ cwd: join(r.work, "app"), branch: "b", into: "main", pr_url: null })).toEqual({ kind: "left", reason: "b is behind main, which changed files it touches (app/x.txt); build it again on main first" });
    } finally { r.done(); }
  });

  test("a branch whose commits do not replay (main took one of them in another form, a merge of main reconciled them) lands as one commit of the two merged, listing its commits as a squash merge does", () => {
    const r = gitRepo();
    const prove = "jx7bq5kz13a2eypp4a6vdqznas7zvrw1";
    const build = "jx7bq5kz13a2eypp4a6vdqznas7zvrw2";
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("p.txt", "the branch's version\n", `fix(p): another problem's fix, carried along\n\nCodecast-Session: https://codecast.sh/conversation/${prove}`);
      r.advanceMain("p.txt", "main's version\n");
      r.git(r.work, "fetch", "-q", "origin");
      r.git(r.work, "merge", "-q", "-X", "theirs", "--no-edit", "origin/main");
      r.commit("f.txt", "fix\n", `fix(f): this problem's fix\n\nCodecast-Session: https://codecast.sh/conversation/${build}`);
      r.git(r.work, "push", "-q", "origin", "b");
      r.advanceMain("n.txt", "main moved on\n");
      expect(mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null }).kind).toBe("merged");
      r.git(r.work, "fetch", "-q", "origin");
      expect(r.log("origin/main").map((l) => l.split("|")[0])).toEqual(["fix(f): this problem's fix", "main: n.txt", "main: p.txt", "start"]);
      expect(r.git(r.work, "show", "origin/main:p.txt")).toBe("main's version");
      expect(r.git(r.work, "ls-tree", "--name-only", "origin/main").split("\n")).toEqual(["a.txt", "f.txt", "n.txt", "p.txt"]);
      const message = r.git(r.work, "log", "--format=%B", "-1", "origin/main");
      expect(message).toBe(`fix(f): this problem's fix\n\n* fix(p): another problem's fix, carried along\n\nCodecast-Session: https://codecast.sh/conversation/${prove}\n\n* fix(f): this problem's fix\n\nCodecast-Session: https://codecast.sh/conversation/${build}`);
      expect(extractSessionTrailer(message)).toBe(build);
    } finally { r.done(); }
  });

  test("the default branch moving between the read and the push is read again, and the branch lands on top of it", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("b.txt", "fix\n", "fix: b");
      r.git(r.work, "push", "-q", "origin", "b");
      let raced = false;
      const exec: Exec = (cmd, args, cwd, env) => {
        if (!raced && cmd === "git" && args[0] === "push" && args[2]?.endsWith(":refs/heads/main")) { raced = true; r.advanceMain("record.txt", "a run's record\n"); }
        return defaultExec(cmd, args, cwd, env);
      };
      expect(mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null, exec }).kind).toBe("merged");
      r.git(r.work, "fetch", "-q", "origin");
      expect(r.log("origin/main").map((l) => l.split("|")[0])).toEqual(["fix: b", "main: record.txt", "start"]);
    } finally { r.done(); }
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
