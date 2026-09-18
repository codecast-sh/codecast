/**
 * The shared typecheck: tsc's watch output folds into a state file one pass
 * at a time, and the client answers from the last finished pass, waits for a
 * pass in flight, and starts a watcher when none runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";
import * as os from "node:os";
import { checkProject, classifyWatchLine, IDLE_EXIT_MS, makeRoom, shouldIdleExit, tscBinary, tscInTree, nearestTsconfig, outputPath, readCheckConfig, readWatchState, resolveProjects, slugOf, watchDir, watchReducer, writeWatchState, type WatchState } from "./check.js";

let isolation: IsolatedCodecastDir;
beforeEach(() => {
  isolation = isolateCodecastDir("cast-check-test-");
});
afterEach(() => {
  isolation.restore();
});

describe("classifyWatchLine", () => {
  test("tsc's watch markers", () => {
    expect(classifyWatchLine("[9:41:02 AM] Starting compilation in watch mode...")).toEqual({ kind: "start" });
    expect(classifyWatchLine("[9:42:10 AM] File change detected. Starting incremental compilation...")).toEqual({ kind: "start" });
    expect(classifyWatchLine("[9:42:14 AM] Found 3 errors. Watching for file changes.")).toEqual({ kind: "done", errors: 3 });
    expect(classifyWatchLine("[9:42:14 AM] Found 1 error. Watching for file changes.")).toEqual({ kind: "done", errors: 1 });
    expect(classifyWatchLine("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.")).toEqual({ kind: "line" });
  });
});

describe("watchReducer", () => {
  test("a pass collects its diagnostics and lands them whole when it ends", () => {
    const dir = watchDir("/tree", "cli");
    const state: WatchState = { pid: process.pid, project: "cli", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true };
    const reduce = watchReducer(dir, state);
    reduce("[9:41:02 AM] Starting compilation in watch mode...");
    reduce("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.");
    reduce("");
    expect(readWatchState(dir)?.inProgress).toBe(true);
    expect(fs.existsSync(outputPath(dir))).toBe(false);
    reduce("[9:41:40 AM] Found 1 error. Watching for file changes.");
    expect(readWatchState(dir)).toMatchObject({ inProgress: false, errors: 1 });
    expect(fs.readFileSync(outputPath(dir), "utf-8")).toBe("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n");
    // The next pass replaces, never appends.
    reduce("[9:42:10 AM] File change detected. Starting incremental compilation...");
    reduce("[9:42:14 AM] Found 0 errors. Watching for file changes.");
    expect(readWatchState(dir)).toMatchObject({ inProgress: false, errors: 0 });
    expect(fs.readFileSync(outputPath(dir), "utf-8")).toBe("\n");
  });
});

describe("checkProject", () => {
  test("answers from the last finished pass of a running watcher, and marks the ask", async () => {
    const dir = watchDir("/tree", "web");
    writeWatchState(dir, { pid: process.pid, project: "web", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: false, finishedAt: Date.now() - 1000, errors: 2 });
    fs.writeFileSync(outputPath(dir), "a.ts(1,1): error TS1\n");
    let starts = 0;
    const r = await checkProject({ name: "web", tsconfig: "x" }, "/tree", { start: () => { starts++; } });
    expect(r).toMatchObject({ errors: 2, diagnostics: "a.ts(1,1): error TS1\n", started: false });
    expect(starts).toBe(0);
    expect(readWatchState(dir)?.askedAt).toBeGreaterThan(Date.now() - 5_000);
  });

  test("waits for a pass in flight", async () => {
    const dir = watchDir("/tree", "cli");
    writeWatchState(dir, { pid: process.pid, project: "cli", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true });
    setTimeout(() => {
      writeWatchState(dir, { ...readWatchState(dir)!, inProgress: false, finishedAt: Date.now(), errors: 0 });
      fs.writeFileSync(outputPath(dir), "\n");
    }, 1200);
    const r = await checkProject({ name: "cli", tsconfig: "x" }, "/tree", { start: () => {} });
    expect(r.errors).toBe(0);
  });

  test("starts a watcher when none runs, and reports one that never comes up", async () => {
    const dir = watchDir("/tree", "convex");
    let starts = 0;
    const start = () => {
      starts++;
      setTimeout(() => writeWatchState(dir, { pid: process.pid, project: "convex", tsconfig: "x", root: "/tree", startedAt: Date.now(), inProgress: false, finishedAt: Date.now(), errors: 0 }), 100);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath(dir), "\n");
    };
    const r = await checkProject({ name: "convex", tsconfig: "x" }, "/tree", { start });
    expect(r.started).toBe(true);
    expect(starts).toBe(1);
    // A dead pid is a watcher to replace.
    writeWatchState(dir, { ...readWatchState(dir)!, pid: 999999999 });
    await checkProject({ name: "convex", tsconfig: "x" }, "/tree", { start });
    expect(starts).toBe(2);
  });
});

describe("a corrected tsconfig path", () => {
  test("a watcher built on another tsconfig is replaced, not trusted", async () => {
    const dir = watchDir("/tree", "cli");
    writeWatchState(dir, { pid: process.pid, project: "cli", tsconfig: "packages/cli/tsconfig.json", root: "/tree", startedAt: 1, inProgress: false, finishedAt: Date.now(), errors: 149 });
    fs.writeFileSync(outputPath(dir), "old.ts(1,1): error TS6059\n");
    const notes: string[] = [];
    const killed: number[] = [];
    let starts = 0;
    const r = await checkProject({ name: "cli", tsconfig: "packages/cli/tsconfig.typecheck.json" }, "/tree", {
      note: (l) => notes.push(l),
      kill: (pid) => killed.push(pid),
      start: () => {
        starts++;
        writeWatchState(dir, { pid: process.pid, project: "cli", tsconfig: "packages/cli/tsconfig.typecheck.json", root: "/tree", startedAt: Date.now(), inProgress: false, finishedAt: Date.now(), errors: 1 });
        fs.writeFileSync(outputPath(dir), "real.ts(1,1): error TS2353\n");
      },
    });
    expect(starts).toBe(1);
    expect(killed).toEqual([process.pid]);
    expect(r.errors).toBe(1);
    expect(r.diagnostics).toContain("TS2353");
    expect(notes.some((n) => /now names packages\/cli\/tsconfig\.typecheck\.json/.test(n))).toBe(true);
  });

  test("the same tsconfig keeps the running watcher", async () => {
    const dir = watchDir("/tree2", "web");
    writeWatchState(dir, { pid: process.pid, project: "web", tsconfig: "packages/web/tsconfig.json", root: "/tree2", startedAt: 1, inProgress: false, finishedAt: Date.now(), errors: 0 });
    fs.writeFileSync(outputPath(dir), "\n");
    let starts = 0;
    const r = await checkProject({ name: "web", tsconfig: "packages/web/tsconfig.json" }, "/tree2", { start: () => starts++ });
    expect(starts).toBe(0);
    expect(r.started).toBe(false);
  });
});

describe("which programs a tree carries", () => {
  let tree: string;
  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "cast-check-tree-"));
    for (const d of ["packages/a", "packages/b", "packages/b/deep"]) fs.mkdirSync(path.join(tree, d), { recursive: true });
    fs.writeFileSync(path.join(tree, "packages/a/tsconfig.json"), "{}");
    fs.writeFileSync(path.join(tree, "packages/b/tsconfig.json"), "{}");
  });
  afterEach(() => fs.rmSync(tree, { recursive: true, force: true }));

  test("names come from .codecast/check.toml, and every listed project is the default set", () => {
    fs.mkdirSync(path.join(tree, ".codecast"));
    fs.writeFileSync(path.join(tree, ".codecast/check.toml"), '[projects]\na = "packages/a/tsconfig.json"\nb = "packages/b/tsconfig.json"\ngone = "packages/gone/tsconfig.json"\n');
    expect(readCheckConfig(tree)).toEqual([
      { name: "a", tsconfig: "packages/a/tsconfig.json" },
      { name: "b", tsconfig: "packages/b/tsconfig.json" },
      { name: "gone", tsconfig: "packages/gone/tsconfig.json" },
    ]);
    // A listed program that is not in this tree (a worktree from before it existed) is skipped, not an error.
    expect(resolveProjects(tree, [], tree).map((p) => p.name)).toEqual(["a", "b"]);
    expect(resolveProjects(tree, ["b"], tree)).toEqual([{ name: "b", tsconfig: "packages/b/tsconfig.json" }]);
    expect(() => resolveProjects(tree, ["nope"], tree)).toThrow(/one of a, b, gone/);
  });

  test("a malformed config is named, not guessed around", () => {
    fs.mkdirSync(path.join(tree, ".codecast"));
    fs.writeFileSync(path.join(tree, ".codecast/check.toml"), "[projects]\na = 3\n");
    expect(() => readCheckConfig(tree)).toThrow(/projects.a must be a tsconfig path/);
    fs.writeFileSync(path.join(tree, ".codecast/check.toml"), "[setup]\n");
    expect(() => readCheckConfig(tree)).toThrow(/\[projects\] table/);
  });

  test("without a config, the program nearest the caller's directory is the default", () => {
    expect(nearestTsconfig(tree, path.join(tree, "packages/b/deep"))).toBe("packages/b/tsconfig.json");
    expect(nearestTsconfig(tree, tree)).toBeNull();
    expect(resolveProjects(tree, [], path.join(tree, "packages/b/deep"))).toEqual([{ name: "packages-b", tsconfig: "packages/b/tsconfig.json" }]);
    expect(() => resolveProjects(tree, [], tree)).toThrow(/no tsconfig.json between/);
  });

  test("a project can be named by its directory or its tsconfig, inside the tree only", () => {
    expect(resolveProjects(tree, ["packages/a"], tree)).toEqual([{ name: "packages-a", tsconfig: "packages/a/tsconfig.json" }]);
    expect(resolveProjects(tree, ["packages/a/tsconfig.json"], tree)).toEqual([{ name: "packages-a", tsconfig: "packages/a/tsconfig.json" }]);
    expect(resolveProjects(tree, ["a"], path.join(tree, "packages"))).toEqual([{ name: "packages-a", tsconfig: "packages/a/tsconfig.json" }]);
    expect(() => resolveProjects(tree, [os.tmpdir()], tree)).toThrow(/unknown project/);
    expect(slugOf("")).toBe("root");
    expect(slugOf("./packages/cli")).toBe("packages-cli");
  });
});

describe("which TypeScript runs the check", () => {
  let tree: string;
  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "cast-check-tsc-"));
    fs.mkdirSync(path.join(tree, "pkgs/api"), { recursive: true });
    fs.writeFileSync(path.join(tree, "pkgs/api/tsconfig.json"), "{}");
  });
  afterEach(() => fs.rmSync(tree, { recursive: true, force: true }));

  const install = (rel: string) => {
    const bin = path.join(tree, rel, "node_modules/.bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tsc"), "#!/bin/sh\n");
    return path.join(bin, "tsc");
  };

  test("the project's own tsc wins over one installed above it", () => {
    const above = install("pkgs");
    expect(tscInTree(tree, "pkgs/api/tsconfig.json")).toBe(above);
    const beside = install("pkgs/api");
    expect(tscInTree(tree, "pkgs/api/tsconfig.json")).toBe(beside);
  });

  test("deps installed at an intermediate directory are found, not skipped", () => {
    // The bug: only the tsconfig's own directory and the tree root were tried,
    // so a workspace package installed one level up fell through to PATH.
    const mid = install("pkgs");
    expect(tscInTree(tree, "pkgs/api/tsconfig.json")).toBe(mid);
    expect(tscBinary(tree, "pkgs/api/tsconfig.json")).toBe(mid);
  });

  test("the tree root counts, and a tree with none says so", () => {
    expect(tscInTree(tree, "pkgs/api/tsconfig.json")).toBeNull();
    expect(tscBinary(tree, "pkgs/api/tsconfig.json")).toBe("tsc");
    const atRoot = install(".");
    expect(tscInTree(tree, "pkgs/api/tsconfig.json")).toBe(atRoot);
  });

  test("errors from PATH's tsc are reported as another compiler's", async () => {
    // "/tree-global" has no node_modules anywhere, which is what makes the
    // check fall through to PATH; the warning is derived from that, not from
    // the state file, so a watcher started by an older CLI is judged correctly.
    const dir = watchDir("/tree-global", "api");
    writeWatchState(dir, { pid: process.pid, project: "api", tsconfig: "pkgs/api/tsconfig.json", root: "/tree-global", startedAt: 1, inProgress: false, finishedAt: Date.now(), errors: 1969 });
    fs.writeFileSync(outputPath(dir), "a.ts(1,1): error TS7006\n");
    const notes: string[] = [];
    const r = await checkProject({ name: "api", tsconfig: "pkgs/api/tsconfig.json" }, "/tree-global", { start: () => {}, note: (l) => notes.push(l) });
    expect(r.errors).toBe(1969);
    expect(notes.some((n) => /checked by the tsc on PATH/.test(n))).toBe(true);
    // A clean pass from PATH's tsc needs no warning: nothing is being misread.
    writeWatchState(dir, { ...readWatchState(dir)!, errors: 0 });
    const clean = await checkProject({ name: "api", tsconfig: "pkgs/api/tsconfig.json" }, "/tree-global", { start: () => {}, note: (l) => notes.push("clean:" + l) });
    expect(clean.errors).toBe(0);
    expect(notes.some((n) => n.startsWith("clean:") && /PATH/.test(n))).toBe(false);
  });

  test("a tree that does have tsc is never accused of using PATH's", async () => {
    install("pkgs/api");
    const dir = watchDir(tree, "api");
    writeWatchState(dir, { pid: process.pid, project: "api", tsconfig: "pkgs/api/tsconfig.json", root: tree, startedAt: 1, inProgress: false, finishedAt: Date.now(), errors: 3 });
    fs.writeFileSync(outputPath(dir), "a.ts(1,1): error TS2345\n");
    const notes: string[] = [];
    const r = await checkProject({ name: "api", tsconfig: "pkgs/api/tsconfig.json" }, tree, { start: () => {}, note: (l) => notes.push(l) });
    expect(r.errors).toBe(3);
    expect(notes.some((n) => /PATH/.test(n))).toBe(false);
  });
});

describe("the machine wide watcher cap", () => {
  test("the least recently asked watchers are stopped to make room, and their state files go with them", () => {
    const now = Date.now();
    const seed = (root: string, project: string, askedAt: number) =>
      writeWatchState(watchDir(root, project), { pid: process.pid, project, tsconfig: "x", root, startedAt: 1, inProgress: false, finishedAt: now, errors: 0, askedAt });
    seed("/t1", "a", now - 3_000);
    seed("/t1", "b", now - 1_000);
    seed("/t2", "a", now - 2_000);
    const killed: number[] = [];
    const evicted = makeRoom(2, (pid) => killed.push(pid));
    expect(evicted.map((w) => `${w.root}/${w.project}`)).toEqual(["/t1/a", "/t2/a"]);
    expect(killed).toHaveLength(2);
    expect(readWatchState(watchDir("/t1", "a"))).toBeNull();
    expect(readWatchState(watchDir("/t1", "b"))).not.toBeNull();
    // A state file whose pid is dead is cleared on listing rather than counted.
    writeWatchState(watchDir("/t3", "z"), { pid: 999999999, project: "z", tsconfig: "x", root: "/t3", startedAt: 1, inProgress: true });
    expect(makeRoom(2, () => {})).toEqual([]);
    expect(readWatchState(watchDir("/t3", "z"))).toBeNull();
  });
});

describe("idle exit", () => {
  test("a watcher exits only when idle past the window, and never while a pass is in flight", () => {
    const t = 10_000_000;
    const base = { startedAt: t - 2 * IDLE_EXIT_MS, inProgress: false };
    expect(shouldIdleExit({ ...base, askedAt: t - IDLE_EXIT_MS - 1 }, t)).toBe(true);
    expect(shouldIdleExit({ ...base, askedAt: t - IDLE_EXIT_MS + 1 }, t)).toBe(false);
    // A pass that just finished is as good as an ask.
    expect(shouldIdleExit({ ...base, askedAt: t - 2 * IDLE_EXIT_MS, finishedAt: t - 1000 }, t)).toBe(false);
    // A first pass still building on a loaded machine is not idle, however old.
    expect(shouldIdleExit({ ...base, inProgress: true, askedAt: t - 3 * IDLE_EXIT_MS }, t)).toBe(false);
  });
});
