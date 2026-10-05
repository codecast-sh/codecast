// The guard `git` (prompt-dry-run-bin/git) on a served dir cut at its
// capture: git history stops at the cut, a later commit is refused as an
// unknown object, fetch does nothing, and outside a cut it is the real git.
// The guard `cast` refuses a record read the cut snapshot did not capture.
// Real git on throwaway repositories; no network, no real `cast`.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EVERY_READ, writeCut, writeFrozenVerbs } from "../../evals/src/served.ts";

const BIN = path.join(import.meta.dir, "prompt-dry-run-bin");
setDefaultTimeout(60_000);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-cut-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const CUT_AT = "2026-09-24T00:00:00.000Z";

/** Real git with fixed identities and dates, never the guard. */
function realGit(cwd: string, args: string[], date?: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  const r = spawnSync("/usr/bin/env", ["git", ...args], { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository whose main has two commits before the cut and one after, the remote ref beside it, and a branch made after the cut. */
function repo() {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  realGit(dir, ["init", "-q", "-b", "main"]);
  const commit = (msg: string, date: string) => {
    fs.writeFileSync(path.join(dir, "f.txt"), `${msg}\n`);
    realGit(dir, ["add", "f.txt"]);
    realGit(dir, ["commit", "-q", "-m", msg], date);
    return realGit(dir, ["rev-parse", "HEAD"]);
  };
  const first = commit("before one", "2026-09-20T12:00:00Z");
  const second = commit("before two", "2026-09-23T12:00:00Z");
  const later = commit("after the capture: closes pl-350", "2026-09-28T12:00:00Z");
  realGit(dir, ["update-ref", "refs/remotes/origin/main", later]);
  realGit(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  realGit(dir, ["update-ref", "refs/remotes/origin/later-branch", later]);
  realGit(dir, ["update-ref", "refs/remotes/origin/old-branch", first]);
  return { dir: fs.realpathSync(dir), first, second, later };
}

function served(pins: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "serve-"));
  writeCut(dir, { at: CUT_AT, pins });
  writeFrozenVerbs(dir, ["org", EVERY_READ]);
  return dir;
}

function guard(bin: "git" | "cast", args: string[], o: { cwd: string; serve?: string; run: string }) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${BIN}:${process.env.PATH}`, RUN_DIR: o.run };
  delete env.DRY_RUN_SERVE_DIR;
  delete env.GIT_DIR;
  if (o.serve) env.DRY_RUN_SERVE_DIR = o.serve;
  const r = spawnSync(path.join(BIN, bin), args, { cwd: o.cwd, env, encoding: "utf8" });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 };
}

const runDir = () => fs.mkdtempSync(path.join(tmpRoot, "run-"));
const gitLog = (run: string) => fs.readFileSync(path.join(run, "git.log"), "utf8");

describe("git cut at the capture", () => {
  test("a served git log stops at the capture, derived from the cut time when the root is not pinned", () => {
    const r = repo();
    const run = runDir();
    const log = guard("git", ["log", "origin/main", "--format=%s"], { cwd: r.dir, serve: served(), run });
    expect(log.code).toBe(0);
    expect(log.out.trim().split("\n")).toEqual(["before two", "before one"]);
    // HEAD, the local main and origin/HEAD all stand at the cut too.
    for (const rev of ["HEAD", "main", "origin/HEAD"]) expect(guard("git", ["rev-parse", rev], { cwd: r.dir, serve: served(), run }).out.trim()).toBe(r.second);
    expect(gitLog(run)).toContain("PINNED log origin/main --format=%s");
    // The real repository is untouched.
    expect(realGit(r.dir, ["rev-parse", "origin/main"])).toBe(r.later);
  });

  test("a pinned root stands at its pin, not at the cut time", () => {
    const r = repo();
    const out = guard("git", ["log", "origin/main", "--format=%s"], { cwd: r.dir, serve: served({ [r.dir]: r.first }), run: runDir() }).out;
    expect(out.trim()).toBe("before one");
  });

  test("a commit after the capture is refused as an unknown object, by sha, range or sha:path", () => {
    const r = repo();
    const serve = served();
    for (const args of [["show", "-s", r.later.slice(0, 10)], ["log", `${r.second}..${r.later.slice(0, 12)}`], ["show", `${r.later.slice(0, 10)}:f.txt`]]) {
      const run = runDir();
      const res = guard("git", args, { cwd: r.dir, serve, run });
      expect(res.code).toBe(128);
      expect(res.err).toContain(`fatal: bad object ${r.later.slice(0, 7)}`);
      expect(gitLog(run)).toStartWith("CUT ");
    }
    // A commit from before the cut still reads.
    expect(guard("git", ["show", "-s", "--format=%s", r.first.slice(0, 10)], { cwd: r.dir, serve, run: runDir() }).out.trim()).toBe("before one");
  });

  test("branches newer than the cut are gone, older ones stay; fetch does nothing", () => {
    const r = repo();
    const serve = served();
    const run = runDir();
    const refs = guard("git", ["branch", "-r", "--format=%(refname:short)"], { cwd: r.dir, serve, run }).out;
    expect(refs).toContain("origin/old-branch");
    expect(refs).not.toContain("origin/later-branch");
    const fetch = guard("git", ["fetch", "origin"], { cwd: r.dir, serve, run });
    expect(fetch.code).toBe(0);
    expect(fetch.err).toContain("does nothing here");
    expect(gitLog(run)).toContain("CUT fetch origin");
  });

  test("working tree commands fail with a note to name a revision; grep at origin/main answers from the cut", () => {
    const r = repo();
    const serve = served();
    const status = guard("git", ["status"], { cwd: r.dir, serve, run: runDir() });
    expect(status.code).toBe(128);
    expect(status.err).toContain("name a revision");
    const grep = guard("git", ["grep", "-h", "before", "origin/main"], { cwd: r.dir, serve, run: runDir() });
    expect(grep.out).toContain("before two");
    expect(guard("git", ["grep", "pl-350", "origin/main"], { cwd: r.dir, serve, run: runDir() }).out).toBe("");
  });

  test("with no cut, or outside a repository, it is the real git", () => {
    const r = repo();
    expect(guard("git", ["log", "origin/main", "-1", "--format=%s"], { cwd: r.dir, run: runDir() }).out.trim()).toBe("after the capture: closes pl-350");
    const run = runDir();
    expect(guard("git", ["--version"], { cwd: tmpRoot, serve: served(), run }).out).toStartWith("git version");
    expect(fs.existsSync(path.join(run, "git.log"))).toBe(false);
  });
});

describe("cast cut at the capture", () => {
  test("a record read the snapshot did not capture is refused as UNSERVED, never read live", () => {
    const run = runDir();
    const res = guard("cast", ["plan", "show", "pl-350", "--json"], { cwd: tmpRoot, serve: served(), run });
    expect(res.code).toBe(1);
    expect(res.err).toContain("is frozen for this replay and was not captured");
    expect(fs.readFileSync(path.join(run, "calls.log"), "utf8")).toContain("UNSERVED plan show pl-350 --json");
  });
});
