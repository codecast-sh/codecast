#!/usr/bin/env bun
// Which areas each gated test job's test files can be broken by. A job's reach
// is the area of every file its test files import, directly or through other
// files, plus every package directory a file in that closure names in a string
// literal while also reading the disk: a test that reads
// `../../convex/convex/schema.ts` imports nothing from convex but still breaks
// when convex changes.
//
// Tree-wide tests (`*.guard.test.*`, `*.ratchet.test.*`) are left out on
// purpose: they read source trees by design and run in the ungated
// `test-guards` job on every change (scripts/ci/tree-wide-tests.ts).
//
// ci-workflow.contract.test.ts compares this reach with JOB_AREAS in
// changed-path-scope.ts and fails when a job reaches an area it does not gate
// on, because that job would be skipped for a change that can break it.
//
// Resolution needs no `bun install`: workspace packages (`@codecast/*`) resolve
// through their package.json, `@platform/*` counts as the platform area without
// being walked, and npm packages are not followed.
//
// `bun scripts/ci/test-reach.ts` prints each job's reach with one example chain
// per area.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { AREAS, JOB_AREAS, areaOf, type Area } from "./changed-path-scope";

export const TREE_WIDE_TEST = /\.(guard|ratchet)\.test\.(ts|tsx|js|jsx|mjs|cjs)$/;

const ROOT = join(import.meta.dir, "..", "..");

/** The directories whose test files each gated test job runs. */
export const JOB_TEST_ROOTS: Record<string, string[]> = {
  "test-convex": ["packages/convex/convex", "packages/convex/scripts"],
  "test-web": ["packages/web"],
  "test-cli": ["packages/cli/src", "packages/evals/src"],
  "test-shared": ["packages/shared"],
  "test-mobile": ["packages/mobile"],
  "test-electron": ["packages/electron"],
};

const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", ".next", "build", ".turbo", "coverage", "out"]);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/;
const READS_DISK = /\b(readFileSync|readdirSync|readFile|readdir|existsSync|statSync|Bun\.file|Bun\.Glob|new Glob|globSync|scanSync)\b/;

