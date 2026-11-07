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
import { AREAS, areaOf, type Area } from "./changed-path-scope";
import { TREE_WIDE_TEST } from "./tree-wide-tests";

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
const LITERAL_REACH = new RegExp(
  `["'\`/](?:packages/|\\.\\./)(${PACKAGE_DIRS.map((name) => name.replace(/-/g, "\\-")).join("|")})(?=["'\`/])`,
  "g",
);

const DOCS_REACH = /["'`/]docs\//;

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
  for (const match of code.matchAll(LITERAL_REACH)) {
    if (match[1] === ownPackage) continue;
    const area = areaOf(`packages/${match[1]}/`);
    if (area) hits.push([area, `packages/${match[1]}`]);
  }
  if (DOCS_REACH.test(code)) hits.push(["docs", "docs"]);
  return hits;
}

export type Reach = Map<Area | "unmapped", string[]>;

/** The areas the non-guard test files under `roots` reach, each with one example chain. */
export function reachOf(roots: string[]): Reach {
  const reach: Reach = new Map();
  const seen = new Set<string>();
  const note = (area: Area | "unmapped", chain: string[]) => {
    if (!reach.has(area)) reach.set(area, chain.map((file) => (file.startsWith("/") ? relative(ROOT, file) : file)));
  };

  for (const root of roots) {
    for (const test of testFiles(join(ROOT, root))) {
      if (TREE_WIDE_TEST.test(test)) continue;
      const stack: string[][] = [[test]];
      while (stack.length > 0) {
        const chain = stack.pop()!;
        const file = chain[chain.length - 1];
        if (seen.has(file)) continue;
        seen.add(file);
        if (file === PLATFORM_MARKER) {
          note("platform", [...chain.slice(0, -1), "@platform/*"]);
          continue;
        }
        const rel = relative(ROOT, file);
        if (rel.startsWith("..")) continue;
        const area = areaOf(rel);
        note(area ?? "unmapped", chain);
        if (area === "platform" || !CODE_EXT.test(file) || !statSync(file).isFile()) continue;
        const text = readFileSync(file, "utf8");
        const ownPackage = rel.startsWith("packages/") ? rel.split("/")[1] : "";
        const literals = rel in LITERAL_FALSE_POSITIVES ? [] : literalReach(file, text, ownPackage);
        for (const [area, dir] of literals) note(area, [...chain, `(reads ${dir} from disk)`]);
        for (const spec of importsOf(file, text)) {
          const target = resolveImport(spec, file);
          if (target && !seen.has(target)) stack.push([...chain, target]);
        }
      }
    }
  }
  return reach;
}

if (import.meta.main) {
  for (const [job, roots] of Object.entries(JOB_TEST_ROOTS)) {
    const started = performance.now();
    const reach = reachOf(roots);
    console.log(`${job} (${Math.round(performance.now() - started)}ms)`);
    for (const area of [...AREAS, "unmapped" as const]) {
      const chain = reach.get(area);
      if (chain) console.log(`  ${area}: ${chain.join(" -> ")}`);
    }
  }
}
