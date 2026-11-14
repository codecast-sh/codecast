import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CheckFailure, deathKind, exportsName, phantomErrors, summarize } from "./checkOutcome.js";
import { EVICTED_LINE } from "./check.js";
import { heapDeath } from "./checkHeap.js";
import { memoryDeath } from "./repoNeed.js";
import { EXIT_BUSY, EXIT_INFRA, EXIT_WAIT_ELAPSED } from "./infraExit.js";

describe("why a watcher stopped, from the line it logged last", () => {
  test("the real memory and heap lines, a tsc that never started, anything else", () => {
    expect(deathKind(memoryDeath({ what: "the web typecheck (tsc)", killed: true, oomBefore: undefined, oomAfter: undefined }) ?? null)).toBe("oom");
    expect(deathKind(memoryDeath({ what: "the web typecheck (tsc)", killed: true, oomBefore: 1, oomAfter: 2 }) ?? null)).toBe("oom");
    expect(deathKind(heapDeath({ project: "web", signal: "SIGABRT", fatal: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", nodeOptions: "--max-old-space-size=8192" }) ?? null)).toBe("heap");
    expect(deathKind("tsc did not start: this tree has no TypeScript installed (its dependencies are missing) and none is on PATH. Install them")).toBe("no-tsc");
    expect(deathKind("tsc exited (code 1)")).toBe("died");
    expect(deathKind("tsc did not start: spawn EACCES")).toBe("died");
    expect(deathKind(`${EVICTED_LINE} (cap 16, 9.0 GB reserved of 12.0 GB, need 4.0 GB)`)).toBe("busy");
    expect(deathKind(null)).toBe("died");
  });
});

describe("phantom errors", () => {
  let tree: string;
  beforeEach(() => {
    tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phantom-")));
    fs.mkdirSync(path.join(tree, "src/lib"), { recursive: true });
    fs.writeFileSync(path.join(tree, "src/lib/x.ts"), "export const real = 1;\nexport function helper() {}\nconst inner = 2;\nexport { inner as renamed };\n");
    fs.writeFileSync(path.join(tree, "src/lib/index.ts"), "export type Shape = { a: 1 };\n");
  });
  afterEach(() => fs.rmSync(tree, { recursive: true, force: true }));

  test("count a missing export the disk has, never one it lacks", () => {
    const diagnostics = [
      `src/a.ts(1,10): error TS2305: Module '"./lib/x"' has no exported member 'helper'.`,
      `src/a.ts(2,10): error TS2724: '"./lib/x.js"' has no exported member named 'renamed'. Did you mean 'real'?`,
      `src/a.ts(3,10): error TS2305: Module '"./lib"' has no exported member 'Shape'.`,
      `src/a.ts(4,10): error TS2305: Module '"./lib/x"' has no exported member 'gone'.`,
      `src/a.ts(5,10): error TS2305: Module '"react"' has no exported member 'useThing'.`,
      `src/a.ts(6,20): error TS2307: Cannot find module './lib/x' or its corresponding type declarations.`,
      `src/a.ts(7,20): error TS2307: Cannot find module './lib/missing' or its corresponding type declarations.`,
      `src/a.ts(8,1): error TS2322: Type 'string' is not assignable to type 'number'.`,
    ].join("\n");
    const r = phantomErrors(diagnostics, tree);
    // A missing module (TS2307) is never counted: resolving it without the importer's module mode can be wrong.
    expect(r.phantom).toBe(3);
    expect(r.examples).toEqual([`helper in ${path.join("src/lib/x.ts")}`, `renamed in ${path.join("src/lib/x.ts")}`]);
  });

  test("an export is read from declarations and export lists, not from mentions", () => {
    expect(exportsName("export declare abstract class Foo {}", "Foo")).toBe(true);
    expect(exportsName("export { a, Foo as Bar }", "Bar")).toBe(true);
    expect(exportsName("export { Foo as Bar }", "Foo")).toBe(false);
    expect(exportsName("export type {\n  Foo,\n}", "Foo")).toBe(true);
    expect(exportsName("const Foo = 1; // export Foo", "Foo")).toBe(false);
    expect(exportsName("export const FooBar = 1", "Foo")).toBe(false);
    expect(exportsName("/* export const Foo = 1 */\n// export function Foo() {}\n", "Foo")).toBe(false);
    expect(exportsName('export { Foo } from "./other";', "Foo")).toBe(false);
    expect(exportsName('const u = "https://x"; export const Foo = 1;', "Foo")).toBe(true);
    expect(exportsName("export namespace N { export function Foo() {} }", "Foo")).toBe(false);
    expect(exportsName('declare module "m" { export const Foo: 1 }', "Foo")).toBe(false);
    expect(exportsName("const sample = `\nexport const Foo = 1;\n`;", "Foo")).toBe(false);
    expect(exportsName("export namespace N {}\nexport const Foo = 1;", "Foo")).toBe(true);
  });

  test("imports resolve the way the project's tsc resolves them when it can, aliases included", () => {
    const resolve = (spec: string) => (spec === "@/lib/x" ? path.join(tree, "src/lib/x.ts") : null);
    const r = phantomErrors(`src/a.ts(1,10): error TS2305: Module '"@/lib/x"' has no exported member 'helper'.`, tree, resolve);
    expect(r.phantom).toBe(1);
    expect(phantomErrors(`src/a.ts(1,10): error TS2305: Module '"@/lib/x"' has no exported member 'helper'.`, tree).phantom).toBe(0);
  });
});

describe("a run's exit code and hint", () => {
  const fail = (project: string, kind: ConstructorParameters<typeof CheckFailure>[1], detail = {}) => ({ project, failure: new CheckFailure("x", kind, detail) });

  test("clean is 0 with no hint; real type errors are 1 with none", () => {
    expect(summarize([{ project: "cli", errors: 0 }])).toEqual({ exit: 0, hint: null });
    expect(summarize([{ project: "cli", errors: 3 }])).toEqual({ exit: 1, hint: null });
  });

  test("type errors stay 1 when another project failed to check, and the hint names that failure", () => {
    const r = summarize([{ project: "cli", errors: 2 }, fail("web", "died", { log: "/l/watch.log" })]);
    expect(r.exit).toBe(1);
    expect(r.hint).toBe("run `cast check web` again to start a new watcher; if it dies again, read /l/watch.log");
  });

  test("the most severe failure picks the code and the hint", () => {
    expect(summarize([fail("a", "wait-elapsed"), fail("b", "oom")])).toEqual({ exit: EXIT_INFRA, hint: expect.stringContaining("free memory, then run `cast check b` again") });
    expect(summarize([fail("a", "busy"), fail("b", "wait-elapsed")])).toEqual({ exit: EXIT_WAIT_ELAPSED, hint: expect.stringContaining("`cast check b` again: the pass keeps running") });
    expect(summarize([fail("a", "busy"), fail("b", "busy")])).toEqual({ exit: EXIT_BUSY, hint: expect.stringContaining("`cast check a b` again; `cast queue` shows which watchers hold the room") });
    expect(summarize([fail("web", "heap", { command: "NODE_OPTIONS=--max-old-space-size=16384 cast check --fresh web" })]).hint).toBe("raise tsc's heap and restart the watcher: `NODE_OPTIONS=--max-old-space-size=16384 cast check --fresh web`");
    // One project's command or log never stands for several.
    expect(summarize([fail("web", "heap", { command: "NODE_OPTIONS=--max-old-space-size=16384 cast check --fresh web" }), fail("cli", "heap")]).hint).toBe("raise tsc's heap and restart the watchers: `NODE_OPTIONS=--max-old-space-size=16384 cast check --fresh web cli`");
    expect(summarize([fail("web", "died", { log: "/w.log" }), fail("cli", "died", { log: "/c.log" })]).hint).toBe("run `cast check web cli` again to start a new watcher");
    // Never a smaller heap than one of them already had, and never a stop for every watcher on the machine.
    expect(summarize([fail("web", "heap", { command: "NODE_OPTIONS=--max-old-space-size=20480 cast check --fresh web" }), fail("cli", "heap")]).hint).toBe("raise tsc's heap and restart the watchers: `NODE_OPTIONS=--max-old-space-size=20480 cast check --fresh web cli`");
    expect(summarize([fail("web", "stuck", { pid: 11 }), fail("cli", "stuck", { pid: 12 })]).hint).toBe("stop the old watchers (`kill -9 -- 11 12`), then run `cast check --fresh web cli`");
  });

  test("a watcher that will not stop, and a lock another ask holds, each name their own way out", () => {
    expect(summarize([fail("web", "stuck", { pid: 4242 })])).toEqual({ exit: EXIT_INFRA, hint: "stop the old watcher (`kill -9 -- 4242`), then run `cast check --fresh web`" });
    expect(summarize([fail("web", "stuck", { pid: 4242, pgid: 4242 })]).hint).toBe("stop the old watcher (`kill -9 -- -4242`), then run `cast check --fresh web`");
    expect(summarize([fail("web", "locked", { lock: "/s/web/start.lock" })])).toEqual({ exit: EXIT_BUSY, hint: "wait, then run `cast check web` again; if no other `cast check` is running, remove /s/web/start.lock" });
  });

  test("errors that all name what is on disk are no verdict: stale, with --fresh", () => {
    expect(summarize([{ project: "mobile", errors: 25, phantom: 25 }], ["helper in lib/x.ts"])).toEqual({
      exit: EXIT_BUSY,
      hint: "run `cast check --fresh mobile`: errors name what exists on disk (helper in lib/x.ts), left from a pass over a half-written tree",
    });
    expect(summarize([{ project: "mobile", errors: 26, phantom: 25 }]).exit).toBe(1);
  });

  test("a project checked by the tsc on PATH says how to get the tree's own", () => {
    expect(summarize([{ project: "app", errors: 40, globalTsc: true }])).toEqual({ exit: 1, hint: expect.stringContaining("install this tree's dependencies, then run `cast check --fresh app`") });
  });
});
