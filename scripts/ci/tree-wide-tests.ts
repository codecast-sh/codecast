#!/usr/bin/env bun
// Tree-wide tests: the guard (`*.guard.test.*`) and ratchet (`*.ratchet.test.*`)
// files. They read source trees off disk rather than importing what they check,
// often across packages (the doc references guard checks every path the docs
// name, the max lines ratchet walks every package), so no path filter can say
// which change might turn one red. The `test-guards` job in ci.yml runs all of
// them on every change, and scripts/ci/test-reach.ts leaves them out of the
// reach it checks the per-package gates against.
//
// `bun scripts/ci/tree-wide-tests.ts` runs them, package by package, from each
// package's directory so its bunfig preload applies. `--list` prints them.

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

export const TREE_WIDE_TEST = /\.(guard|ratchet)\.test\.(ts|tsx|js|jsx|mjs|cjs)$/;

const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", ".next", "build", ".turbo", "coverage", "out"]);

/**
 * The packages with tree-wide tests, the directories their CI suite reads
 * tests from, and the `bun test` flags that suite runs with. A package's
 * tree-wide tests run exactly as its own job would run them.
 */
export const SUITES: Array<{ dir: string; roots: string[]; flags: string[] }> = [
  { dir: "packages/shared", roots: ["."], flags: [] },
  { dir: "packages/convex", roots: ["convex", "scripts"], flags: [] },
  { dir: "packages/cli", roots: ["src"], flags: [] },
  { dir: "packages/evals", roots: ["src"], flags: [] },
  // test-web and test-mobile run with --isolate: their mount tests replace
  // modules with mock.module, which is permanent within one process.
  { dir: "packages/web", roots: ["."], flags: ["--isolate"] },
  { dir: "packages/mobile", roots: ["."], flags: ["--isolate"] },
];

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (TREE_WIDE_TEST.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** A suite's tree-wide test files, relative to its package directory. */
export function treeWideFiles(suite: (typeof SUITES)[number]): string[] {
  const pkg = join(ROOT, suite.dir);
  return suite.roots
    .flatMap((root) => walk(join(pkg, root), []))
    .map((file) => `./${relative(pkg, file)}`)
    .sort();
}

if (import.meta.main) {
  const list = process.argv.includes("--list");
  const failed: string[] = [];
  for (const suite of SUITES) {
    const files = treeWideFiles(suite);
    if (list) {
      console.log(`${suite.dir} (${files.length})`);
      for (const file of files) console.log(`  ${file}`);
      continue;
    }
    if (files.length === 0) continue;
    console.log(`::group::${suite.dir}: ${files.length} tree-wide test files`);
    const started = performance.now();
    const proc = Bun.spawn(["bun", "test", ...suite.flags, ...files], {
      cwd: join(ROOT, suite.dir),
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    console.log("::endgroup::");
    console.log(`${suite.dir}: exit ${code} in ${Math.round((performance.now() - started) / 1000)}s`);
    if (code !== 0) failed.push(suite.dir);
  }
  if (failed.length > 0) {
    console.log(`::error::Tree-wide tests failed in ${failed.join(", ")}`);
    process.exit(1);
  }
}
