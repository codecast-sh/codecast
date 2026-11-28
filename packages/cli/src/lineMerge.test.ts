import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractSessionTrailer, splitSessionTrailer } from "@codecast/shared/blame";
import { checksGreen, defaultExec, landedSha, mergeBranch, mergePullRequest, runMergeStep, squashBody, type Exec, type MergeCheck } from "./lineMerge";

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

  test("a squash onto the default branch's head over a tree built on the older default branch is left: it would undo what landed in between, and nothing is pushed", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("b.txt", "fix\n", "fix: b");
      r.advanceMain("a.txt", "one\ntwo\n");
      r.advanceMain("m.txt", "main moved\n");
      r.git(r.work, "fetch", "-q", "origin");
      r.git(r.work, "reset", "-q", "--soft", "origin/main");
      r.git(r.work, "commit", "-q", "-m", "fix: b, squashed");
      r.git(r.work, "push", "-q", "-f", "origin", "b");
      const main = r.git(r.origin, "rev-parse", "main");
      const out = mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null });
      expect(out.kind).toBe("left");
      const reason = out.kind === "left" ? out.reason : "";
      expect(reason).toStartWith("b would undo changes main made after it was built (");
      expect(reason).toContain("a.txt from ");
      expect(reason).toContain("m.txt from ");
      expect(r.git(r.origin, "rev-parse", "main")).toBe(main);
      expect(r.git(r.origin, "branch", "--list", "b")).toBe("b");
    } finally { r.done(); }
  });

  test("the same squash made after rebasing onto the default branch lands: it carries only the branch's own change", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("b.txt", "fix\n", "fix: b");
      r.commit("b.txt", "fix\nmore\n", "fix: b, more");
      r.advanceMain("a.txt", "one\ntwo\n");
      r.git(r.work, "fetch", "-q", "origin");
      r.git(r.work, "rebase", "-q", "origin/main");
      r.git(r.work, "reset", "-q", "--soft", "origin/main");
      r.git(r.work, "commit", "-q", "-m", "fix: b, squashed");
      r.git(r.work, "push", "-q", "-f", "origin", "b");
      const head = r.git(r.work, "rev-parse", "HEAD");
      expect(mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null })).toEqual({ kind: "merged", sha: head, into: "main", via: "push" });
      expect(r.git(r.origin, "show", "main:a.txt")).toBe("one\ntwo");
    } finally { r.done(); }
  });

  // ct-98089: Acme's ct-97881 replaced two young files with one, main had not touched them, and the guard read the
  // deletion as undoing their creation.
  test("a branch that deletes files main created lands when nothing else it lands sets main back: the deletion is its own", () => {
    const r = gitRepo();
    try {
      r.commit("line/check.md", "check\n", "add check");
      r.commit("line/reconcile.md", "reconcile\n", "add reconcile");
      r.git(r.work, "push", "-q", "origin", "main");
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.git(r.work, "rm", "-q", "line/check.md", "line/reconcile.md");
      r.commit("line/review.md", "review\n", "fix: one review step replaces check and reconcile");
      r.git(r.work, "push", "-q", "origin", "b");
      r.advanceMain("m.txt", "main moved\n");
      const out = mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null });
      expect(out.kind).toBe("merged");
      expect(r.git(r.origin, "ls-tree", "-r", "--name-only", "main")).toBe("a.txt\nline/review.md\nm.txt");
    } finally { r.done(); }
  });

  test("a branch that reverts one of main's recent commits on purpose lands: setting its files back is the branch's point", () => {
    const r = gitRepo();
    try {
      r.commit("x.txt", "before\n", "add x");
      const feat = r.commit("x.txt", "after\n", "feat: x");
      r.git(r.work, "push", "-q", "origin", "main");
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.git(r.work, "revert", "--no-edit", feat);
      r.git(r.work, "push", "-q", "origin", "b");
      r.advanceMain("m.txt", "main moved\n");
      const out = mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null });
      expect(out.kind).toBe("merged");
      expect(r.git(r.origin, "show", "main:x.txt")).toBe("before");
    } finally { r.done(); }
  });

  test("a revert excuses only the commit it names: a squash over a stale tree that also reverts is held for the rest", () => {
    const r = gitRepo();
    try {
      r.commit("x.txt", "before\n", "add x");
      const feat = r.commit("x.txt", "after\n", "feat: x");
      r.git(r.work, "push", "-q", "origin", "main");
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.git(r.work, "revert", "--no-edit", feat);
      r.advanceMain("a.txt", "one\ntwo\n");
      r.git(r.work, "fetch", "-q", "origin");
      r.git(r.work, "reset", "-q", "--soft", "origin/main");
      r.git(r.work, "commit", "-q", "-m", `Revert x, squashed\n\nThis reverts commit ${feat}.`);
      r.git(r.work, "push", "-q", "-f", "origin", "b");
      const main = r.git(r.origin, "rev-parse", "main");
      const out = mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null });
      expect(out.kind).toBe("left");
      const reason = out.kind === "left" ? out.reason : "";
      expect(reason).toContain("a.txt from ");
      expect(reason).not.toContain("x.txt");
      expect(r.git(r.origin, "rev-parse", "main")).toBe(main);
    } finally { r.done(); }
  });

  test("a revert does not excuse erasing main's newer change to the same file: a stale squash that reverts A over B is held, naming B", () => {
    const r = gitRepo();
    try {
      r.commit("x.txt", "before\n", "add x");
      const a = r.commit("x.txt", "after\n", "feat: x");
      r.git(r.work, "push", "-q", "origin", "main");
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.git(r.work, "revert", "--no-edit", a);
      r.advanceMain("x.txt", "after\nand more\n");
      r.git(r.work, "fetch", "-q", "origin");
      const b = r.git(r.work, "rev-parse", "origin/main");
      r.git(r.work, "reset", "-q", "--soft", "origin/main");
      r.git(r.work, "commit", "-q", "-m", `Revert x, squashed\n\nThis reverts commit ${a}.`);
      r.git(r.work, "push", "-q", "-f", "origin", "b");
      const main = r.git(r.origin, "rev-parse", "main");
      const out = mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null });
      expect(out.kind).toBe("left");
      const reason = out.kind === "left" ? out.reason : "";
      expect(reason).toContain(`x.txt from ${b.slice(0, 10)}`);
      expect(r.git(r.origin, "rev-parse", "main")).toBe(main);
    } finally { r.done(); }
  });

  test("a deletion of the branch's own is held with the rest when the landing also sets main back, as a squash over a stale tree does", () => {
    const r = gitRepo();
    try {
      r.commit("old.txt", "old\n", "add old");
      r.git(r.work, "push", "-q", "origin", "main");
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.git(r.work, "rm", "-q", "old.txt");
      r.commit("b.txt", "fix\n", "fix: b, and old goes");
      r.advanceMain("a.txt", "one\ntwo\n");
      r.git(r.work, "fetch", "-q", "origin");
      r.git(r.work, "reset", "-q", "--soft", "origin/main");
      r.git(r.work, "commit", "-q", "-m", "fix: b, squashed");
      r.git(r.work, "push", "-q", "-f", "origin", "b");
      const main = r.git(r.origin, "rev-parse", "main");
      const out = mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null });
      expect(out.kind).toBe("left");
      const reason = out.kind === "left" ? out.reason : "";
      expect(reason).toContain("a.txt from ");
      expect(reason).toContain("old.txt from ");
      expect(r.git(r.origin, "rev-parse", "main")).toBe(main);
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

  test("with a pull request: checks must be green and the PR open, then gh squashes the checked head and the merge commit on main is the sha", () => {
    const pr = "https://github.com/o/r/pull/5";
    const red = scripted({ "git rev-parse": { stdout: "abc\n" }, "gh pr view": { stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] }) } });
    expect(mergeBranch({ cwd: "/repo", branch: "b", into: "main", pr_url: pr, exec: red.exec })).toEqual({ kind: "left", reason: "checks are not green: ci=FAILURE" });
    expect(red.calls.some((c) => c.args[0] === "pr" && c.args[1] === "merge")).toBe(false);

    const view = { state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], mergeCommit: { oid: "squashed" } };
    const green = scripted({ "git rev-parse": { stdout: "abc\n" }, "gh pr view": { stdout: JSON.stringify(view) } });
    expect(mergeBranch({ cwd: "/repo", branch: "b", into: "main", pr_url: pr, exec: green.exec })).toEqual({ kind: "merged", sha: "squashed", into: "main", via: "pr", pr_url: pr });
    expect(green.calls.find((c) => c.args[0] === "pr" && c.args[1] === "merge")?.args).toEqual(["pr", "merge", pr, "--squash", "--match-head-commit", "abc"]);
    // Only origin's branch goes, and only while it stands at the merged head: gh's --delete-branch would also take
    // the local branch and any worktree holding it.
    expect(green.calls.at(-1)?.args).toEqual(["push", "--force-with-lease=refs/heads/b:abc", "origin", "--delete", "b"]);
    expect(green.calls.some((c) => c.args.join(" ") === "merge-base --is-ancestor squashed origin/main")).toBe(true);

    // gh calls it merged, but main does not hold the commit: nothing landed.
    const absent = scripted({ "git rev-parse": { stdout: "abc\n" }, "gh pr view": { stdout: JSON.stringify(view) }, "git merge-base --is-ancestor": { status: 1 } });
    const waits: number[] = [];
    expect(mergeBranch({ cwd: "/repo", branch: "b", into: "main", pr_url: pr, exec: absent.exec, wait: (ms) => waits.push(ms) })).toEqual({ kind: "left", reason: `gh says ${pr} merged as squashed, but origin/main does not hold that commit` });
    // Read again for about ten seconds first: GitHub's git replicas trail its API.
    expect(waits.reduce((a, b) => a + b, 0)).toBe(10_000);

    // A replica that catches up on the third read lands.
    let reads = 0;
    const lagging: Exec = (cmd, args, cwd) => (args[0] === "merge-base" && args[1] === "--is-ancestor" ? { status: ++reads >= 3 ? 0 : 1, stdout: "", stderr: "" } : green.exec(cmd, args, cwd));
    expect(landedSha(lagging, "/repo", pr, "main", () => {})).toEqual({ sha: "squashed" });
    expect(reads).toBe(3);

    // gh can exit 1 after the merge went through: the PR reads merged, so it counts.
    const afterMerge = scripted({ "gh pr merge": { status: 1, stderr: "connection reset" }, "gh pr view": { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "squashed" } }) } });
    expect(mergePullRequest(afterMerge.exec, "/repo", { pr, branch: "b", head: "abc", into: "main" })).toEqual({ sha: "squashed" });
    // A branch GitHub already deleted: the push fails and the merge still stands.
    const gone = scripted({ "gh pr view": { stdout: JSON.stringify(view) }, "git push": { status: 1, stderr: "error: unable to delete 'b': remote ref does not exist" } });
    expect(mergePullRequest(gone.exec, "/repo", { pr, branch: "b", head: "abc", into: "main" })).toEqual({ sha: "squashed" });
    const refused = scripted({ "gh pr merge": { status: 1, stderr: "Head branch was modified" }, "gh pr view": { stdout: JSON.stringify({ state: "OPEN" }) } });
    expect(mergePullRequest(refused.exec, "/repo", { pr, branch: "b", head: "abc", into: "main" })).toEqual({ reason: "gh pr merge failed: Head branch was modified" });
    expect(refused.calls.some((c) => c.args[0] === "push")).toBe(false);
  });

  /** The real repository, seen as a GitHub one: `api` answers whether main is protected, `prs` the open pull requests for b. */
  const onGitHub = (api: { status: number; stdout: string; stderr: string }, prs: { status: number; stdout: string; stderr: string }, calls: Call[] = []): Exec => (cmd, args, cwd, env) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(" ")}`;
    if (key === "git remote get-url origin") return { status: 0, stdout: "git@github.com:acme/app.git\n", stderr: "" };
    if (key.startsWith("gh api repos/acme/app/branches/main")) return api;
    if (key.startsWith("gh pr list")) return prs;
    if (key.startsWith("gh pr create")) return { status: 0, stdout: "https://github.com/acme/app/pull/9\n", stderr: "" };
    return defaultExec(cmd, args, cwd, env);
  };
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });

  test("a default branch GitHub protects is never pushed to: with no pull request the step opens one, titled for the task, and leaves the merge for its checks (ct-95361)", async () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("b.txt", "fix\n", "fix: b");
      r.git(r.work, "push", "-q", "origin", "b");
      const main = r.git(r.origin, "rev-parse", "main");
      const calls: Call[] = [];
      const posts: Array<{ path: string; body: any }> = [];
      const post = async (path: string, body: any) => { posts.push({ path, body }); return path.endsWith("/check") ? allowed : { ok: true }; };
      const out = await runMergeStep({ cwd: r.work, run_id: "run_1", branch: "b", into: "main", post, exec: onGitHub(ok("true\n"), ok("[]\n"), calls) });
      expect(out.outcome).toEqual({ kind: "left", reason: "GitHub protects main, so b lands through https://github.com/acme/app/pull/9, opened now; it merges once its checks have run green" });
      expect(r.git(r.origin, "rev-parse", "main")).toBe(main);
      expect(calls.some((c) => c.cmd === "git" && c.args[0] === "push")).toBe(false);
      const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create")?.args ?? [];
      expect(create.slice(0, 8)).toEqual(["pr", "create", "--head", "b", "--base", "main", "--title", "Add"]);
      expect(create[9]).toContain("GitHub protects main");
      // Left, so the task says where it stands, naming the pull request; nothing is recorded as merged.
      expect(posts.map((p) => p.path)).toEqual(["/cli/line/merge/check", "/cli/work/comment"]);
      expect(posts[1].body.text).toContain("https://github.com/acme/app/pull/9");
    } finally { r.done(); }
  });

  test("the branch's open pull request onto a protected default branch merges on the terms of a named one, and nothing is pushed past it", () => {
    const pr = "https://github.com/acme/app/pull/9";
    const on = (checks: unknown[]) => scripted({
      "git remote get-url origin": { stdout: "https://github.com/acme/app.git\n" },
      "gh api repos/acme/app/branches/main": { stdout: "true\n" },
      "gh pr list": { stdout: JSON.stringify([{ url: pr }]) },
      "git rev-parse": { stdout: "abc\n" },
      "gh pr view": { stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: checks, mergeCommit: { oid: "squashed" } }) },
    });
    const green = on([{ name: "ci", conclusion: "SUCCESS" }]);
    expect(mergeBranch({ cwd: "/repo", branch: "b", into: "main", pr_url: null, exec: green.exec })).toEqual({ kind: "merged", sha: "squashed", into: "main", via: "pr", pr_url: pr });
    expect(green.calls.some((c) => c.args.some((a) => a.endsWith(":refs/heads/main")))).toBe(false);
    const pending = on([{ name: "ci", state: "PENDING" }]);
    expect(mergeBranch({ cwd: "/repo", branch: "b", into: "main", pr_url: null, exec: pending.exec })).toEqual({ kind: "left", reason: `GitHub protects main, so b lands through ${pr}: checks are not green: ci=PENDING` });
    expect(pending.calls.some((c) => c.args[0] === "pr" && (c.args[1] === "merge" || c.args[1] === "create"))).toBe(false);
  });

  test("protection GitHub cannot be asked about holds the push as protection does; a branch GitHub leaves open still lands by push", () => {
    const r = gitRepo();
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      const head = r.commit("b.txt", "fix\n", "fix: b");
      r.git(r.work, "push", "-q", "origin", "b");
      const main = r.git(r.origin, "rev-parse", "main");
      const unread = onGitHub({ status: 1, stdout: "", stderr: "HTTP 401: Bad credentials" }, { status: 1, stdout: "", stderr: "gh: not logged in" });
      expect(mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null, exec: unread })).toEqual({ kind: "left", reason: "whether GitHub protects main could not be read (HTTP 401: Bad credentials), so it lands only through a pull request, and gh pr list failed: gh: not logged in" });
      expect(r.git(r.origin, "rev-parse", "main")).toBe(main);
      expect(mergeBranch({ cwd: r.work, branch: "b", into: "main", pr_url: null, exec: onGitHub(ok("false\n"), ok("[]\n")) })).toEqual({ kind: "merged", sha: head, into: "main", via: "push" });
      expect(r.git(r.origin, "rev-parse", "main")).toBe(head);
    } finally { r.done(); }
  });
});

describe("squashBody", () => {
  test("carries each of the branch's commits whole, in GitHub's squash shape, so blame reads every session's trailer", () => {
    const r = gitRepo();
    const s1 = "jx7389x8e30114ecc93nk6txzn8jnxrg";
    const s2 = "jx7ek23bt01nysvawb3781jg558jnpme";
    try {
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("x.txt", "1\n", `Add x\n\nCodecast-Session: https://codecast.sh/conversation/${s1}`);
      const head = r.commit("y.txt", "2\n", `Add y\n\nCodecast-Session: https://codecast.sh/conversation/${s2}`);
      r.git(r.work, "fetch", "-q", "origin");
      const body = squashBody(defaultExec, r.work, head, "main")!;
      expect(body).toBe(`* Add x\n\nCodecast-Session: https://codecast.sh/conversation/${s1}\n\n* Add y\n\nCodecast-Session: https://codecast.sh/conversation/${s2}`);
      // Each trailer block ends its commit's bullet, so blame finds both; the squash names the newest.
      const squash = `Squash (#5)\n\n${body}`;
      expect(extractSessionTrailer(squash)).toBe(s2);
      expect(splitSessionTrailer(squash).message).not.toContain("Codecast-Session");
    } finally { r.done(); }
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
    expect(posts[1].body.conversation_id).toBeUndefined();
  });

  // ct-100734: posted bare from a line station, the blocker read as the person's own words and reached the working session as theirs.
  test("a merge left to a person signs its blocker as the session it was given (a station's run)", async () => {
    const posts: Array<{ path: string; body: any }> = [];
    const { exec } = scripted({});
    const post = async (path: string, body: any) => {
      posts.push({ path, body });
      if (path.endsWith("/check")) return { ...allowed, allowed: false, reason: "merge is off for this line" };
      return { ok: true };
    };
    await runMergeStep({ cwd: "/repo", run_id: "run_1", branch: "b", into: "main", task: "ct-7", session: "conv_run", post, exec });
    expect(posts[1]).toMatchObject({ path: "/cli/work/comment", body: { short_id: "ct-7", comment_type: "blocker", conversation_id: "conv_run" } });
  });

  // ct-98570: a line merge runs none of the default branch's before-merge steps, so it never lands a change they cover.
  test("a change a before-merge step covers is left to the change flow, and one it does not cover merges", async () => {
    const r = gitRepo();
    try {
      r.commit(".codecast/workspace.toml", '[[ship.deploy]]\nname = "convex"\nwhen = ["convex/**"]\nrun = "true"\nstage = "before_push"\n', "profile");
      r.git(r.work, "push", "-q", "origin", "main");
      const post = async (path: string) => (path.endsWith("/check") ? allowed : { used: 2, limit: 3 });
      r.git(r.work, "checkout", "-q", "-b", "b");
      r.commit("convex/fn.ts", "export {}\n", "add a function");
      r.git(r.work, "push", "-q", "origin", "b");
      const held = await runMergeStep({ cwd: r.work, run_id: "run_1", branch: "b", into: "main", post, exec: defaultExec });
      expect(held.outcome).toEqual({ kind: "left", reason: "convex must run before this change lands, and a line merge runs none; ship it through the change flow (cast flow run change --branch b)" });
      r.git(r.work, "checkout", "-q", "main");
      r.git(r.work, "checkout", "-q", "-b", "c");
      r.commit("web.txt", "page\n", "web only");
      r.git(r.work, "push", "-q", "origin", "c");
      const merged = await runMergeStep({ cwd: r.work, run_id: "run_2", branch: "c", into: "main", post, exec: defaultExec });
      expect(merged.outcome.kind).toBe("merged");
    } finally {
      r.done();
    }
  });

  test("a landed merge posts no blocker", async () => {
    const posts: string[] = [];
    const { exec } = scripted({ "git rev-parse": { stdout: "abc123\n" } });
    const post = async (path: string) => { posts.push(path); return path.endsWith("/check") ? allowed : { used: 2, limit: 3 }; };
    await runMergeStep({ cwd: "/repo", run_id: "run_1", branch: "b", into: "main", task: "ct-7", post, exec });
    expect(posts).toEqual(["/cli/line/merge/check", "/cli/line/merge/record"]);
  });
});
