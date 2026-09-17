/**
 * The shared typecheck: tsc's watch output folds into a state file one pass
 * at a time, and the client answers from the last finished pass, waits for a
 * pass in flight, and starts a watcher when none runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";
import { checkProject, classifyWatchLine, outputPath, readWatchState, watchDir, watchReducer, writeWatchState, type WatchState } from "./check.js";

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
    const r = await checkProject("web", "/tree", { start: () => { starts++; } });
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
    const r = await checkProject("cli", "/tree", { start: () => {} });
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
    const r = await checkProject("convex", "/tree", { start });
    expect(r.started).toBe(true);
    expect(starts).toBe(1);
    // A dead pid is a watcher to replace.
    writeWatchState(dir, { ...readWatchState(dir)!, pid: 999999999 });
    await checkProject("convex", "/tree", { start });
    expect(starts).toBe(2);
  });
});
