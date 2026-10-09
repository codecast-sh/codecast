import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cloneInto, gitPushWorktree, remoteRepoPath, verifyRemoteSync, type RemoteHost } from "./session-move.js";

// A move lands in the host's checkout of the repository, which other sessions
// share the way they share the laptop folder. These run the real git on both
// sides; a stand-in ssh runs each host command on this machine.
let dir: string, laptop: string, hostRepo: string, host: RemoteHost;
let saved: NodeJS.ProcessEnv;

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
const write = (repo: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const read = (repo: string, rel: string) => fs.readFileSync(path.join(repo, rel), "utf-8");
const commit = (repo: string, rel: string, text: string) => { write(repo, rel, text); git(repo, "add", rel); git(repo, "commit", "-qm", `edit ${rel}`); return git(repo, "rev-parse", "HEAD"); };
const lines = (...l: string[]) => l.join("\n") + "\n";

beforeEach(() => {
  saved = { ...process.env };
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "move-landing-")));
  process.env.HOME = path.join(dir, "home");
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, "gitconfig");
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test\n\temail = test@local\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  laptop = path.join(dir, "laptop");
  fs.mkdirSync(laptop);
  git(laptop, "init", "-q");
  // .git/info/exclude goes over rsync, which the stand-in ssh does not reach.
  fs.rmSync(path.join(laptop, ".git", "info", "exclude"), { force: true });
  write(laptop, "a.txt", lines("a1", "a2", "a3"));
  write(laptop, "b.txt", lines("b1", "b2", "b3"));
  git(laptop, "add", ".");
  git(laptop, "commit", "-qm", "base");
  hostRepo = path.join(dir, "host", "src", "app");
  fs.mkdirSync(path.dirname(hostRepo), { recursive: true });
  execFileSync("git", ["clone", "-q", laptop, hostRepo]);
  host = { address: "host.invalid", user: "u", keyPath: "/dev/null", remoteBaseDir: path.join(dir, "host", "work"), homeDir: path.join(dir, "host") };
});

afterEach(() => {
  process.env = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a move merges into the host checkout", () => {
  test("another session's uncommitted work there survives, and the moved work arrives uncommitted", async () => {
    // A session already on the host edited a.txt and made a file; neither is committed.
    write(hostRepo, "a.txt", lines("a1", "host", "a3"));
    write(hostRepo, "notes.txt", "host notes\n");
    // Here: a new commit, and an uncommitted edit.
    const head = commit(laptop, "c.txt", "c\n");
    write(laptop, "b.txt", lines("b1", "laptop", "b3"));

    const { head: landed } = await gitPushWorktree(host, laptop, hostRepo);

    expect(git(hostRepo, "rev-parse", "HEAD")).toBe(head);
    expect(read(hostRepo, "a.txt")).toBe(lines("a1", "host", "a3"));
    expect(read(hostRepo, "notes.txt")).toBe("host notes\n");
    expect(read(hostRepo, "b.txt")).toBe(lines("b1", "laptop", "b3"));
    expect(read(hostRepo, "c.txt")).toBe("c\n");
    expect(git(hostRepo, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? notes.txt", "M a.txt", "M b.txt"]);
    const v = verifyRemoteSync(host, laptop, hostRepo, landed);
    expect(v).toMatchObject({ headsMatch: true, remoteDirty: 0 });
  });

  test("a second move carries only what changed here since the first", async () => {
    write(laptop, "b.txt", lines("b1", "first", "b3"));
    await gitPushWorktree(host, laptop, hostRepo);
    // The moved session works on b.txt on the host; another edits a.txt here.
    write(hostRepo, "b.txt", lines("b1", "first", "b3", "host"));
    write(laptop, "a.txt", lines("a1", "a2", "laptop"));

    await gitPushWorktree(host, laptop, hostRepo);

    expect(read(hostRepo, "b.txt")).toBe(lines("b1", "first", "b3", "host"));
    expect(read(hostRepo, "a.txt")).toBe(lines("a1", "a2", "laptop"));
  });

  test("the same lines changed on both sides refuse the move and leave the host as it was", async () => {
    write(hostRepo, "a.txt", lines("a1", "host", "a3"));
    write(laptop, "a.txt", lines("a1", "laptop", "a3"));
    const before = git(hostRepo, "rev-parse", "HEAD");

    await expect(gitPushWorktree(host, laptop, hostRepo)).rejects.toThrow(/both changed a\.txt; nothing was moved/);

    expect(git(hostRepo, "rev-parse", "HEAD")).toBe(before);
    expect(read(hostRepo, "a.txt")).toBe(lines("a1", "host", "a3"));
  });

  test("host commits ahead of this folder stay, with the moved work on top", async () => {
    const hostHead = commit(hostRepo, "h.txt", "host commit\n");
    write(laptop, "b.txt", lines("b1", "laptop", "b3"));

    await gitPushWorktree(host, laptop, hostRepo);

    expect(git(hostRepo, "rev-parse", "HEAD")).toBe(hostHead);
    expect(read(hostRepo, "b.txt")).toBe(lines("b1", "laptop", "b3"));
  });
});

describe("host paths mirror this machine's", () => {
  test("a folder under the home keeps its place; the home itself and outside folders go under remoteBaseDir", () => {
    const home = process.env.HOME!;
    expect(remoteRepoPath(host, path.join(home, "src", "app"))).toBe(path.join(dir, "host", "src", "app"));
    expect(remoteRepoPath(host, path.join(home, "src", "app", ".codecast", "worktrees", "x"))).toBe(path.join(dir, "host", "src", "app", ".codecast", "worktrees", "x"));
    expect(remoteRepoPath(host, home)).toBe(path.join(dir, "host", "work", path.basename(home)));
    expect(remoteRepoPath(host, "/opt/app")).toBe(path.join(dir, "host", "work", "app"));
  });

  test("a clone into a folder already there keeps its other files and lays git's over the rest", () => {
    const dest = path.join(dir, "host", "src", "adopted");
    write(dest, "a.txt", "mirror copy\n");
    write(dest, "only-here.txt", "keep\n");
    execFileSync("/bin/sh", ["-c", cloneInto(laptop, dest)]);
    expect(read(dest, "a.txt")).toBe(lines("a1", "a2", "a3"));
    expect(read(dest, "only-here.txt")).toBe("keep\n");
    expect(git(dest, "status", "--porcelain")).toBe("?? only-here.txt");
  });
});