export function testFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) testFiles(full, out);
    } else if (TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

type Workspace = { dir: string; exports: Record<string, string> };

/** Every workspace package by name, with its subpath exports. */
const WORKSPACES = new Map<string, Workspace>();
for (const name of readdirSync(join(ROOT, "packages"))) {
  const manifest = join(ROOT, "packages", name, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const exports: Record<string, string> = {};
  if (typeof pkg.exports === "string") exports["."] = pkg.exports;
  else if (pkg.exports && typeof pkg.exports === "object") {
    for (const [key, value] of Object.entries(pkg.exports)) {
      const target = typeof value === "string" ? value : (value as any)?.import ?? (value as any)?.default;
      if (typeof target === "string") exports[key] = target;
    }
  }
  if (!exports["."] && typeof pkg.main === "string") exports["."] = pkg.main;
  WORKSPACES.set(pkg.name, { dir: join(ROOT, "packages", name), exports });
}

const PLATFORM_MARKER = join(ROOT, "platform", "packages");

function resolveFile(spec: string, fromDir: string): string | null {
  try {
    const resolved = Bun.resolveSync(spec, fromDir);
    return resolved.startsWith("/") && existsSync(resolved) && statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/** The file an import names, or null for builtins and npm packages. */
export function resolveImport(spec: string, fromFile: string): string | null {
  if (spec.startsWith("node:") || spec.startsWith("bun:")) return null;
  if (spec.startsWith("@platform/")) return PLATFORM_MARKER;
  const workspaceName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  const workspace = WORKSPACES.get(workspaceName);
  if (workspace) {
    const sub = spec.slice(workspaceName.length);
    const key = sub ? `.${sub}` : ".";
    const target = workspace.exports[key] ?? (sub ? `.${sub}` : "./index");
    // A subpath bun cannot resolve to a file (a .d.ts, a generated file not
    // checked in) still lands in that package's area.
    return resolveFile(join(workspace.dir, target), workspace.dir) ?? join(workspace.dir, "package.json");
  }
  const resolved = resolveFile(spec, dirname(fromFile));
  if (!resolved || resolved.includes("/node_modules/")) return null;
  return resolved;
}

const transpilers = new Map<string, Bun.Transpiler>();
function transpilerFor(file: string): Bun.Transpiler {
  const loader = file.endsWith(".tsx") ? "tsx" : file.endsWith(".jsx") ? "jsx" : /\.[mc]?js$/.test(file) ? "js" : "ts";
  let transpiler = transpilers.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader: loader as "ts" });
    transpilers.set(loader, transpiler);
  }
  return transpiler;
}

function importsOf(file: string, text: string): string[] {
  try {
    return transpilerFor(file).scanImports(text).map((entry) => entry.path);
  } catch {
    return [];
  }
}

// Every directory under packages/, manifest or not (browser-extension has none).
const PACKAGE_DIRS = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const PACKAGE_NAMES = PACKAGE_DIRS.map((name) => name.replace(/-/g, "\\-")).join("|");
// `../convex/` or `../../web/`: a path relative to the file, so it can only mean
// this repository, from any file.
const RELATIVE_REACH = new RegExp(`["'\`/]\\.\\./(${PACKAGE_NAMES})(?=["'\`/])`, "g");
// `packages/web/`: from test code it means this repository; from product code
// it is usually a path in someone else's checkout (a worktree, a workspace),
// so it counts only in test files and test helpers.
const ROOTED_REACH = new RegExp(`["'\`/]packages/(${PACKAGE_NAMES})(?=["'\`/])`, "g");
const DOCS_REACH = /["'`/]docs\//;
const TEST_CODE = /(\.test\.[a-z]+$|\/(test-helpers|__tests__|__fixtures__|fixtures)\/)/;

/**
 * Files that read the disk and name another package or docs/ in a string that
 * is never a path they read. Each entry says what the string is. The literal
 * scan skips these files; their imports are still followed.
 */
export const LITERAL_FALSE_POSITIVES: Record<string, string> = {
  "packages/convex/convex/signals.test.ts": "docs/line/principles.md is a principles value in a fixture",
  "packages/web/server/staticAssets.test.ts": "/docs/guide.js is a URL path passed to isBuildArtifactPath",
  "packages/web/lib/__tests__/tabLocation.test.ts": "/docs/test and docs/why?#.md are tab URLs it parses",
};

/** Code with comments removed, so a path named in prose is not counted. */
function withoutComments(file: string, text: string): string {
  try {
    return transpilerFor(file).transformSync(text);
  } catch {
    return text;
  }
}

/** The areas, and the directories behind them, a disk-reading file names outside its own package. */
function literalReach(file: string, text: string, ownPackage: string): Array<[Area, string]> {
  if (!READS_DISK.test(text)) return [];
  const code = withoutComments(file, text);
  if (!READS_DISK.test(code)) return [];
  const hits: Array<[Area, string]> = [];
  const testCode = TEST_CODE.test(file);
  const matches = [...code.matchAll(RELATIVE_REACH), ...(testCode ? code.matchAll(ROOTED_REACH) : [])];
  for (const match of matches) {
    if (match[1] === ownPackage) continue;
    const area = areaOf(`packages/${match[1]}/`);
    if (area) hits.push([area, `packages/${match[1]}`]);
  }
  if (testCode && DOCS_REACH.test(code)) hits.push(["docs", "docs"]);
  return hits;
}

export type Reach = Map<Area | "unmapped", string[]>;

type Node = { area: Area | "unmapped" | null; deps: string[]; reads: Array<[Area, string]> };

const nodes = new Map<string, Node>();

/** One file's area, the files it imports and what it reads off disk, read once per process. */
function nodeOf(file: string): Node {
  let node = nodes.get(file);
  if (node) return node;
  node = { area: null, deps: [], reads: [] };
  nodes.set(file, node);
  if (file === PLATFORM_MARKER) {
    node.area = "platform";
    return node;
  }
  const rel = relative(ROOT, file);
  if (rel.startsWith("..")) return node;
  node.area = areaOf(rel) ?? "unmapped";
  // The mirror's own imports are npm packages.
  if (node.area === "platform" || !CODE_EXT.test(file) || !existsSync(file) || !statSync(file).isFile()) return node;
  const text = readFileSync(file, "utf8");
  const ownPackage = rel.startsWith("packages/") ? rel.split("/")[1] : "";
  node.reads = rel in LITERAL_FALSE_POSITIVES ? [] : literalReach(file, text, ownPackage);
  for (const spec of importsOf(file, text)) {
    const target = resolveImport(spec, file);
    if (target) node.deps.push(target);
  }
  return node;
}

/** The areas one test file reaches, each with the chain of files that first reached it. */
export function reachOfFile(test: string): Reach {
  const reach: Reach = new Map();
  const parent = new Map<string, string | null>([[test, null]]);
  const chainTo = (file: string) => {
    const chain: string[] = [];
    for (let at: string | null = file; at; at = parent.get(at) ?? null) {
      chain.unshift(at === PLATFORM_MARKER ? "@platform/*" : relative(ROOT, at));
    }
    return chain;
  };
  const queue = [test];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    const node = nodeOf(file);
    if (node.area && !reach.has(node.area)) reach.set(node.area, chainTo(file));
    for (const [area, dir] of node.reads) {
      if (!reach.has(area)) reach.set(area, [...chainTo(file), `(reads ${dir} from disk)`]);
    }
    for (const dep of node.deps) {
      if (!parent.has(dep)) {
        parent.set(dep, file);
        queue.push(dep);
      }
    }
  }
  return reach;
}

/** A job's test files, without the tree-wide ones. */
export function jobTests(job: string): string[] {
  return JOB_TEST_ROOTS[job].flatMap((root) => testFiles(join(ROOT, root))).filter((file) => !TREE_WIDE_TEST.test(file));
}

/** The areas a job's test files reach together, each with one example chain. */
export function reachOf(job: string): Reach {
  const reach: Reach = new Map();
  for (const test of jobTests(job)) {
    for (const [area, chain] of reachOfFile(test)) if (!reach.has(area)) reach.set(area, chain);
  }
  return reach;
}

/**
 * A job's test files that reach an area the job does not gate on, with what
 * they reach. The job can be skipped for a change that breaks them, so the
 * always-run job runs them on every change. A file outside every area counts
 * as no crossing: any change to one runs every job.
 */
export function crossingTests(job: string): Array<{ file: string; areas: Array<[Area, string[]]> }> {
  const gate = new Set<string>(JOB_AREAS[job]);
  const out: Array<{ file: string; areas: Array<[Area, string[]]> }> = [];
  for (const test of jobTests(job)) {
    const areas = [...reachOfFile(test)].filter(([area]) => area !== "unmapped" && !gate.has(area)) as Array<[Area, string[]]>;
    if (areas.length > 0) out.push({ file: relative(ROOT, test), areas });
  }
  return out;
}

if (import.meta.main) {
  for (const job of Object.keys(JOB_TEST_ROOTS)) {
    const started = performance.now();
    const reach = reachOf(job);
    const crossing = crossingTests(job);
    console.log(`${job} (${Math.round(performance.now() - started)}ms): gates on ${JOB_AREAS[job].join(", ")}; ${crossing.length} test files reach further`);
    for (const area of [...AREAS, "unmapped" as const]) {
      const chain = reach.get(area);
      if (chain) console.log(`  ${area}: ${chain.join(" -> ")}`);
    }
    for (const { file, areas } of crossing) console.log(`  always run ${file} (${areas.map(([area]) => area).join(", ")})`);
  }
}
