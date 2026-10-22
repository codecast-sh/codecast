/**
 * A failed line run resumed at a station, its branch first put on the
 * default branch (cast workflow resume --onto-main): the shipped line's own
 * rebase script runs on a real git checkout, with the project's check left to
 * the station the run resumes at, and a conflict resumes where the graph
 * routes the rebase's. `cast` is a stand-in that names the worktree and keeps
 * the task comments.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkflowFile } from "./parser.js";
import { catchUp, findCheckpoint, resumeStation } from "./resumeFailed.js";
import { checkpointPath, type RunCheckpoint } from "./runResume.js";

const line = () => parseWorkflowFile(path.join(import.meta.dir, "templates/line.cast"));

describe("a failed run resumed onto the default branch", () => {
  let tmp: string;
  let project: string;
  let worktree: string;
  let comments: string;
  let origPath: string | undefined;
  const runId = "run-resume-1";
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, file: string, text: string, message: string) => {
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", message);
  };
  /** The checkpoint the run left on this machine, holding what its stations read. */
  const checkpoint = (category = "code"): RunCheckpoint => ({
    run_id: runId,
    node_id: "implement",
    started: false,
    visit_counts: { implement: 3 },
    completed: [],
    node_outcomes: {},
    context: { task_id: "ct-1", worktree: "line-ct-1", branch: "codecast/line-ct-1", default_branch: "main", run_dir: path.join(tmp, "run"), category },
    at: 1,
  });

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-failed-")));
    const origin = path.join(tmp, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    project = path.join(tmp, "project");
    git(tmp, "clone", "-q", origin, project);
    commit(project, "a.txt", "one\n", "base");
    git(project, "push", "-q", "origin", "main");
    worktree = path.join(tmp, "line-ct-1");
    git(project, "worktree", "add", "-q", "-b", "codecast/line-ct-1", worktree, "main");
    commit(worktree, "fix.txt", "the fix\n", "the fix");
    git(worktree, "push", "-q", "origin", "codecast/line-ct-1");
    // A stand-in cast: `ws path` names the worktree, `task comment` keeps what was said.
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    comments = path.join(tmp, "comments.txt");
    fs.writeFileSync(path.join(bin, "cast"), `#!/bin/bash\nif [ "$1" = ws ]; then echo ${JSON.stringify(worktree)}; else printf '%s\\n' "$*" >> ${JSON.stringify(comments)}; fi\n`);
    fs.chmodSync(path.join(bin, "cast"), 0o755);
    origPath = process.env.PATH;
    process.env.PATH = `${bin}:${origPath}`;
  });
  afterEach(() => {
    process.env.PATH = origPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("a branch behind the default branch is put on it and pushed, and the check is left to the station it resumes at", () => {
    // The default branch moved on, as Union main did with the line's new eval.
    commit(project, "b.txt", "two\n", "main moved");
    git(project, "push", "-q", "origin", "main");
    // A check that would fail here proves it is not run by the catch-up.
    const cp = checkpoint();
    cp.context["line.commands.check"] = "exit 1";
    expect(catchUp(line(), cp, project).kind).toBe("on_main");
    expect(git(worktree, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe("");
    expect(git(project, "rev-parse", "origin/codecast/line-ct-1")).toBe(git(worktree, "rev-parse", "HEAD"));
  });

  test("a conflict resumes at the station the graph sends the rebase's to, and leaves the branch as it was", () => {
    commit(worktree, "a.txt", "the branch's\n", "branch edits a");
    commit(project, "a.txt", "main's\n", "main edits a");
    git(project, "push", "-q", "origin", "main");
    const before = git(worktree, "rev-parse", "HEAD");
    expect(catchUp(line(), checkpoint("code"), project)).toMatchObject({ kind: "conflict", station: "implement" });
    expect(catchUp(line(), checkpoint("line"), project)).toMatchObject({ kind: "conflict", station: "implement_line" });
    expect(git(worktree, "rev-parse", "HEAD")).toBe(before);
    const said = fs.readFileSync(comments, "utf-8");
    expect(said).toContain("Rebasing codecast/line-ct-1 onto origin/main conflicted in a.txt");
    expect(said).not.toContain("Shipping");
  });

  test("a change already on the default branch is not resumed", () => {
    git(project, "fetch", "-q", "origin", "codecast/line-ct-1");
    git(project, "merge", "-q", "--ff-only", "origin/codecast/line-ct-1");
    git(project, "push", "-q", "origin", "main");
    expect(catchUp(line(), checkpoint(), project).kind).toBe("landed");
  });

  test("the station is checked against the graph, and --onto-main runs only where the run's worktree and checkpoint are", () => {
    expect(() => resumeStation(line(), "nowhere", { runId, projectPath: project, here: true })).toThrow("the run's graph has no station nowhere");
    expect(resumeStation(line(), "verify", { runId, projectPath: project, here: false })).toEqual({ at: "verify", note: null });
    expect(() => resumeStation(line(), "verify", { ontoMain: true, runId, projectPath: project, here: false })).toThrow("run it on the machine that holds the run");
    expect(() => resumeStation(line(), "verify", { ontoMain: true, runId, projectPath: project, here: true })).toThrow(`no checkpoint of run ${runId}`);
    // Its checkpoint is found wherever its graph put the run's files.
    const file = checkpointPath(path.join(git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"), "cast-line", "line-ct-1"), runId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(checkpoint()));
    expect(findCheckpoint(project, runId)?.context.worktree).toBe("line-ct-1");
    commit(project, "b.txt", "two\n", "main moved");
    git(project, "push", "-q", "origin", "main");
    expect(resumeStation(line(), "verify", { ontoMain: true, runId, projectPath: project, here: true })).toMatchObject({ at: "verify" });
  });
});
