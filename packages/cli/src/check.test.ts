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
import { spawnSync } from "node:child_process";
import { heapCapMb, heapDeath, isNativeFrame, tscNodeOptions, TSC_HEAP_MB } from "./checkHeap.js";
import { CheckFailure, summarize } from "./checkOutcome.js";
import { acquireFileLock } from "./lockFile.js";
import { EXIT_BUSY } from "./infraExit.js";
import { listWatchers, removeOwnState, stopWatcher, watcherIdentity, checkProject, lastLogLine, logPath, classifyWatchLine, filesNotAsChecked, unlistedChanges, projectsTouching, buildInfoPath, IDLE_EXIT_MS, STUCK_PASS_MS, watcherExit, tscBinary, tscInTree, nearestTsconfig, outputPath, readCheckConfig, readWatchState, resolveProjects, slugOf, watchDir, watchReducer, writeWatchState, type WatchState } from "./check.js";
import { tscFileVersion } from "./tscFileVersion.js";

let isolation: IsolatedCodecastDir;
const realIdentity = watcherIdentity.matches;
beforeEach(() => {
  isolation = isolateCodecastDir("cast-check-test-");
  // These tests stand in for a watcher with their own pid.
  watcherIdentity.matches = (command, pid) => pid === process.pid || realIdentity(command, pid);
});
afterEach(() => {
  isolation.restore();
  watcherIdentity.matches = realIdentity;
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
  test("compiler output preserves requests made since its last output", () => {
    const dir = watchDir("/tree", "cli");
    const state: WatchState = { pid: process.pid, project: "cli", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true, askedAt: 10 };
    writeWatchState(dir, state);
    const reduce = watchReducer(dir, state);
    writeWatchState(dir, { ...state, askedAt: 100 });
    reduce("Found 0 errors. Watching for file changes.");
    expect(readWatchState(dir)?.askedAt).toBe(100);
    writeWatchState(dir, { ...state, startedAt: 2, askedAt: 20 });
    expect(readWatchState(dir)?.askedAt).toBe(20);
  });

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

  test("a dead watcher's last pass is never the answer: the ask waits for the new watcher's", async () => {
    const dir = watchDir("/tree", "mobile");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath(dir), "\n");
    writeWatchState(dir, { pid: 999999999, project: "mobile", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: false, finishedAt: Date.now() - 60_000, errors: 7 });
    const start = () => {
      setTimeout(() => writeWatchState(dir, { pid: process.pid, project: "mobile", tsconfig: "x", root: "/tree", startedAt: Date.now(), inProgress: false, finishedAt: Date.now(), errors: 0 }), 1_500);
    };
    const r = await checkProject({ name: "mobile", tsconfig: "x" }, "/tree", { start });
    expect(r.started).toBe(true);
    expect(r.errors).toBe(0);
  });
});

