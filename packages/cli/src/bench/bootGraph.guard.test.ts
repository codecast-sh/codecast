// What every `cast` invocation pays before it does anything.
//
// ES imports are hoisted, so a single static `import` of a command group in
// index.ts is paid by `cast --help`, by `cast send`, and by a typo — none of
// which will ever run that group. commandGroups.ts exists to keep those groups
// behind a dynamic `import()`, and this guard is what keeps them there: it
// walks the static import graph from each entry and fails by name, with the
// chain that put the module back on the graph.
//
// It fails on the two ways the property is lost. Someone writes
// `import { registerBrowserCommand } from "./browser/cli.js"` in index.ts
// again — the direct way. Or a leaf module index.ts already loads grows an
// import of a group module, and the whole group arrives sideways; that is how
// the daemon ended up carrying `cast state` and `cast publish` before ct-49546.
//
// The ceilings are the same idea one level up. Each is a multiple of its step,
// and a step is weeks of the graph's ordinary growth, so a branch that
// adds a leaf or a few KB touches no line here and two such branches never
// conflict on one. Crossing a ceiling is the moment to look at what grew, and
// a ceiling a whole step above the graph must come down, so a cut stays taken.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_GROUPS } from "../commandGroups.js";
import { buildBootGraph, importChain, repoRootFrom, staticImportSpecifiers } from "./bootGraph.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = repoRootFrom(SRC);
const rel = (file: string) => path.relative(ROOT, file);

/** The two big walks read and parse ~200 and ~270 files. They sit just over
 *  bun's 5 s default on an idle box and well over it on a loaded agent box. */
const GRAPH_WALK_TIMEOUT = 60_000;

// From 2026-10-27 to 2026-11-26 the index.ts graph went from 4380 to 4892 KB
// and from 329 to 377 files, and the daemon's from 521 to 630 files. A file
// step is about that month; the KB step is about half of it, so a subsystem
// arriving sideways cannot hide in the headroom.
type Ceiling = { ceiling: number; step: number };
const INDEX_FILES: Ceiling = { ceiling: 400, step: 50 };
const INDEX_KB: Ceiling = { ceiling: 5000, step: 250 };
const DAEMON_FILES: Ceiling = { ceiling: 700, step: 100 };

function expectUnderCeiling(measured: number, what: string, { ceiling, step }: Ceiling) {
  expect(ceiling % step, `${what}: a ceiling moves in whole steps of ${step}`).toBe(0);
  const fits = Math.ceil(measured / step) * step;
  expect(
    measured,
    `${what} is ${measured}, over its ceiling of ${ceiling}. Find what grew, and move whatever only some commands need behind a dynamic import() first. Raise the ceiling to ${fits} only for real growth, with the reason in the commit.`,
  ).toBeLessThanOrEqual(ceiling);
  expect(
    measured,
    `${what} is ${measured}, a whole step under its ceiling of ${ceiling}: lower it to ${fits} so the ground stays taken.`,
  ).toBeGreaterThan(ceiling - step);
}

