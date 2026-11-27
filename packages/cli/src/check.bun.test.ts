/**
 * `cast check` with checker = "bun": the config key, bun's output read as
 * tsc's, the exit contract, and asks sharing a run (checkBun.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";
import { CheckFailure, summarize } from "./checkOutcome.js";
import { bunRunCap, bunRunFits, readCheckConfig, readChecker, readWatchState, removeOwnState, watchDir, watcherIdentity, writeWatchState } from "./check.js";
import { bunBinary, bunCheckUnavailable, bunResultPath, checkWithBun, parseBunCheck, readBunResult, runBunCheck, treeSignature, versionAtLeast } from "./checkBun.js";

let isolation: IsolatedCodecastDir;
const realIdentity = watcherIdentity.matches;
beforeEach(() => {
  isolation = isolateCodecastDir("cast-check-bun-test-");
  // These tests stand in for a run with their own pid.
  watcherIdentity.matches = (command, pid) => pid === process.pid || realIdentity(command, pid);
});
afterEach(() => {
  isolation.restore();
  watcherIdentity.matches = realIdentity;
});

describe("checker = \"bun\"", () => {
  const putResult = (dir: string, result: { runId: string } & Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(bunResultPath(dir, result.runId)), { recursive: true });
    fs.writeFileSync(bunResultPath(dir, result.runId), JSON.stringify(result));
  };
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

  test("a run's state is visible before it reads the tree, however slow that is", async () => {
    fs.writeFileSync(path.join(tree, "tsconfig.json"), "{}");
    const bin = fakeBun(`echo "✓ No type errors in 1 files [1ms]"\nexit 0`);
    const dir = watchDir(tree, "web");
    let seenAtSignature: unknown = null;
    const signature = () => {
      seenAtSignature = readWatchState(dir)?.runId;
      return "sig";
    };
    await runBunCheck(tree, "web", "tsconfig.json", bin, "run-early", signature);
    expect(seenAtSignature).toBe("run-early");
    expect(readBunResult(dir, "run-early")).toMatchObject({ errors: 0 });
  });

  test("an ignored directory counts as one entry, and still changes the signature when its contents are replaced", () => {
    const git = (...args: string[]) => spawnSync("git", ["-C", tree, "-c", "user.email=x@x", "-c", "user.name=x", ...args], { encoding: "utf-8" });
    git("init", "-q");
    fs.writeFileSync(path.join(tree, ".gitignore"), "deps/\n");
    fs.writeFileSync(path.join(tree, "a.ts"), "export {};\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    fs.mkdirSync(path.join(tree, "deps/pkg"), { recursive: true });
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(tree, `deps/pkg/f${i}.d.ts`), "export {};\n");
    const listed = spawnSync("git", ["-C", tree, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], { encoding: "utf-8" }).stdout.trim().split("\n");
    expect(listed).toEqual(["deps/"]);
    const before = treeSignature(tree);
    expect(before).not.toBeNull();
    // An install adds or removes entries at the top of the ignored directory.
    fs.mkdirSync(path.join(tree, "deps/other"));
    fs.utimesSync(path.join(tree, "deps"), new Date(), new Date(Date.now() + 5_000));
    expect(treeSignature(tree)).not.toBe(before);
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
