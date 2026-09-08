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
// The ceilings are the same idea one level up, and they sit AT the last
// measurement so the graph can only shrink. A change that lifts one should say
// why in its commit, and say what grew.

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

describe("command groups stay off the boot graph", () => {
  test("every listed group resolves to a module that exists", () => {
    for (const m of GROUP_MODULES) {
      expect(m.spec, `${m.token} must reach its module through a dynamic import("...")`).toBeTruthy();
      expect(Bun.file(m.file).size, `${rel(m.file)} (for group "${m.token}")`).toBeGreaterThan(0);
    }
  });

  test("index.ts, the CLI's command tree, statically imports no command group", () => {
    const graph = assertOffGraph(path.join(SRC, "index.ts"));
    // Budgets, set at the measurement so they ratchet. index.ts was 260 files
    // and 5.5 MB with the groups inlined. Lifted to 205 when ct-49546 landed on
    // a tree 35 commits newer than the one it was measured on, because the
    // eager graph had gained 14 `workers/*` modules; ct-49758 put those behind
    // dynamic imports and it came back to 190 against a measured 187/2,628 KB.
    //
    // Now 188 files and 2,663 KB, re-measured on the tree that finally wires
    // `cast computer` and `cast guide` (ct-49848, ct-49849). Neither costs
    // anything here: both are COMMAND_GROUPS entries, so assertOffGraph above
    // is what proves they are absent, and `cast computer setup` (ct-49790)
    // arrives with them for free — setup.ts is reached through run.ts, two
    // dynamic imports deep, so the file COUNT did not move when it landed.
    // The KB did, by 2: A10's longer doctor lines and setup guidance are prose
    // inside modules already on the graph, not new reach.
    //
    // The one file over ct-49758's number is shared/network/index.ts, which
    // main itself added under syncService.ts in 12ba53b50; the other candidate,
    // config/readAuthConfig.ts, WAS arriving through snippets.ts and was sent
    // back off the graph rather than paid for.
    //
    // Before lifting either number, find out WHY the graph grew. A group coming
    // back, or a whole subsystem arriving sideways through a leaf, is what this
    // exists to catch; a genuinely new module is not.
    expect(graph.nodes.size, "source files on index.ts's static graph").toBeLessThanOrEqual(188);
    expect(Math.round(graph.totalBytes / 1024), "KB of source on index.ts's static graph").toBeLessThanOrEqual(2663);
  }, GRAPH_WALK_TIMEOUT);

  test("main.ts, the process entry, reaches only the fast path", () => {
    const graph = buildBootGraph(path.join(SRC, "main.ts"));
    expect([...graph.nodes.keys()].map(rel).sort()).toEqual(["packages/cli/src/fastPath.ts", "packages/cli/src/main.ts"]);
  });

  test("the daemon carries no CLI command group either", () => {
    const graph = assertOffGraph(path.join(SRC, "daemon.ts"));
    // 273 measured on the union (ct-49848). The daemon is the process that RUNS
    // the workers, so all 26 `workers/*` modules are work it actually does
    // rather than a graph it carries by accident (ct-49758) — but the command
    // groups are not its work, which is what assertOffGraph checks above.
    expect(graph.nodes.size, "source files on daemon.ts's static graph").toBeLessThanOrEqual(273);
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
