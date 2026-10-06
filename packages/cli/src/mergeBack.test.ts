import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Each case runs a dozen git processes; a loaded machine takes seconds for them.
setDefaultTimeout(60_000);
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { mergeBack, worktreeMatchesMergedBack } from "./mergeBack.js";

let root: string;
let parent: string;
let worker: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dir: string, file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
};
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf-8");
const lines = (...ls: string[]) => ls.join("\n") + "\n";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-back-test-"));
  parent = path.join(root, "repo");
  fs.mkdirSync(parent);
  git(parent, "init", "-q", "-b", "main");
  git(parent, "config", "user.email", "t@t");
  git(parent, "config", "user.name", "t");
  write(parent, "a.txt", lines("alpha one", "alpha two", "alpha three", "alpha four", "alpha five", "alpha six", "alpha seven"));
  write(parent, "gone.txt", "to be deleted\n");
  write(parent, "shared.txt", lines("shared line one", "shared line two"));
  git(parent, "add", "-A");
  git(parent, "commit", "-qm", "base");
  worker = path.join(parent, ".codecast", "worktrees", "w1");
  git(parent, "worktree", "add", "-q", "-b", "codecast/w1", worker);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("mergeBack", () => {
  test("brings edits, new files and deletions into an untouched parent", async () => {
    write(worker, "a.txt", read(worker, "a.txt").replace("alpha two", "ALPHA TWO"));
    write(worker, "src/new.ts", "export const x = 1;\n");
    fs.rmSync(path.join(worker, "gone.txt"));
    const r = await mergeBack(worker, parent);
    expect(r).toEqual({ state: "merged", files: ["a.txt", "gone.txt", "src/new.ts"] });
    expect(read(parent, "a.txt")).toContain("ALPHA TWO");
    expect(read(parent, "src/new.ts")).toBe("export const x = 1;\n");
    expect(fs.existsSync(path.join(parent, "gone.txt"))).toBe(false);
    // Nothing is committed in the parent.
    expect(git(parent, "status", "--porcelain")).toContain("a.txt");
  });

  test("merges around the parent's own edits to other lines of the same file", async () => {
    write(parent, "a.txt", read(parent, "a.txt").replace("alpha six", "PARENT SIX"));
    write(worker, "a.txt", read(worker, "a.txt").replace("alpha one", "WORKER ONE"));
    const r = await mergeBack(worker, parent);
    expect(r.state).toBe("merged");
    const merged = read(parent, "a.txt");
    expect(merged).toContain("WORKER ONE");
    expect(merged).toContain("PARENT SIX");
  });

  test("a conflict writes nothing, not even the files that would merge", async () => {
    write(parent, "a.txt", read(parent, "a.txt").replace("alpha three", "PARENT THREE"));
    write(worker, "a.txt", read(worker, "a.txt").replace("alpha three", "WORKER THREE"));
    write(worker, "shared.txt", lines("shared line one", "worker line two"));
    const before = read(parent, "shared.txt");
    const r = await mergeBack(worker, parent);
    expect(r).toEqual({ state: "conflict", files: ["a.txt"] });
    expect(read(parent, "shared.txt")).toBe(before);
    expect(read(parent, "a.txt")).toContain("PARENT THREE");
    // The worktree keeps the work.
    expect(read(worker, "a.txt")).toContain("WORKER THREE");
    expect(await worktreeMatchesMergedBack(worker)).toBe(false);
  });

  test("an edit against a deletion is a conflict", async () => {
    fs.rmSync(path.join(parent, "shared.txt"));
    write(worker, "shared.txt", lines("shared line one", "worker line two"));
    expect(await mergeBack(worker, parent)).toEqual({ state: "conflict", files: ["shared.txt"] });
  });

  test("a second merge brings only what changed since the first", async () => {
    write(worker, "a.txt", read(worker, "a.txt").replace("alpha one", "WORKER ONE"));
    expect((await mergeBack(worker, parent)).state).toBe("merged");
    expect(await worktreeMatchesMergedBack(worker)).toBe(true);
    // The parent reworks the merged line; the worker then edits elsewhere.
    write(parent, "a.txt", read(parent, "a.txt").replace("WORKER ONE", "PARENT REWORKED ONE"));
    write(worker, "a.txt", read(worker, "a.txt").replace("alpha seven", "WORKER SEVEN"));
    expect(await worktreeMatchesMergedBack(worker)).toBe(false);
    const r = await mergeBack(worker, parent);
    expect(r).toEqual({ state: "merged", files: ["a.txt"] });
    const merged = read(parent, "a.txt");
    expect(merged).toContain("PARENT REWORKED ONE");
    expect(merged).toContain("WORKER SEVEN");
  });

  test("a worker with no changes, or changes the parent already has, merges nothing", async () => {
    expect((await mergeBack(worker, parent)).state).toBe("empty");
    write(worker, "shared.txt", "same on both\n");
    write(parent, "shared.txt", "same on both\n");
    expect((await mergeBack(worker, parent)).state).toBe("empty");
  });

  test("refuses a target in another repository", async () => {
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    git(other, "init", "-q");
    const r = await mergeBack(worker, other);
    expect(r.state).toBe("failed");
  });
});
