import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { levelCheckout } from "./level.js";
import { replayOnto } from "./replay.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: os.tmpdir() };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();
const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf-8");

/** A bare origin, a shared checkout of it, and a second clone that pushes upstream work. */
function setup(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-level-test-"));
  dirs.push(root);
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  for (const [f, t] of Object.entries(files)) write(seed, f, t);
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", "--bare", seed, path.join(root, "origin.git")], { env: ENV });
  execFileSync("git", ["clone", "-q", path.join(root, "origin.git"), path.join(root, "shared")], { env: ENV });
  execFileSync("git", ["clone", "-q", path.join(root, "origin.git"), path.join(root, "other")], { env: ENV });
  const shared = path.join(root, "shared");
  const other = path.join(root, "other");
  const upstream = (changes: Record<string, string | null>, msg = "upstream") => {
    for (const [f, t] of Object.entries(changes)) t === null ? fs.rmSync(path.join(other, f)) : write(other, f, t);
    sh(other, "add", "-A");
    sh(other, "commit", "-qm", msg);
    sh(other, "push", "-q", "origin", "main");
    sh(shared, "fetch", "-q");
  };
  return { shared, other, upstream };
}

const status = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf-8", env: ENV }).replace(/\n$/, "");

describe("levelCheckout", () => {
  test("moves a dirty checkout onto upstream and keeps every local edit", async () => {
    const { shared, upstream } = setup({ "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" });
    upstream({ "b.ts": "b2\n", "new.ts": "new\n" });
    write(shared, "c.ts", "c-midturn\n");
    write(shared, "scratch.ts", "untracked\n");
    const r = await levelCheckout(shared, "origin/main");
    expect(r.ok).toBe(true);
    expect(r.written.sort()).toEqual(["b.ts", "new.ts"]);
    expect(sh(shared, "rev-parse", "HEAD")).toBe(sh(shared, "rev-parse", "origin/main"));
    expect(read(shared, "b.ts")).toBe("b2\n");
    expect(read(shared, "c.ts")).toBe("c-midturn\n");
    expect(status(shared).split("\n").sort()).toEqual([" M c.ts", "?? scratch.ts"]);
  });

  test("an edit that already landed upstream is absorbed, not reported dirty", async () => {
    const { shared, upstream } = setup({ "a.ts": "a\n" });
    upstream({ "a.ts": "a-landed\n", "added.ts": "x\n" });
    write(shared, "a.ts", "a-landed\n");
    write(shared, "added.ts", "x\n");
    const r = await levelCheckout(shared, "origin/main");
    expect(r.ok).toBe(true);
    expect(r.absorbed.sort()).toEqual(["a.ts", "added.ts"]);
    expect(status(shared)).toBe("");
  });

  test("a local edit and an upstream change to different lines merge three-way", async () => {
    const { shared, upstream } = setup({ "m.ts": "one\ntwo\nthree\nfour\nfive\n" });
    upstream({ "m.ts": "ONE\ntwo\nthree\nfour\nfive\n" });
    write(shared, "m.ts", "one\ntwo\nthree\nfour\nFIVE\n");
    const r = await levelCheckout(shared, "origin/main");
    expect(r.ok).toBe(true);
    expect(r.merged).toEqual(["m.ts"]);
    expect(read(shared, "m.ts")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(sh(shared, "diff")).toContain("+FIVE");
    expect(sh(shared, "diff")).not.toContain("-one");
  });

  test("a real conflict writes nothing and leaves HEAD where it was", async () => {
    const { shared, upstream } = setup({ "x.ts": "x\n", "y.ts": "y\n" });
    const before = sh(shared, "rev-parse", "HEAD");
    upstream({ "x.ts": "upstream\n", "y.ts": "y2\n" });
    write(shared, "x.ts", "local\n");
    const r = await levelCheckout(shared, "origin/main");
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(["x.ts"]);
    expect(sh(shared, "rev-parse", "HEAD")).toBe(before);
    expect(read(shared, "x.ts")).toBe("local\n");
    expect(read(shared, "y.ts")).toBe("y\n");
  });

  test("deletions upstream remove the file and its emptied directory", async () => {
    const { shared, upstream } = setup({ "keep.ts": "k\n", "gone/only.ts": "g\n" });
    upstream({ "gone/only.ts": null });
    const r = await levelCheckout(shared, "origin/main");
    expect(r.deleted).toEqual(["gone/only.ts"]);
    expect(fs.existsSync(path.join(shared, "gone"))).toBe(false);
    expect(status(shared)).toBe("");
  });

  test("refuses to drop local commits unless the caller replayed them", async () => {
    const { shared, upstream } = setup({ "a.ts": "a\n" });
    write(shared, "mine.ts", "m\n");
    sh(shared, "add", "mine.ts");
    sh(shared, "commit", "-qm", "local");
    upstream({ "u.ts": "u\n" });
    const r = await levelCheckout(shared, "origin/main");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("lacks");
  });
});

describe("replayOnto + level: the commit-in-place flow", () => {
  test("local commits replay onto upstream in memory, push, and level the dirty checkout", async () => {
    const { shared, upstream } = setup({ "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" });
    upstream({ "b.ts": "b2\n" });
    write(shared, "a.ts", "a-mine\n");
    sh(shared, "commit", "-qam", "local work");
    write(shared, "c.ts", "c-midturn\n");
    const r = await replayOnto(shared, "origin/main", "HEAD", "origin/main");
    if (!r.ok) throw new Error(r.reason);
    expect(r.unchanged).toBe(false);
    sh(shared, "push", "-q", "origin", `${r.tip}:main`);
    const lv = await levelCheckout(shared, r.tip, { rewritten: true });
    expect(lv.ok).toBe(true);
    expect(sh(shared, "log", "--format=%s")).toBe("local work\nupstream\nbase");
    expect(sh(shared, "log", "-1", "--format=%an")).toBe("t");
    expect(read(shared, "a.ts")).toBe("a-mine\n");
    expect(read(shared, "b.ts")).toBe("b2\n");
    expect(status(shared)).toBe(" M c.ts");
  });

  test("commits already on the new base keep their shas", async () => {
    const { shared } = setup({ "a.ts": "a\n" });
    write(shared, "a.ts", "a2\n");
    sh(shared, "commit", "-qam", "mine");
    const head = sh(shared, "rev-parse", "HEAD");
    const r = await replayOnto(shared, "origin/main", "HEAD", "origin/main");
    expect(r.ok && r.tip).toBe(head);
    expect(r.ok && r.unchanged).toBe(true);
  });

  test("a conflicting commit stops the replay and names the file", async () => {
    const { shared, upstream } = setup({ "a.ts": "a\n" });
    upstream({ "a.ts": "theirs\n" });
    write(shared, "a.ts", "ours\n");
    sh(shared, "commit", "-qam", "mine");
    const r = await replayOnto(shared, "HEAD~1", "HEAD", "origin/main");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts).toEqual(["a.ts"]);
  });
});

