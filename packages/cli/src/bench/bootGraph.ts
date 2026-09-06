// The static import graph of a CLI entry point: which source files bun has to
// load and evaluate before the entry's first statement runs.
//
// fastPath.ts explains why this matters: ES imports are hoisted, so the cost of
// a command is the cost of every module statically reachable from the entry,
// whether the command touches it or not. `await import()` inside an action is
// what keeps a module off that graph. This walker is the meter for that rule —
// the bench prints it, and bootGraph.guard.test.ts fails when a heavy command
// group creeps back onto the graph as a static import (ct-49546).
//
// Leaf module: node builtins only, so it can run before anything is installed.

import * as fs from "node:fs";
import * as path from "node:path";

export interface GraphNode {
  /** Absolute path of the source file. */
  file: string;
  /** Files this one imports statically, in source order. */
  imports: string[];
  bytes: number;
}

export interface BootGraph {
  entry: string;
  /** Every repo source file reachable from the entry through static imports. */
  nodes: Map<string, GraphNode>;
  /** Bare specifiers (npm packages) reached statically, deduped. */
  externals: Set<string>;
  totalBytes: number;
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];

/** Repo root, found by walking up from a source file to the workspace root. */
export function repoRootFrom(start: string): string {
  let dir = path.dirname(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "bun.lock")) || fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(start);
    dir = parent;
  }
}

/**
 * Static import specifiers of a source file, in source order.
 *
 * Mirrors what bun's transpiler leaves behind: `import type` and import
 * statements whose every named specifier is `type`-marked are erased, so they
 * cost nothing at runtime and do not belong on the graph. `import()` is a call
 * expression, not a statement, so the statement anchors below never match it —
 * that is exactly the distinction the guard exists to enforce.
 */
export function staticImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  // The clause between the keyword and `from` may only hold what an import
  // clause can hold — names, braces, commas, `*`, `as`, whitespace. Anything
  // else ends the match at once, which is what keeps `import("./x.js")` (an
  // open paren) and a 100 KB `export const CATALOG = {…}` from being scanned
  // as statements; an unbounded lazy clause both invented edges and ran
  // quadratically over the string catalogs.
  const stmt = /(^|[\n;])[ \t]*(import|export)\s+([\w$*{},\s]*?)from\s*["']([^"']+)["']/g;
  for (let m = stmt.exec(source); m; m = stmt.exec(source)) {
    const clause = m[3];
    const spec = m[4];
    if (/^\s*type\b/.test(clause)) continue; // import type { X } from "..."
    if (isAllTypeSpecifiers(clause)) continue; // import { type X, type Y } from "..."
    out.push(spec);
  }
  const bare = /(^|[\n;])[ \t]*import\s*["']([^"']+)["']/g;
  for (let m = bare.exec(source); m; m = bare.exec(source)) out.push(m[2]);
  return out;
}

function isAllTypeSpecifiers(clause: string): boolean {
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return false;
  // A default or namespace binding outside the braces is a value import.
  if (clause.slice(0, clause.indexOf("{")).trim().replace(/,$/, "").trim().length > 0) return false;
  const names = braces[1].split(",").map((s) => s.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/** Resolves an import specifier to a repo source file, or null when it is a package. */
export function resolveSpecifier(spec: string, fromFile: string, root: string): string | null {
  let base: string;
  if (spec.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith("@codecast/shared")) {
    base = path.join(root, "packages/shared", spec.slice("@codecast/shared".length) || "index");
  } else if (spec.startsWith("@platform/")) {
    const rest = spec.slice("@platform/".length);
    const slash = rest.indexOf("/");
    const pkg = slash === -1 ? rest : rest.slice(0, slash);
    base = path.join(root, "platform/packages", pkg, "src", slash === -1 ? "index" : rest.slice(slash + 1));
  } else {
    return null;
  }
  // "./x.js" in TypeScript ESM means "./x.ts" on disk.
  const stripped = base.replace(/\.(js|mjs|jsx)$/, "");
  for (const candidate of [base, ...SOURCE_EXTS.map((e) => stripped + e), ...SOURCE_EXTS.map((e) => path.join(stripped, "index" + e))]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Walks every static import edge from `entry`, breadth first. */
export function buildBootGraph(entry: string, rootArg?: string): BootGraph {
  // Resolve before finding the root: repoRootFrom walks parent directories, and
  // a relative entry walks a relative path that never reaches the workspace
  // root, which silently turns every @codecast/shared file into an "external"
  // and hides a third of the graph.
  const entryAbs = path.resolve(entry);
  const root = rootArg ?? repoRootFrom(entryAbs);
  const nodes = new Map<string, GraphNode>();
  const externals = new Set<string>();
  const queue = [entryAbs];
  while (queue.length) {
    const file = queue.shift()!;
    if (nodes.has(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    const imports: string[] = [];
    for (const spec of staticImportSpecifiers(source)) {
      const resolved = resolveSpecifier(spec, file, root);
      if (!resolved) {
        externals.add(spec);
        continue;
      }
      imports.push(resolved);
      queue.push(resolved);
    }
    nodes.set(file, { file, imports, bytes: Buffer.byteLength(source) });
  }
  let totalBytes = 0;
  for (const n of nodes.values()) totalBytes += n.bytes;
  return { entry: path.resolve(entry), nodes, externals, totalBytes };
}

/** The shortest static import chain from the entry to `target`, or null. */
export function importChain(graph: BootGraph, target: string): string[] | null {
  const goal = path.resolve(target);
  if (!graph.nodes.has(goal)) return null;
  const seen = new Set([graph.entry]);
  const queue: string[][] = [[graph.entry]];
  while (queue.length) {
    const chain = queue.shift()!;
    const head = chain[chain.length - 1];
    if (head === goal) return chain;
    for (const next of graph.nodes.get(head)?.imports ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}

/** Every repo file the entry reaches only THROUGH `via` (what lazifying `via` would save). */
export function exclusiveTo(graph: BootGraph, via: string): Set<string> {
  const target = path.resolve(via);
  const reachable = (skip: string | null): Set<string> => {
    const seen = new Set<string>();
    const queue = [graph.entry];
    while (queue.length) {
      const file = queue.shift()!;
      if (file === skip || seen.has(file)) continue;
      seen.add(file);
      for (const next of graph.nodes.get(file)?.imports ?? []) queue.push(next);
    }
    return seen;
  };
  const without = reachable(target);
  const out = new Set<string>();
  for (const file of reachable(null)) if (!without.has(file)) out.add(file);
  return out;
}

if (import.meta.main) {
  const entry = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "main.ts");
  const graph = buildBootGraph(entry);
  const root = repoRootFrom(path.resolve(entry));
  const rel = (f: string) => path.relative(root, f);
  console.log(`entry     ${rel(path.resolve(entry))}`);
  console.log(`modules   ${graph.nodes.size} repo source files`);
  console.log(`bytes     ${(graph.totalBytes / 1024).toFixed(0)} KB of source`);
  console.log(`packages  ${graph.externals.size} bare specifiers`);
  if (process.argv.includes("--heavy")) {
    const entryNode = graph.nodes.get(path.resolve(entry))!;
    const rows = entryNode.imports
      .map((f) => ({ file: rel(f), exclusive: exclusiveTo(graph, f).size }))
      .filter((r) => r.exclusive > 0)
      .sort((a, b) => b.exclusive - a.exclusive);
    console.log("\ndirect imports of the entry, by modules only they pull in:");
    for (const r of rows.slice(0, 40)) console.log(`  ${String(r.exclusive).padStart(4)}  ${r.file}`);
  }
}