/** The group modules, as absolute paths. `./browser/cli.js` is `browser/cli.ts` on disk. */
const GROUP_MODULES = COMMAND_GROUPS.map((group) => {
  const spec = /import\("([^"]+)"\)/.exec(group.load.toString())?.[1];
  return { token: group.token, spec, file: path.join(SRC, (spec ?? "").replace(/^\.\//, "").replace(/\.js$/, ".ts")) };
});

function assertOffGraph(entry: string) {
  const graph = buildBootGraph(entry);
  const onGraph = GROUP_MODULES.filter((m) => graph.nodes.has(m.file)).map((m) => {
    const chain = importChain(graph, m.file)?.map(rel).join("\n    -> ") ?? "?";
    return `${m.token} (${rel(m.file)}) reached by:\n    ${chain}`;
  });
  expect(onGraph.join("\n\n"), `command groups on the static graph of ${rel(entry)}`).toBe("");
  return graph;
}

const LAZY_PROVIDER_MODULES = ["hosts/providers/ec2Start.ts", "hosts/providers/namespaceStart.ts", "hosts/providers/namespaceProvision.ts", "hosts/namespaceCli.ts"].map((file) => path.join(SRC, file));

function assertLazyProviderModulesOffGraph(graph: ReturnType<typeof buildBootGraph>, entry: string) {
  const onGraph = LAZY_PROVIDER_MODULES.filter((file) => graph.nodes.has(file)).map((file) => {
    const chain = importChain(graph, file)?.map(rel).join("\n    -> ") ?? "?";
    return `${rel(file)} reached by:\n    ${chain}`;
  });
  expect(onGraph.join("\n\n"), `lazily loaded host provider modules on the static graph of ${rel(entry)}`).toBe("");
}

describe("command groups stay off the boot graph", () => {
  test("every listed group resolves to a module that exists", () => {
    for (const m of GROUP_MODULES) {
      expect(m.spec, `${m.token} must reach its module through a dynamic import("...")`).toBeTruthy();
      expect(Bun.file(m.file).size, `${rel(m.file)} (for group "${m.token}")`).toBeGreaterThan(0);
    }
  });

  test("index.ts, the CLI's command tree, statically imports no command group", () => {
    const graph = assertOffGraph(path.join(SRC, "index.ts"));
    assertLazyProviderModulesOffGraph(graph, path.join(SRC, "index.ts"));
    // A group coming back, or a whole subsystem arriving sideways through a
    // leaf, is what these ceilings exist to catch; a genuinely new leaf is not.
    // The file count answers that question. The KB also grows with code written
    // into files already on the graph, which is code, not reach.
    expectUnderCeiling(graph.nodes.size, "source files on index.ts's static graph", INDEX_FILES);
    expectUnderCeiling(Math.round(graph.totalBytes / 1024), "KB of source on index.ts's static graph", INDEX_KB);
  }, GRAPH_WALK_TIMEOUT);

  test("main.ts, the process entry, reaches only the fast path", () => {
    const graph = buildBootGraph(path.join(SRC, "main.ts"));
    // Plus syncStdio.ts, installed before anything can write so a large write
    // into a pipe arrives whole (fe4d8f0da), and proc.ts, which main.ts's
    // dry-run hand-off spawns through like every caller (the child_process
    // ratchet), with its two leaves: slowSync.ts and workers/bridge.ts, whose
    // worker modules stay behind import type and a dynamic import (2026-10-15).
    expect([...graph.nodes.keys()].map(rel).sort()).toEqual([
      "packages/cli/src/fastPath.ts", "packages/cli/src/keychainLock.ts", "packages/cli/src/main.ts", "packages/cli/src/proc.ts",
      "packages/cli/src/slowSync.ts", "packages/cli/src/syncStdio.ts", "packages/cli/src/workers/bridge.ts",
    ]);
  });

  test("the daemon carries no CLI command group either", () => {
    const graph = assertOffGraph(path.join(SRC, "daemon.ts"));
    assertLazyProviderModulesOffGraph(graph, path.join(SRC, "daemon.ts"));
    // The daemon is the process that RUNS the workers, so the `workers/*`
    // modules are work it actually does rather than a graph it carries by
    // accident; the command groups are not its work, which is what
    // assertOffGraph checks above. A dynamic import of something the daemon
    // runs at boot (the cloud agent registry, the claude.ai watcher) would
    // lower this number without lowering what the daemon loads.
    expectUnderCeiling(graph.nodes.size, "source files on daemon.ts's static graph", DAEMON_FILES);
  }, GRAPH_WALK_TIMEOUT);

  test("commandGroups.ts is a leaf: it imports no repo module at runtime", () => {
    const graph = buildBootGraph(path.join(SRC, "commandGroups.ts"));
    expect([...graph.nodes.keys()].map(rel)).toEqual(["packages/cli/src/commandGroups.ts"]);
  });
});

describe("the import walker the guard is built on", () => {
  test("reads static imports and ignores dynamic ones", () => {
    const source = [
      'import { a } from "./a.js";',
      'import type { T } from "./type-only.js";',
      'import { type U, type V } from "./also-type-only.js";',
      'export { b } from "./b.js";',
      'import "./side-effect.js";',
      'const late = await import("./lazy.js");',
      'const chained = import("./chained.js").then((m) => m.go);',
    ].join("\n");
    expect(staticImportSpecifiers(source)).toEqual(["./a.js", "./b.js", "./side-effect.js"]);
  });

  test("a `from` inside a later statement is not paired with an earlier import()", () => {
    const source = 'import("./lazy.js").then(go);\nconst note = "read from disk";\nimport { real } from "./real.js";';
    expect(staticImportSpecifiers(source)).toEqual(["./real.js"]);
  });
});