describe("levelOne (the daemon's sweep)", () => {
  const enable = (dir: string, on: boolean) => write(dir, ".codecast/workspace.toml", `[ship]\nlevel = ${on}\n`);

  test("levels an opted-in checkout behind its upstream and leaves local edits alone", async () => {
    const { levelOne } = await import("./levelSweep.js");
    const { shared, upstream } = setup({ "a.ts": "a\n" });
    enable(shared, true);
    sh(shared, "remote", "set-head", "origin", "main");
    upstream({ "b.ts": "b\n" });
    write(shared, "a.ts", "mine\n");
    const o = await levelOne(shared);
    expect("result" in o && o.result.ok).toBe(true);
    expect(read(shared, "b.ts")).toBe("b\n");
    expect(read(shared, "a.ts")).toBe("mine\n");
  });

  test("stands back when not opted in, when the checkout holds its own commits, or while a ship runs", async () => {
    const { levelOne } = await import("./levelSweep.js");
    const { shared, upstream } = setup({ "a.ts": "a\n" });
    sh(shared, "remote", "set-head", "origin", "main");
    upstream({ "b.ts": "b\n" });
    expect(await levelOne(shared)).toEqual({ root: shared, skipped: "level not enabled" });

    enable(shared, true);
    const lock = path.join(sh(shared, "rev-parse", "--absolute-git-dir"), "codecast", "ship.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, String(process.pid));
    expect(await levelOne(shared)).toEqual({ root: shared, skipped: "a ship is running" });
    fs.rmSync(lock);

    write(shared, "mine.ts", "m\n");
    sh(shared, "add", "mine.ts");
    sh(shared, "commit", "-qm", "local");
    expect(await levelOne(shared)).toEqual({ root: shared, skipped: "holds commits upstream lacks" });
  });
});

describe("a checkout diverged only by commits upstream already holds", () => {
  test("the sweep levels it, and a replay drops the duplicate instead of pushing it again", async () => {
    const { levelOne } = await import("./levelSweep.js");
    const { shared, other } = setup({ "a.ts": "a\n" });
    write(shared, ".codecast/workspace.toml", "[ship]\nlevel = true\n");
    sh(shared, "remote", "set-head", "origin", "main");
    write(shared, "post.md", "blog\n");
    sh(shared, "add", "post.md");
    sh(shared, "commit", "-qm", "docs: blog post");
    // The same change lands upstream from elsewhere, with another sha.
    write(other, "post.md", "blog\n");
    sh(other, "add", "post.md");
    sh(other, "commit", "-qm", "docs: blog post (pushed from a worktree)");
    write(other, "later.ts", "l\n");
    sh(other, "add", "later.ts");
    sh(other, "commit", "-qm", "later work");
    sh(other, "push", "-q", "origin", "main");
    sh(shared, "fetch", "-q");

    const r = await replayOnto(shared, "origin/main", "HEAD", "origin/main");
    expect(r.ok && r.dropped.length).toBe(1);
    expect(r.ok && r.tip).toBe(sh(shared, "rev-parse", "origin/main"));

    const o = await levelOne(shared);
    expect("result" in o && o.result.ok).toBe(true);
    expect(sh(shared, "rev-parse", "HEAD")).toBe(sh(shared, "rev-parse", "origin/main"));
    expect(read(shared, "later.ts")).toBe("l\n");
  });
});
