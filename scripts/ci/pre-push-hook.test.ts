// The tracked pre-push hook (.githooks/pre-push) warns on a push straight to
// codecast's main and never refuses one; scripts/install-githooks.sh, run by
// `bun install`, points git at it only where nothing else owns the hooks.
// Real git against a bare repository whose path ends like codecast's remote.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pre-push-hook-")));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

/** Git with no user, system or CI config in reach: CI itself sets GITHUB_ACTIONS and CI, which both scripts read. */
const ENV: Record<string, string | undefined> = {
  ...Bun.env, HOME: sandbox, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GITHUB_ACTIONS: undefined, CI: undefined,
  CODECAST_SHIP_PUSH: undefined, CODECAST_ALLOW_MAIN_PUSH: undefined,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

function run(cmd: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...ENV, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
const git = (cwd: string, ...args: string[]) => run(["git", ...args], cwd);

let n = 0;
/** A clone of a bare origin at `<dir>/<originPath>`, with the hook installed the way bun install installs it. */
function clone(originPath: string) {
  const dir = join(sandbox, `w${++n}`);
  const origin = join(dir, originPath);
  const work = join(dir, "work");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(dir, "clone", "-q", origin, work);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "a");
  mkdirSync(join(work, "scripts"));
  cpSync(join(REPO, ".githooks"), join(work, ".githooks"), { recursive: true });
  cpSync(join(REPO, "scripts/install-githooks.sh"), join(work, "scripts/install-githooks.sh"));
  return { dir, work, install: (env: Record<string, string | undefined> = {}) => run(["bash", "scripts/install-githooks.sh"], work, env) };
}

const WARNING = "this push goes straight to main";

describe("the pre-push hook", () => {
  test("warns on a push to codecast's main and lets it through; a branch, another remote and the landing machinery hear nothing", () => {
    const w = clone("github.com/codecast-sh/codecast.git");
    expect(w.install().code).toBe(0);
    expect(git(w.work, "config", "core.hooksPath").stdout.trim()).toBe(".githooks");

    const main = git(w.work, "push", "-q", "origin", "HEAD:main");
    expect(main.code).toBe(0);
    expect(main.stderr).toContain(WARNING);
    expect(git(w.work, "ls-remote", "origin", "refs/heads/main").stdout).toContain(git(w.work, "rev-parse", "HEAD").stdout.trim());

    const branch = git(w.work, "push", "-q", "origin", "HEAD:refs/heads/feature");
    expect(branch.code).toBe(0);
    expect(branch.stderr).not.toContain(WARNING);

    for (const env of [{ CODECAST_SHIP_PUSH: "1" }, { CODECAST_ALLOW_MAIN_PUSH: "1" }, { GITHUB_ACTIONS: "true" }]) {
      writeFileSync(join(w.work, "a.txt"), `${JSON.stringify(env)}\n`);
      git(w.work, "commit", "-qam", "again");
      const quiet = run(["git", "push", "-q", "origin", "HEAD:main"], w.work, env);
      expect(quiet.code).toBe(0);
      expect(quiet.stderr).not.toContain(WARNING);
    }

    const other = clone("github.com/someone/else.git");
    other.install();
    const elsewhere = git(other.work, "push", "-q", "origin", "HEAD:main");
    expect(elsewhere.code).toBe(0);
    expect(elsewhere.stderr).not.toContain(WARNING);
  });
});

describe("install-githooks.sh", () => {
  test("leaves a hooksPath someone else set, and hooks of their own in .git/hooks", () => {
    const set = clone("o.git");
    git(set.work, "config", "core.hooksPath", ".husky");
    expect(set.install().code).toBe(0);
    expect(git(set.work, "config", "core.hooksPath").stdout.trim()).toBe(".husky");

    const own = clone("o.git");
    const hook = join(own.work, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    chmodSync(hook, 0o755);
    expect(own.install().code).toBe(0);
    expect(git(own.work, "config", "core.hooksPath").code).not.toBe(0);
  });

  test("does nothing in CI, outside a git checkout, or in a copy inside another repository", () => {
    const ci = clone("o.git");
    expect(ci.install({ CI: "true" }).code).toBe(0);
    expect(git(ci.work, "config", "core.hooksPath").code).not.toBe(0);

    const tarball = join(sandbox, "tarball");
    mkdirSync(join(tarball, "scripts"), { recursive: true });
    cpSync(join(REPO, ".githooks"), join(tarball, ".githooks"), { recursive: true });
    cpSync(join(REPO, "scripts/install-githooks.sh"), join(tarball, "scripts/install-githooks.sh"));
    expect(run(["bash", "scripts/install-githooks.sh"], tarball).code).toBe(0);

    const outer = clone("o.git");
    const nested = join(outer.work, "vendor/codecast");
    mkdirSync(join(nested, "scripts"), { recursive: true });
    cpSync(join(REPO, ".githooks"), join(nested, ".githooks"), { recursive: true });
    cpSync(join(REPO, "scripts/install-githooks.sh"), join(nested, "scripts/install-githooks.sh"));
    expect(run(["bash", "scripts/install-githooks.sh"], nested).code).toBe(0);
    expect(git(outer.work, "config", "core.hooksPath").code).not.toBe(0);
  });
});
