import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeSkipped, remoteSideCommand, runSide, type LandResult, type SnapshotResult } from "./syncSide.js";

// Every case spawns a dozen git processes; a loaded machine needs the room.
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const write = (root: string, rel: string, body: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };

function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sync-side-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  write(d, ".gitignore", "node_modules/\n.env\ndist/\n*.log\n");
  write(d, "a.txt", "one\n");
  write(d, "dist/keep.js", "v1\n");
  git(d, "add", "-A");
  git(d, "add", "-f", "dist/keep.js");
  git(d, "commit", "-qm", "base");
  return d;
}

/** A second checkout of the same history, the way a host worktree is one. */
function clone(src: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sync-side-b-"));
  dirs.push(d);
  fs.rmSync(d, { recursive: true });
  execFileSync("git", ["clone", "-q", src, d]);
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  return d;
}

const files = (cwd: string, tree: string) => git(cwd, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean).sort();
const snap = (cwd: string, extra: object = {}) => runSide<SnapshotResult>({ op: "snapshot", cwd, ...extra });

describe("what travels", () => {
  test("gitignored files travel; dependency folders, oversized files, process files and nested repos stay", async () => {
    const d = repo();
    write(d, ".env", "SECRET=1\n");
    write(d, "node_modules/x/i.js", "m\n");
    write(d, "dist/junk.js", "j\n");
    write(d, "run.log", "log\n");
    write(d, "big.bin", Buffer.alloc(500 * 1024));
    write(d, "app.sock", "");
    write(d, "renders/film.mp4", "not really a film");
    write(d, "bin/tool", Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.alloc(300 * 1024)]));
    write(d, "web/dist-ssr/x.js", "built\n");
    fs.mkdirSync(path.join(d, "inner"));
    git(path.join(d, "inner"), "init", "-q");
    const r = await snap(d, { scope: { maxFileBytes: 400 * 1024 } });
    expect(files(d, r.tree)).toEqual([".env", ".gitignore", "a.txt", "dist/keep.js", "run.log"]);
    expect(Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]))).toEqual({ "node_modules/": "rebuilt", "dist/": "rebuilt", "web/dist-ssr/": "rebuilt", "big.bin": "large", "app.sock": "live", "renders/film.mp4": "media", "bin/tool": "binary", "inner/": "repo" });
  });

  test("a tracked file inside a skipped folder travels as it is now", async () => {
    const d = repo();
    write(d, "dist/keep.js", "v2\n");
    const r = await snap(d);
    expect(git(d, "show", `${r.tree}:dist/keep.js`)).toBe("v2");
  });

  test("a tracked file over the limit still travels", async () => {
    const d = repo();
    write(d, "a.txt", "x".repeat(5000));
    const r = await snap(d, { scope: { maxFileBytes: 1000 } });
    expect(files(d, r.tree)).toContain("a.txt");
    expect(r.skipped.filter((x) => x.reason === "large")).toEqual([]);
  });

  test("always lifts a default rule and never adds one", async () => {
    const d = repo();
    write(d, "node_modules/patched/index.js", "p\n");
    write(d, "node_modules/other/index.js", "o\n");
    write(d, "data/local.db", "db\n");
    write(d, "notes.md", "n\n");
    const r = await snap(d, { scope: { always: ["node_modules/patched"], never: ["data", "*.md"] } });
    const list = files(d, r.tree);
    expect(list).toContain("node_modules/patched/index.js");
    expect(list).not.toContain("node_modules/other/index.js");
    expect(list).not.toContain("data/local.db");
    expect(list).not.toContain("notes.md");
  });

  test("over the total limit the largest untracked files stay, and are named", async () => {
    const d = repo();
    write(d, "s1", Buffer.alloc(300));
    write(d, "s2", Buffer.alloc(400));
    write(d, "huge", Buffer.alloc(900));
    const r = await snap(d, { scope: { maxTotalBytes: 1000 } });
    expect(files(d, r.tree)).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(r.skipped.filter((x) => x.reason === "total")).toEqual([{ path: "huge", reason: "total", bytes: 900 }]);
  });

  test("codecast's own per-machine folders never travel", async () => {
    const d = repo();
    write(d, ".codecast/worktrees/x/f", "1");
    write(d, ".codecast/workspace.toml", "[x]\n");
    const r = await snap(d);
    expect(files(d, r.tree)).toContain(".codecast/workspace.toml");
    expect(files(d, r.tree)).not.toContain(".codecast/worktrees/x/f");
  });

  test("the real index is untouched and the snapshot is a commit on HEAD carrying the branch", async () => {
    const d = repo();
    write(d, "a.txt", "two\n");
    git(d, "add", "a.txt");
    write(d, "a.txt", "three\n");
    const before = git(d, "status", "--porcelain");
    const r = await snap(d, { commit: true, ref: "refs/codecast/sync/test" });
    expect(git(d, "status", "--porcelain")).toBe(before);
    expect(git(d, "rev-parse", `${r.sha}^`)).toBe(r.head);
    expect(git(d, "rev-parse", "refs/codecast/sync/test")).toBe(r.sha!);
    expect(git(d, "show", "-s", "--format=%B", r.sha!)).toContain("codecast-branch: main");
    expect(git(d, "show", `${r.tree}:a.txt`)).toBe("three");
  });

  test("the same tree gives the same commit, taken twice", async () => {
    const d = repo();
    write(d, "b.txt", "b\n");
    const a = await snap(d, { commit: true });
    const b = await snap(d, { commit: true });
    expect(a.sha).toBe(b.sha!);
  });
});

