#!/usr/bin/env bun
// The test files that run on every change, in the ungated `test-always` job.
//
// Two kinds:
// - Tree-wide tests: guards (`*.guard.test.*`) and ratchets
//   (`*.ratchet.test.*`). They read source trees off disk, often across
//   packages (the doc references guard checks every path the docs name, the
//   max lines ratchet walks every package), so no path filter can say which
//   change might break one.
// - Crossing tests: a file whose imports or disk reads reach an area its own
//   job does not gate on (test-reach.ts). The job can be skipped for a change
//   that breaks such a file, so the file runs here instead of widening the
//   job's gate for every file in it.
//
// Each package's files run from that package's directory with the flags its
// own job uses, so its bunfig preload and isolation apply. The package jobs
// still run these files too when they run.
//
// `bun scripts/ci/always-run-tests.ts` runs them; `--list` prints them.

import { join, relative } from "node:path";
import { crossingTests, testFiles, TREE_WIDE_TEST } from "./test-reach";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Where each package's files run from, the directories its job tests, and the
 * `bun test` flags that job runs with.
 */
export const SUITES: Array<{ job: string; dir: string; roots: string[]; flags: string[] }> = [
  { job: "test-shared", dir: "packages/shared", roots: ["."], flags: [] },
  { job: "test-convex", dir: "packages/convex", roots: ["convex", "scripts"], flags: [] },
  // test-cli runs --parallel, a fresh global per file: the boot graph guards
  // count the module registry, which earlier files in one process have filled.
  { job: "test-cli", dir: "packages/cli", roots: ["src"], flags: ["--parallel"] },
  { job: "test-cli", dir: "packages/evals", roots: ["src"], flags: [] },
  // test-web and test-mobile run with --isolate: their mount tests replace
  // modules with mock.module, which is permanent within one process.
  { job: "test-web", dir: "packages/web", roots: ["."], flags: ["--isolate"] },
  { job: "test-mobile", dir: "packages/mobile", roots: ["."], flags: ["--isolate"] },
];

/** A suite's always-run files, relative to its package directory. */
export function alwaysRunFiles(suite: (typeof SUITES)[number]): string[] {
  const pkg = join(ROOT, suite.dir);
  const roots = suite.roots.map((root) => `${join(pkg, root)}/`);
  const treeWide = suite.roots.flatMap((root) => testFiles(join(pkg, root))).filter((file) => TREE_WIDE_TEST.test(file));
  const crossing = crossingTests(suite.job)
    .map(({ file }) => join(ROOT, file))
    .filter((file) => roots.some((root) => file.startsWith(root)));
  return [...new Set([...treeWide, ...crossing])].map((file) => `./${relative(pkg, file)}`).sort();
}

if (import.meta.main) {
  const list = process.argv.includes("--list");
  const failed: string[] = [];
  for (const suite of SUITES) {
    const files = alwaysRunFiles(suite);
    if (list) {
      console.log(`${suite.dir} (${files.length})`);
      for (const file of files) console.log(`  ${file}`);
      continue;
    }
    if (files.length === 0) continue;
    console.log(`::group::${suite.dir}: ${files.length} files`);
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
    console.log(`::error::Always-run tests failed in ${failed.join(", ")}`);
    process.exit(1);
  }
}