describe("an answer describes the files on disk", () => {
  /** A tree with one file, and a watcher state whose last pass recorded `recorded` as that file's content. */
  function treeWithPass(recorded: string, onDisk: string, errors: number) {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "check-disk-"));
    const file = path.join(tree, "a.ts");
    fs.writeFileSync(file, onDisk);
    const dir = watchDir(tree, "app");
    const pass = (content: string, errorCount: number, finishedAt: number) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: [path.relative(dir, file)], fileInfos: [{ version: tscFileVersion(Buffer.from(content)) }] }));
      writeWatchState(dir, { pid: process.pid, project: "app", tsconfig: "x", root: tree, startedAt: 1, inProgress: false, finishedAt, errors: errorCount });
    };
    pass(recorded, errors, Date.now());
    return { tree, dir, file, pass };
  }

  test("a file's version is the one tsc records for it", () => {
    const ts = require("typescript");
    for (const text of ["export const x = 1;\n", "\ufeffexport const y = 2;\r\n", "export {};\n//# sourceMappingURL=a.js.map\n\n", "export {};\n//# sourceMappingURL=a.js.map\nconst z = 1;\n"]) {
      expect(tscFileVersion(Buffer.from(text))).toBe(ts.getSourceFileVersionAsHashFromText({ createHash: ts.sys.createHash }, text.replace(/^\ufeff/, "")));
    }
  });

  test("the files a pass checked differently from the disk are named, and only those", () => {
    const { dir, file } = treeWithPass("export const x = 1;\n", "export const x = 1;\nexport const y = 2;\n", 1);
    expect(filesNotAsChecked(dir)).toEqual([file]);
    fs.writeFileSync(file, "export const x = 1;\n");
    expect(filesNotAsChecked(dir)).toEqual([]);
    // TypeScript before 5.6 nests the program under `program`.
    fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ program: JSON.parse(fs.readFileSync(buildInfoPath(dir), "utf-8")), version: "5.1.6" }));
    expect(filesNotAsChecked(dir)).toEqual([]);
  });

  test("a pass that read a file before its latest change is not the answer; the pass after it is", async () => {
    const fixed = "export const x = 1;\nexport const y = 2;\n";
    const { tree, pass } = treeWithPass("export const x = 1;\n", fixed, 1);
    setTimeout(() => pass(fixed, 0, Date.now()), 400);
    const r = await checkProject({ name: "app", tsconfig: "x" }, tree, { start: () => {} });
    expect(r.errors).toBe(0);
  });

  test("a watcher that never sees the change is named as behind, with the way out, and nothing is stopped", async () => {
    const { tree } = treeWithPass("export const x = 1;\n", "export const x = 1;\nexport const y = 2;\n", 1);
    const killed: number[] = [];
    const err = await checkProject({ name: "app", tsconfig: "x" }, tree, { start: () => {}, kill: (pid) => killed.push(pid), unseenGraceMs: 300 }).catch((e) => e);
    expect(err.message).toMatch(/has not checked a\.ts as it is on disk/);
    expect(summarize([{ project: "app", failure: err }])).toEqual({ exit: EXIT_BUSY, hint: expect.stringContaining("cast check --fresh app") });
    expect(killed).toEqual([]);
  });

  test("files the pass does not list count too: a new file the globs take in, and a config written since the pass began", () => {
    const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "check-unlisted-")));
    const ts = path.dirname(require.resolve("typescript/package.json"));
    fs.mkdirSync(path.join(tree, "node_modules/.bin"), { recursive: true });
    fs.symlinkSync(ts, path.join(tree, "node_modules/typescript"));
    fs.symlinkSync("../typescript/bin/tsc", path.join(tree, "node_modules/.bin/tsc"));
    const config = path.join(tree, "tsconfig.json");
    fs.writeFileSync(config, JSON.stringify({ compilerOptions: { noEmit: true }, include: ["*.ts"], exclude: ["*.test.ts"] }));
    fs.writeFileSync(path.join(tree, "a.ts"), "export {};\n");
    const dir = watchDir(tree, "app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: [path.relative(dir, path.join(tree, "a.ts"))], fileInfos: [], root: [1] }));
    const passStartedAt = Date.now() + 60_000;
    expect(unlistedChanges(dir, tree, "tsconfig.json", passStartedAt)).toEqual([]);
    // A test file the config excludes is not the program's.
    fs.writeFileSync(path.join(tree, "a.test.ts"), "export {};\n");
    expect(unlistedChanges(dir, tree, "tsconfig.json", passStartedAt)).toEqual([]);
    fs.writeFileSync(path.join(tree, "b.ts"), "export {};\n");
    expect(unlistedChanges(dir, tree, "tsconfig.json", passStartedAt)).toEqual([path.join(tree, "b.ts")]);
    fs.rmSync(path.join(tree, "b.ts"));
    expect(unlistedChanges(dir, tree, "tsconfig.json", Date.now() - 60_000)).toEqual([config]);
  });
});

