// landedCommit (awaitDeploy.ts): whether a branch's change is on main yet, which a run's end reads to retire its
// subject. Deploy itself starts only from the merged sha (awaitDeploy.test.ts, mergedCommit).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { landedCommit } from "./awaitDeploy";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
let dir = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();
const write = (cwd: string, f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true }); fs.writeFileSync(path.join(cwd, f), t); };

let remote = "", work = "", other = "";
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-await-deploy-")));
  remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: ENV });
  work = path.join(dir, "work");
  execFileSync("git", ["clone", "-q", remote, work], { env: ENV, stdio: "ignore" });
  write(work, "api/a.ts", "a1\n");
  write(work, "web/w.ts", "w1\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  git(work, "push", "-q", "origin", "HEAD:main");
  other = path.join(dir, "other");
  execFileSync("git", ["clone", "-q", remote, other], { env: ENV, stdio: "ignore" });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));


describe("landedCommit", () => {
  test("not landed until main holds it; a pushed branch lands as itself, a squash as the commit that reads the same", async () => {
    git(work, "checkout", "-q", "-b", "change");
    write(work, "api/a.ts", "a2\n");
    git(work, "commit", "-qam", "change");
    expect(await landedCommit(work, "change", "main")).toBeNull();

    // Someone else's commit lands first, then the change is squashed onto main by hand.
    write(other, "web/w.ts", "w2\n");
    git(other, "commit", "-qam", "other");
    git(other, "push", "-q", "origin", "HEAD:main");
    expect(await landedCommit(work, "change", "main")).toBeNull();
    git(other, "pull", "-q", "--rebase", "origin", "main");
    write(other, "api/a.ts", "a2\n");
    git(other, "commit", "-qam", "squashed change");
    git(other, "push", "-q", "origin", "HEAD:main");
    const squashed = git(other, "rev-parse", "HEAD");
    expect(await landedCommit(work, "change", "main")).toEqual({ sha: squashed, files: ["api/a.ts"] });
  });

  test("a branch main fast-forwarded to lands as its own tip", async () => {
    git(work, "fetch", "-q", "origin", "main");
    git(work, "checkout", "-q", "-b", "ff", "origin/main");
    write(work, "web/w.ts", "w3\n");
    git(work, "commit", "-qam", "ff change");
    git(work, "push", "-q", "origin", "HEAD:main");
    const tip = git(work, "rev-parse", "HEAD");
    // Once main holds the branch there is nothing to diff it against: the tip's own files, or the ones the run knows.
    expect(await landedCommit(work, "ff", "main")).toEqual({ sha: tip, files: ["web/w.ts"] });
    expect((await landedCommit(work, "ff", "main", ["web/w.ts", "api/a.ts"]))?.files).toEqual(["web/w.ts", "api/a.ts"]);
  });

  // The merge step replays a branch onto a main that changed the same file elsewhere (ct-61888, Nov 7): no commit
  // reads as the branch left it, and the run waited at Deploy for a landing that had already happened.
  test("a change replayed onto a main that moved in the same file lands as the commit that holds it", async () => {
    git(other, "pull", "-q", "--rebase", "origin", "main");
    write(other, "api/b.ts", "1\n2\n3\n4\n5\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "b base");
    git(other, "push", "-q", "origin", "HEAD:main");
    git(work, "fetch", "-q", "origin", "main");
    git(work, "checkout", "-q", "-b", "replay", "origin/main");
    write(work, "api/b.ts", "ONE\n2\n3\n4\n5\n");
    git(work, "commit", "-qam", "replay change");
    write(other, "api/b.ts", "1\n2\n3\n4\nFIVE\n");
    git(other, "commit", "-qam", "main moves in the same file");
    git(other, "push", "-q", "origin", "HEAD:main");
    expect(await landedCommit(work, "replay", "main")).toBeNull();
    write(other, "api/b.ts", "ONE\n2\n3\n4\nFIVE\n");
    git(other, "commit", "-qam", "replayed change");
    git(other, "push", "-q", "origin", "HEAD:main");
    const landed = git(other, "rev-parse", "HEAD");
    expect(await landedCommit(work, "replay", "main")).toEqual({ sha: landed, files: ["api/b.ts"] });
  });

  // A run directory whose worktree lost its .git file reads as a subdirectory of the checkout around it, and git takes
  // a path after `--` from where it stands: ct-98870 and ct-99025 waited at Deploy from Nov 22 for squashes main held.
  test("a change reads as landed from a subdirectory of the checkout too", async () => {
    git(other, "pull", "-q", "--rebase", "origin", "main");
    git(work, "fetch", "-q", "origin", "main");
    git(work, "checkout", "-q", "-b", "sub", "origin/main");
    write(work, "api/d.ts", "d1\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "sub change");
    write(other, "web/w.ts", "w4\n");
    git(other, "commit", "-qam", "main moves elsewhere");
    git(other, "push", "-q", "origin", "HEAD:main");
    write(other, "api/d.ts", "d1\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "squashed sub change");
    git(other, "push", "-q", "origin", "HEAD:main");
    const squashed = git(other, "rev-parse", "HEAD");
    expect(await landedCommit(path.join(work, "web"), "sub", "main")).toEqual({ sha: squashed, files: ["api/d.ts"] });
  });
});