describe("landing", () => {
  async function pair() {
    const a = repo();
    const b = clone(a);
    return { a, b, base: (await snap(b)).tree };
  }

  test("adds, edits and deletes land, gitignored files included, and nothing is staged", async () => {
    const { a, b, base } = await pair();
    write(a, "a.txt", "edited\n");
    write(a, "new.txt", "n\n");
    write(a, ".env", "K=1\n");
    fs.rmSync(path.join(a, "dist/keep.js"));
    const s = await snap(a, { commit: true });
    git(b, "fetch", "-q", a, s.sha!);
    const r = await runSide<LandResult>({ op: "land", cwd: b, sha: s.sha!, expectTree: base });
    expect(r.landed).toBe(true);
    expect(fs.readFileSync(path.join(b, "a.txt"), "utf8")).toBe("edited\n");
    expect(fs.readFileSync(path.join(b, ".env"), "utf8")).toBe("K=1\n");
    expect(fs.existsSync(path.join(b, "dist/keep.js"))).toBe(false);
    expect(git(b, "diff", "--cached", "--name-only")).toBe("");
    expect((await snap(b)).tree).toBe(s.tree);

    // And a gitignored file deleted on the source is deleted here.
    fs.rmSync(path.join(a, ".env"));
    const s2 = await snap(a, { commit: true });
    git(b, "fetch", "-q", a, s2.sha!);
    await runSide<LandResult>({ op: "land", cwd: b, sha: s2.sha!, expectTree: s.tree });
    expect(fs.existsSync(path.join(b, ".env"))).toBe(false);
  });

  test("only changed files are written: the rest keep their bytes and times", async () => {
    const { a, b, base } = await pair();
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(b, "a.txt"), old, old);
    write(a, "b.txt", "new\n");
    const s = await snap(a, { commit: true });
    git(b, "fetch", "-q", a, s.sha!);
    const r = await runSide<LandResult>({ op: "land", cwd: b, sha: s.sha!, expectTree: base });
    expect(r).toMatchObject({ landed: true, changed: ["b.txt"] });
    expect(fs.statSync(path.join(b, "a.txt")).mtimeMs).toBe(old.getTime());
  });

  test("an executable bit, a symlink, and a file taking a folder's place all land", async () => {
    const { a, b, base } = await pair();
    write(a, "run.sh", "#!/bin/sh\necho hi\n");
    fs.chmodSync(path.join(a, "run.sh"), 0o755);
    fs.symlinkSync("a.txt", path.join(a, "link"));
    fs.rmSync(path.join(a, "dist"), { recursive: true });
    write(a, "dist", "now a file\n");
    git(a, "add", "-f", "dist");
    const s = await snap(a, { commit: true });
    git(b, "fetch", "-q", a, s.sha!);
    expect((await runSide<LandResult>({ op: "land", cwd: b, sha: s.sha!, expectTree: base })).landed).toBe(true);
    expect(fs.statSync(path.join(b, "run.sh")).mode & 0o111).toBeGreaterThan(0);
    expect(fs.readlinkSync(path.join(b, "link"))).toBe("a.txt");
    expect(fs.readFileSync(path.join(b, "dist"), "utf8")).toBe("now a file\n");
    expect((await snap(b)).tree).toBe(s.tree);
  });

  test("refuses, changing nothing, when this side moved since it was read", async () => {
    const { a, b, base } = await pair();
    write(a, "a.txt", "from a\n");
    const s = await snap(a, { commit: true });
    git(b, "fetch", "-q", a, s.sha!);
    write(b, "a.txt", "typed here a moment ago\n");
    const r = await runSide<LandResult>({ op: "land", cwd: b, sha: s.sha!, expectTree: base });
    expect(r).toMatchObject({ landed: false, reason: "moved" });
    expect(fs.readFileSync(path.join(b, "a.txt"), "utf8")).toBe("typed here a moment ago\n");
  });

  test("files that stay behind are left alone by a landing", async () => {
    const { a, b, base } = await pair();
    write(b, "node_modules/x/i.js", "host build\n");
    write(a, "a.txt", "e\n");
    const s = await snap(a, { commit: true });
    git(b, "fetch", "-q", a, s.sha!);
    const r = await runSide<LandResult>({ op: "land", cwd: b, sha: s.sha!, expectTree: base });
    expect(r.landed).toBe(true);
    expect(fs.readFileSync(path.join(b, "node_modules/x/i.js"), "utf8")).toBe("host build\n");
  });

  test("moving HEAD keeps a commit made only here under a backup ref", async () => {
    const { a, b, base } = await pair();
    write(b, "mine.txt", "m\n");
    git(b, "add", "mine.txt");
    git(b, "commit", "-qm", "local only");
    const mine = git(b, "rev-parse", "HEAD");
    const now = (await snap(b)).tree;
    const s = await snap(a, { commit: true });
    git(b, "fetch", "-q", a, s.sha!);
    const r = await runSide<LandResult>({ op: "land", cwd: b, sha: s.sha!, expectTree: now, moveHead: s.head, backupPrefix: "refs/codecast/backup/sync" });
    expect(r.landed).toBe(true);
    expect(git(b, "rev-parse", "HEAD")).toBe(s.head);
    if (!r.landed) throw new Error("unreachable");
    expect(git(b, "rev-parse", r.backupRef!)).toBe(mine);
    void base;
  });
});

describe("the host command", () => {
  test("runs the same program through bun and answers in JSON", () => {
    const d = repo();
    write(d, ".env", "X=1\n");
    const cmd = remoteSideCommand({ op: "snapshot", cwd: d });
    const r = JSON.parse(execFileSync("bash", ["-c", cmd], { encoding: "utf8" })) as SnapshotResult;
    expect(git(d, "ls-tree", "-r", "--name-only", r.tree)).toContain(".env");
  });

  test("names what it skipped in words", () => {
    expect(describeSkipped({ path: "big.mov", reason: "large", bytes: 300 * 1048576 })).toBe("big.mov (300 MB): over the per-file limit");
    expect(describeSkipped({ path: "node_modules/", reason: "rebuilt" })).toBe("node_modules/: rebuilt on each machine");
  });
});