describe("a corrected tsconfig path", () => {
  test("a watcher built on another tsconfig is replaced, not trusted", async () => {
    const dir = watchDir("/tree", "cli");
    const old = Bun.spawn(["bash", "-c", "exec -a 'codecast check-watch /tree cli x' sleep 30"]);
    await new Promise((r) => setTimeout(r, 200));
    writeWatchState(dir, { pid: old.pid, project: "cli", tsconfig: "packages/cli/tsconfig.json", root: "/tree", startedAt: 1, inProgress: false, finishedAt: Date.now(), errors: 149 });
    fs.writeFileSync(outputPath(dir), "old.ts(1,1): error TS6059\n");
    const notes: string[] = [];
    const killed: number[] = [];
    let starts = 0;
    const r = await checkProject({ name: "cli", tsconfig: "packages/cli/tsconfig.typecheck.json" }, "/tree", {
      note: (l) => notes.push(l),
      kill: (pid) => { killed.push(pid); process.kill(pid, "SIGKILL"); },
      start: () => {
        starts++;
        writeWatchState(dir, { pid: process.pid, project: "cli", tsconfig: "packages/cli/tsconfig.typecheck.json", root: "/tree", startedAt: Date.now(), inProgress: false, finishedAt: Date.now(), errors: 1 });
        fs.writeFileSync(outputPath(dir), "real.ts(1,1): error TS2353\n");
      },
    });
    expect(starts).toBe(1);
    expect(killed).toEqual([old.pid]);
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

  test("a path to a configured project's tsconfig is that project, not a second watcher", () => {
    fs.mkdirSync(path.join(tree, ".codecast"));
    fs.writeFileSync(path.join(tree, ".codecast/check.toml"), '[projects]\na = "packages/a/tsconfig.json"\n');
    expect(resolveProjects(tree, ["packages/a"], tree)).toEqual([{ name: "a", tsconfig: "packages/a/tsconfig.json" }]);
    expect(resolveProjects(tree, ["tsconfig.json"], path.join(tree, "packages/a"))).toEqual([{ name: "a", tsconfig: "packages/a/tsconfig.json" }]);
    expect(resolveProjects(tree, ["packages/b"], tree)).toEqual([{ name: "packages-b", tsconfig: "packages/b/tsconfig.json" }]);
  });

  test("a tree-root-relative path works from a subdirectory", () => {
    fs.mkdirSync(path.join(tree, ".codecast"));
    fs.writeFileSync(path.join(tree, ".codecast/check.toml"), '[projects]\na = "packages/a/tsconfig.json"\n');
    expect(resolveProjects(tree, ["packages/a"], path.join(tree, "packages/a"))).toEqual([{ name: "a", tsconfig: "packages/a/tsconfig.json" }]);
    expect(resolveProjects(tree, ["packages/b"], path.join(tree, "packages/a"))).toEqual([{ name: "packages-b", tsconfig: "packages/b/tsconfig.json" }]);
  });

  test("a directory is the configured project that lives in it, whatever its tsconfig is called", () => {
    fs.mkdirSync(path.join(tree, ".codecast"));
    fs.writeFileSync(path.join(tree, "packages/b/tsconfig.typecheck.json"), "{}");
    fs.writeFileSync(path.join(tree, ".codecast/check.toml"), '[projects]\ncli = "packages/b/tsconfig.typecheck.json"\n');
    expect(resolveProjects(tree, ["packages/b"], path.join(tree, "packages/b"))).toEqual([{ name: "cli", tsconfig: "packages/b/tsconfig.typecheck.json" }]);
    expect(resolveProjects(tree, ["."], path.join(tree, "packages/b"))).toEqual([{ name: "cli", tsconfig: "packages/b/tsconfig.typecheck.json" }]);
    // The folder's own tsconfig.json, named as a file, is still that program.
    expect(resolveProjects(tree, ["packages/b/tsconfig.json"], tree)).toEqual([{ name: "packages-b", tsconfig: "packages/b/tsconfig.json" }]);
  });

  test("a sibling directory whose name starts with the tree's is outside it", () => {
    const sibling = `${tree}-wt`;
    fs.mkdirSync(path.join(sibling, "app"), { recursive: true });
    fs.writeFileSync(path.join(sibling, "app/tsconfig.json"), "{}");
    try {
      expect(() => resolveProjects(tree, [path.join(sibling, "app")], tree)).toThrow(/outside this tree/);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
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

describe("a watcher stopped for --fresh", () => {
  test("a lock another live ask holds times out in the words lockFor reads as contention", async () => {
    const file = path.join(watchDir("/tree", "web"), "start.lock");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const release = await acquireFileLock(file, { describe: "cast check web" });
    try {
      await expect(acquireFileLock(file, { describe: "cast check web", waitMs: 300 })).rejects.toThrow(/\bhas held\b|\bwas still taking\b/);
    } finally {
      release();
    }
  });

  test("an old watcher that will not stop is left running and named, never doubled", async () => {
    const dir = watchDir("/tree", "web");
    const stuck = Bun.spawn(["bash", "-c", "exec -a 'codecast check-watch /tree web x' sleep 30"]);
    await new Promise((r) => setTimeout(r, 200));
    try {
      writeWatchState(dir, { pid: stuck.pid, project: "web", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: false, finishedAt: 1, errors: 0 });
      const err = await stopWatcher(dir, stuck.pid, () => {}, 300).catch((e) => e);
      expect(err).toBeInstanceOf(CheckFailure);
      expect(err.kind).toBe("stuck");
      expect(err.detail.pid).toBe(stuck.pid);
      expect(err.detail.pgid).toBeGreaterThan(0);
      expect(summarize([{ project: "web", failure: err }]).hint).toBe(`stop the old watcher (\`kill -9 -- -${err.detail.pgid}\`), then run \`cast check --fresh web\``);
      expect(readWatchState(dir)?.pid).toBe(stuck.pid);
    } finally {
      stuck.kill(9);
    }
  });

  test("an ask never waits on a pid another program now holds: it starts a watcher of its own", async () => {
    const dir = watchDir("/tree", "web");
    const other = Bun.spawn(["sleep", "30"]);
    try {
      writeWatchState(dir, { pid: other.pid, project: "web", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true, errors: 0 });
      let starts = 0;
      const start = () => { starts++; writeWatchState(dir, { pid: process.pid, project: "web", tsconfig: "x", root: "/tree", startedAt: Date.now(), inProgress: false, finishedAt: Date.now(), errors: 0 }); };
      const r = await checkProject({ name: "web", tsconfig: "x" }, "/tree", { start, maxWatchers: 4, budgetMs: 5_000 });
      expect(r).toMatchObject({ started: true, errors: 0 });
      expect(starts).toBe(1);
    } finally {
      other.kill(9);
    }
  });

  test("a dead watcher's pid now held by another program is never signalled, counted, called stuck, nor named to kill", async () => {
    const dir = watchDir("/tree", "web");
    const other = Bun.spawn(["sleep", "30"]);
    try {
      writeWatchState(dir, { pid: other.pid, project: "web", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true, errors: 0 });
      expect(listWatchers()).toEqual([]);
      expect(readWatchState(dir)).toBeNull();
      writeWatchState(dir, { pid: other.pid, project: "web", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: false, finishedAt: 1, errors: 0 });
      const killed: number[] = [];
      await stopWatcher(dir, other.pid, (pid) => killed.push(pid), 300);
      expect(killed).toEqual([]);
      expect(readWatchState(dir)).toBeNull();
    } finally {
      other.kill(9);
    }
  });

  test("a start that never comes up reads only what was logged since the attempt", () => {
    const dir = watchDir("/tree", "web");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(logPath(dir), "tsc ran out of memory on web at its 8 GB heap cap (x). Asking again\n");
    const from = fs.statSync(logPath(dir)).size;
    expect(lastLogLine(dir, from)).toBeNull();
    fs.appendFileSync(logPath(dir), "tsc did not start: spawn EACCES\n");
    expect(lastLogLine(dir, from)).toBe("tsc did not start: spawn EACCES");
  });

  test("cleaning up late never removes its successor's state", () => {
    const dir = watchDir("/tree", "web");
    writeWatchState(dir, { pid: 4242, project: "web", tsconfig: "x", root: "/tree", startedAt: 2, inProgress: true });
    removeOwnState(dir, 999999999);
    expect(readWatchState(dir)?.pid).toBe(4242);
    removeOwnState(dir, 4242);
    expect(readWatchState(dir)).toBeNull();
  });

  test("the ask waits for the old watcher to exit before the new one starts", async () => {
    const dir = watchDir("/tree", "web");
    const child = Bun.spawn(["bash", "-c", "exec -a 'codecast check-watch /tree web x' sleep 30"]);
    await new Promise((r) => setTimeout(r, 200));
    writeWatchState(dir, { pid: child.pid, project: "web", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: false, finishedAt: 1, errors: 0 });
    const t = Date.now();
    await stopWatcher(dir, child.pid, (pid) => setTimeout(() => process.kill(pid, "SIGKILL"), 400));
    expect(Date.now() - t).toBeGreaterThanOrEqual(350);
    expect(readWatchState(dir)).toBeNull();
  });
});

describe("watcher exit", () => {
  const t = 10_000_000;
  const base = { startedAt: t - 2 * IDLE_EXIT_MS, inProgress: false };

  test("a watcher exits only when idle past the window", () => {
    expect(watcherExit({ ...base, askedAt: t - IDLE_EXIT_MS - 1 }, true, t)).toBe("idle");
    expect(watcherExit({ ...base, askedAt: t - IDLE_EXIT_MS + 1 }, true, t)).toBeNull();
    // The first pass finishing is as good as an ask: someone waited for it.
    expect(watcherExit({ ...base, askedAt: t - 2 * IDLE_EXIT_MS, firstFinishedAt: t - 1000 }, true, t)).toBeNull();
    // Passes that edits trigger afterwards do not keep an unasked watcher alive.
    expect(watcherExit({ ...base, askedAt: t - 2 * IDLE_EXIT_MS, firstFinishedAt: t - 2 * IDLE_EXIT_MS, finishedAt: t - 1000 } as any, true, t)).toBe("idle");
  });

  test("a pass in flight is given up only when nobody asked in the window and it has run past the stuck bound", () => {
    // Someone is waiting (their heartbeat refreshes askedAt): a first pass on a loaded machine keeps going, however long.
    expect(watcherExit({ ...base, inProgress: true, askedAt: t - 60_000, passStartedAt: t - 3 * IDLE_EXIT_MS }, true, t)).toBeNull();
    // Nobody asked for an hour, and the pass has run 40 minutes: stuck.
    expect(watcherExit({ ...base, inProgress: true, askedAt: t - 60 * 60_000, passStartedAt: t - 40 * 60_000 }, true, t)).toBe("stuck");
    // Nobody asked for an hour, but the pass started 5 minutes ago (an edit triggered it): let it finish, then idle-exit.
    expect(watcherExit({ ...base, inProgress: true, askedAt: t - 60 * 60_000, passStartedAt: t - 5 * 60_000 }, true, t)).toBeNull();
    // A first pass has no passStartedAt of its own until tsc says so: the watcher's start stands in.
    expect(watcherExit({ ...base, inProgress: true, askedAt: t - 60 * 60_000 }, true, t)).toBe("stuck");
    expect(watcherExit({ ...base, inProgress: true, askedAt: t - 2 * IDLE_EXIT_MS, passStartedAt: t - STUCK_PASS_MS + 1 }, true, t)).toBeNull();
    expect(watcherExit({ ...base, inProgress: true, askedAt: t - 2 * IDLE_EXIT_MS, passStartedAt: t - STUCK_PASS_MS - 1 }, true, t)).toBe("stuck");
  });

  test("a watcher whose tree or tsconfig is gone exits at once, whatever it was doing", () => {
    expect(watcherExit({ ...base, inProgress: true, askedAt: t }, false, t)).toBe("gone");
    expect(watcherExit({ ...base, askedAt: t }, false, t)).toBe("gone");
  });
});


describe("projectsTouching", () => {
  let iso: IsolatedCodecastDir;
  beforeEach(() => { iso = isolateCodecastDir(); });
  afterEach(() => iso.restore());

  test("picks the projects whose program holds a changed file, and a project above a file no program has seen", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-")));
    try {
      const projects = [
        { name: "web", tsconfig: "packages/web/tsconfig.json" },
        { name: "cli", tsconfig: "packages/cli/tsconfig.json" },
        { name: "convex", tsconfig: "packages/convex/tsconfig.json" },
      ];
      const info = (name: string, files: string[]) => {
        const dir = watchDir(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(root, f))) }));
      };
      info("web", ["packages/web/app.tsx", "packages/shared/x.ts"]);
      info("cli", ["packages/cli/src/a.ts"]);
      info("convex", ["packages/convex/f.ts", "packages/shared/x.ts"]);
      const names = (changed: string[]) => projectsTouching(root, projects, changed).map((p) => p.name);
      expect(names(["packages/shared/x.ts"])).toEqual(["web", "convex"]);
      expect(names(["packages/cli/src/new.ts"])).toEqual(["cli"]);
      expect(names(["README.md", "docs/a.md"])).toEqual([]);
      expect(names(["packages/web/tsconfig.json"])).toEqual(["web"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("in a checkout no program has built yet, reads each program's files from another checkout of the repository", () => {
    // A line run verifies in a worktree made for it: asked by folder alone, a
    // backend file mobile imports would not count for mobile.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-wt-")));
    try {
      const main = path.join(tmp, "main");
      const run = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" });
      fs.mkdirSync(main);
      run(main, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(main, "a.txt"), "a\n");
      run(main, "add", "a.txt");
      run(main, "commit", "-qm", "base");
      const wt = path.join(tmp, "line-ct-1");
      run(main, "worktree", "add", "-q", "-b", "line", wt);
      const projects = [
        { name: "backend", tsconfig: "outreach/backend/tsconfig.json" },
        { name: "mobile", tsconfig: "outreach/mobile/tsconfig.json" },
      ];
      const info = (name: string, files: string[]) => {
        const dir = watchDir(main, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(main, f))) }));
      };
      info("backend", ["outreach/backend/src/needs.ts"]);
      info("mobile", ["outreach/mobile/app.tsx", "outreach/backend/src/needs.ts"]);
      expect(projectsTouching(wt, projects, ["outreach/backend/src/needs.ts"]).map((p) => p.name)).toEqual(["backend", "mobile"]);
      expect(projectsTouching(wt, projects, ["outreach/backend/src/other.ts"]).map((p) => p.name)).toEqual(["backend"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// union-mobile (Nov 8): `cast check landing` said only "watcher went away: 74: 0x181ad5d54 start [/usr/lib/dyld]".
describe("a tsc that runs out of heap", () => {
  test("an inherited NODE_OPTIONS can raise the heap cap but never lower it", () => {
    expect(tscNodeOptions(undefined)).toBe(`--max-old-space-size=${TSC_HEAP_MB}`);
    expect(tscNodeOptions("--max-old-space-size=7168")).toBe(`--max-old-space-size=${TSC_HEAP_MB}`);
    expect(tscNodeOptions("--enable-source-maps --max-old-space-size=16384")).toBe("--enable-source-maps --max-old-space-size=16384");
    expect(heapCapMb(tscNodeOptions("--max_old_space_size=4096", "12288"))).toBe(12288);
  });

  test("the watcher names the full heap, not a stack frame", () => {
    const fatal = "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory";
    const line = heapDeath({ project: "landing", signal: "SIGABRT", fatal, nodeOptions: tscNodeOptions(undefined), totalBytes: 64 * 2 ** 30 });
    expect(line).toStartWith("tsc ran out of memory on landing at its 8 GB heap cap");
    expect(line).toContain("NODE_OPTIONS=--max-old-space-size=12288 cast check --fresh landing");
    expect(heapDeath({ project: "landing", signal: "SIGABRT", fatal: null, nodeOptions: "" })).toBeUndefined();
    expect(heapDeath({ project: "landing", signal: "SIGTERM", fatal, nodeOptions: "" })).toBeUndefined();
    expect(isNativeFrame("74: 0x181ad5d54 start [/usr/lib/dyld]")).toBe(true);
    expect(isNativeFrame("src/a.ts(1,2): error TS2322: no")).toBe(false);
  });

  test("an older watcher's log ending in stack frames still yields its exit line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-log-"));
    try {
      fs.writeFileSync(logPath(dir), "seeded the first pass from /x\ntsc exited (SIGABRT); its last lines:\n55: 0x1039d4ef0 Builtins_InterpreterEntryTrampoline [/x/libnode.dylib]\n74: 0x181ad5d54 start [/usr/lib/dyld]\n");
      expect(lastLogLine(dir)).toBe("tsc exited (SIGABRT)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checker = \"bun\"", () => {
  const { bunBinary, bunCheckUnavailable, checkWithBun, parseBunCheck, readBunResult, runBunCheck, treeSignature, versionAtLeast, bunResultPath } = require("./checkBun.js") as typeof import("./checkBun.js");
  const putResult = (dir: string, result: { runId: string } & Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(bunResultPath(dir, result.runId)), { recursive: true });
    fs.writeFileSync(bunResultPath(dir, result.runId), JSON.stringify(result));
  };
  const { readChecker } = require("./check.js") as typeof import("./check.js");
  let tree: string;
  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "cast-check-bun-"));
  });
  afterEach(() => fs.rmSync(tree, { recursive: true, force: true }));

  const writeConfig = (text: string) => {
    fs.mkdirSync(path.join(tree, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(tree, ".codecast/check.toml"), text);
  };

  test("the checker is a top-level key; absent, or no file, is the tsc watcher", () => {
    expect(readChecker(tree)).toBe("tsc");
    writeConfig('[projects]\na = "a/tsconfig.json"\n');
    expect(readChecker(tree)).toBe("tsc");
    writeConfig('checker = "bun"\n[projects]\na = "a/tsconfig.json"\n');
    expect(readChecker(tree)).toBe("bun");
    expect(readCheckConfig(tree)).toEqual([{ name: "a", tsconfig: "a/tsconfig.json" }]);
    writeConfig('checker = "tsgo"\n[projects]\na = "a/tsconfig.json"\n');
    expect(() => readChecker(tree)).toThrow(/checker must be "tsc" or "bun", not "tsgo"/);
  });

  test("bun's output reads as tsc's: diagnostics counted, its summary line dropped", () => {
    const out = "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nb.ts(2,7): error TS2345: Argument of type 'X' is not assignable.\n  Property 'y' is missing.\nFound 2 errors in 2 files, checked 83 files [142.96ms]\n";
    expect(parseBunCheck(out, 1)).toEqual({ errors: 2, diagnostics: "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nb.ts(2,7): error TS2345: Argument of type 'X' is not assignable.\n  Property 'y' is missing.\n" });
    expect(parseBunCheck("✓ No type errors in 83 files [140.47ms]\n", 0)).toEqual({ errors: 0, diagnostics: "" });
    // Counts over a thousand carry a comma.
    expect(parseBunCheck("src/a.ts(1,14): error TS2322: no\nFound 1,204 errors in 1 file, checked 3,475 files [10.52s]\n", 1)).toEqual({ errors: 1204, diagnostics: "src/a.ts(1,14): error TS2322: no\n" });
    // A tsconfig problem is a diagnostic, as from tsc.
    expect(parseBunCheck("error TS5058: The specified path does not exist: '/x/nope.json'.\nFound 1 error, checked 0 files [0.00ms]\n", 1)?.errors).toBe(1);
  });

  test("exit 1 with nothing parsed is bun failing, not type errors", () => {
    expect(parseBunCheck('error: Unknown flag "--bogus"\nnote: run \'bun check --help\' for more information\n', 1)).toBeNull();
    expect(parseBunCheck("", 1)).toBeNull();
    expect(parseBunCheck("a.ts(1,7): error TS2322: x\n", 134)).toBeNull();
  });

  test("a missing or old bun is 70, with a hint naming the upgrade", () => {
    expect(versionAtLeast("1.4.4", "1.4.4")).toBe(true);
    expect(versionAtLeast("1.4.10", "1.4.4")).toBe(true);
    expect(versionAtLeast("1.3.14", "1.4.4")).toBe(false);
    expect(versionAtLeast("garbage", "1.4.4")).toBe(false);
    expect(bunCheckUnavailable("/bin/bun", () => "1.4.4")).toBeNull();
    const old = bunCheckUnavailable("/bin/bun", () => "1.3.14")!;
    expect(old.kind).toBe("no-bun");
    expect(old.message).toContain("1.3.14");
    const missing = bunCheckUnavailable(null)!;
    expect(missing.kind).toBe("no-bun");
    const broken = bunCheckUnavailable("/bin/bun", () => null)!;
    expect(broken.kind).toBe("no-bun");
    const { exit, hint } = summarize([{ project: "web", failure: old }]);
    expect(exit).toBe(70);
    expect(hint).toContain("bun upgrade");
    expect(hint).toContain("CAST_CHECK_BUN");
  });

  const fakeBun = (script: string): string => {
    const bin = path.join(tree, "fake-bun");
    fs.writeFileSync(bin, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
    return bin;
  };

  test("a run checks once with the agreed flags, outside CLAUDECODE and AGENT, and leaves its result", async () => {
    fs.writeFileSync(path.join(tree, "tsconfig.json"), "{}");
    const argsFile = path.join(tree, "args");
    const bin = fakeBun(`echo "$@ CLAUDECODE=$CLAUDECODE AGENT=$AGENT" > ${argsFile}\necho "a.ts(1,1): error TS2322: no"\necho "Found 1 error in 1 file, checked 3 files [1ms]"\nexit 1`);
    const saved = { c: process.env.CLAUDECODE, a: process.env.AGENT };
    process.env.CLAUDECODE = "1";
    process.env.AGENT = "1";
    try {
      await runBunCheck(tree, "web", "tsconfig.json", bin, "run-1");
    } finally {
      if (saved.c === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved.c;
      if (saved.a === undefined) delete process.env.AGENT; else process.env.AGENT = saved.a;
    }
    expect(fs.readFileSync(argsFile, "utf-8").trim()).toBe(`check -p ${path.join(tree, "tsconfig.json")} --no-pretty --all --no-script --threads 4 CLAUDECODE= AGENT=`);
    const dir = watchDir(tree, "web");
    expect(readBunResult(dir, "run-1")).toMatchObject({ runId: "run-1", errors: 1, diagnostics: "a.ts(1,1): error TS2322: no\n" });
    // A run is no watcher: nothing is left running or listed.
    expect(readWatchState(dir)).toBeNull();
  });

  test("a run that fails without a diagnostic leaves a failure, and the ask exits 70", async () => {
    fs.writeFileSync(path.join(tree, "tsconfig.json"), "{}");
    const bin = fakeBun(`echo 'error: Unknown flag "--threads"'\nexit 1`);
    await runBunCheck(tree, "web", "tsconfig.json", bin, "run-2");
    const result = readBunResult(watchDir(tree, "web"), "run-2")!;
    expect(result.failure).toContain('Unknown flag "--threads"');
    // The ask reads it as the run's death.
    const dir = watchDir(tree, "api");
    const start = (_r: string, _t: unknown, _b: string, id: string) => {
      fs.mkdirSync(dir, { recursive: true });
      putResult(dir, { ...result, runId: id });
    };
    const err = await checkWithBun({ name: "api", tsconfig: "tsconfig.json" }, tree, { bin: "/bin/bun", start, signature: () => null }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckFailure);
    expect(err.kind).toBe("died");
    expect(summarize([{ project: "api", failure: err }]).exit).toBe(70);
  });

  test("an ask starts a run and answers from its result", async () => {
    const dir = watchDir(tree, "web");
    let starts = 0;
    const start = (_r: string, _t: unknown, _b: string, id: string) => {
      starts++;
      writeWatchState(dir, { pid: process.pid, project: "web", tsconfig: "x", root: tree, startedAt: Date.now(), inProgress: true, checker: "bun", runId: id, tree: "sig" });
      setTimeout(() => {
        putResult(dir, { runId: id, startedAt: Date.now() - 4000, finishedAt: Date.now(), errors: 2, diagnostics: "a.ts(1,1): error TS1: x\nb.ts(1,1): error TS1: y\n" });
        removeOwnState(dir, process.pid);
      }, 300);
    };
    const r = await checkWithBun({ name: "web", tsconfig: "x" }, tree, { bin: "/bin/bun", start, signature: () => "sig" });
    expect(starts).toBe(1);
    expect(r).toMatchObject({ project: "web", errors: 2, started: true, checker: "bun", phantom: 0 });
    expect(r.runMs).toBeGreaterThanOrEqual(3900);
  });

  test("an ask on the same tree shares the run in flight; one on a changed tree waits for it, then runs its own", async () => {
    const dir = watchDir(tree, "web");
    writeWatchState(dir, { pid: process.pid, project: "web", tsconfig: "x", root: tree, startedAt: Date.now(), inProgress: true, checker: "bun", runId: "theirs", tree: "sig-a" });
    const finishTheirs = () => {
      putResult(dir, { runId: "theirs", startedAt: Date.now() - 1000, finishedAt: Date.now(), errors: 0, diagnostics: "" });
      removeOwnState(dir, process.pid);
    };
    let starts = 0;
    const start = (_r: string, _t: unknown, _b: string, id: string) => {
      starts++;
      putResult(dir, { runId: id, startedAt: Date.now(), finishedAt: Date.now(), errors: 1, diagnostics: "a.ts(1,1): error TS1: x\n" });
    };
    setTimeout(finishTheirs, 300);
    const shared = await checkWithBun({ name: "web", tsconfig: "x" }, tree, { bin: "/bin/bun", start, signature: () => "sig-a" });
    expect(starts).toBe(0);
    expect(shared).toMatchObject({ errors: 0, started: false });

    writeWatchState(dir, { pid: process.pid, project: "web", tsconfig: "x", root: tree, startedAt: Date.now(), inProgress: true, checker: "bun", runId: "theirs", tree: "sig-a" });
    setTimeout(finishTheirs, 300);
    const own = await checkWithBun({ name: "web", tsconfig: "x" }, tree, { bin: "/bin/bun", start, signature: () => "sig-b" });
    expect(starts).toBe(1);
    expect(own).toMatchObject({ errors: 1, started: true });
  });

  test("a run that stops without a result is a death, not an answer", async () => {
    const dir = watchDir(tree, "web");
    const start = (_r: string, _t: unknown, _b: string, id: string) => {
      writeWatchState(dir, { pid: process.pid, project: "web", tsconfig: "x", root: tree, startedAt: Date.now(), inProgress: true, checker: "bun", runId: id });
      setTimeout(() => removeOwnState(dir, process.pid), 200);
    };
    const err = await checkWithBun({ name: "web", tsconfig: "x" }, tree, { bin: "/bin/bun", start, signature: () => null }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckFailure);
    expect(summarize([{ project: "web", failure: err }]).exit).toBe(70);
  }, 15_000);

  test("runs are bounded by their own slots and by memory free now, and the first always starts", () => {
    const { bunRunFits, bunRunCap } = require("./checkCapacity.js") as typeof import("./checkCapacity.js");
    const GB = 2 ** 30;
    const total = 64 * GB;
    const free = (gb: number) => ({ availableBytes: gb * GB, swapUsedBytes: 0, swapTotalBytes: 8 * GB }) as never;
    expect(bunRunCap(16, {})).toBe(4);
    expect(bunRunCap(2, {})).toBe(1);
    expect(bunRunCap(64, {})).toBe(4);
    expect(bunRunCap(16, { CAST_CHECK_BUN_RUNS: "2" })).toBe(2);
    // The first run starts with no memory to spare; a second needs its size free; the cap is a hard stop.
    expect(bunRunFits(0, 4, 3 * GB, free(0), total)).toBe(true);
    expect(bunRunFits(1, 4, 3 * GB, free(1), total)).toBe(false);
    expect(bunRunFits(1, 4, 3 * GB, free(40), total)).toBe(true);
    expect(bunRunFits(4, 4, 0, free(40), total)).toBe(false);
  });

  test("a later run's result never takes the place of the one an ask waits for", async () => {
    const dir = watchDir(tree, "web");
    const start = (_r: string, _t: unknown, _b: string, id: string) => {
      // Its own result, then another run's, before the ask reads either.
      putResult(dir, { runId: id, startedAt: Date.now(), finishedAt: Date.now(), errors: 0, diagnostics: "" });
      putResult(dir, { runId: "later", startedAt: Date.now(), finishedAt: Date.now(), errors: 3, diagnostics: "x" });
    };
    const r = await checkWithBun({ name: "web", tsconfig: "x" }, tree, { bin: "/bin/bun", start, signature: () => null });
    expect(r.errors).toBe(0);
  });

  test("checker written inside [projects] is named, not read as a project", () => {
    writeConfig('[projects]\nchecker = "bun"\na = "a/tsconfig.json"\n');
    expect(() => readCheckConfig(tree)).toThrow(/top-level key; move it above \[projects\]/);
  });

  test("CAST_CHECK_BUN resolves to an absolute path before a run starts elsewhere", () => {
    expect(bunBinary({ CAST_CHECK_BUN: "tools/bun", PATH: "" }, "/work")).toBe("/work/tools/bun");
    expect(bunBinary({ CAST_CHECK_BUN: "/opt/bun", PATH: "" }, "/work")).toBe("/opt/bun");
    expect(bunBinary({ PATH: "" }, "/work")).toBeNull();
  });

  test("the tree signature sees ignored entries and never takes the index lock", () => {
    const git = (...args: string[]) => spawnSync("git", ["-C", tree, "-c", "user.email=x@x", "-c", "user.name=x", ...args], { encoding: "utf-8" });
    git("init", "-q");
    fs.writeFileSync(path.join(tree, ".gitignore"), "gen.ts\n");
    fs.writeFileSync(path.join(tree, "a.ts"), "export {};\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    fs.writeFileSync(path.join(tree, "gen.ts"), "export const g = 1;\n");
    const before = treeSignature(tree);
    // A tracked file touched without a content change: plain git status would refresh (rewrite) the index here.
    const index = path.join(tree, ".git/index");
    const indexAt = fs.statSync(index).mtimeMs;
    fs.utimesSync(path.join(tree, "a.ts"), new Date(), new Date(Date.now() + 5_000));
    treeSignature(tree);
    expect(fs.statSync(index).mtimeMs).toBe(indexAt);
    fs.writeFileSync(path.join(tree, "gen.ts"), "export const g: number = 'x';\n");
    expect(treeSignature(tree)).not.toBe(before);
  });

  test("a tsc ask replaces a bun run left in the project's dir, and a bun ask replaces a tsc watcher", async () => {
    const dir = watchDir(tree, "web");
    writeWatchState(dir, { pid: 999999999, project: "web", tsconfig: "x", root: tree, startedAt: 1, inProgress: true, checker: "bun", runId: "old" });
    let starts = 0;
    const start = (_r: string, _t: unknown, _b: string, id: string) => {
      starts++;
      putResult(dir, { runId: id, startedAt: Date.now(), finishedAt: Date.now(), errors: 0, diagnostics: "" });
    };
    // A dead run's state is not a run to share.
    const r = await checkWithBun({ name: "web", tsconfig: "x" }, tree, { bin: "/bin/bun", start, signature: () => null });
    expect(starts).toBe(1);
    expect(r.errors).toBe(0);
  });
});
