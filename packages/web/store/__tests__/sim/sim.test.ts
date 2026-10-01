// The one sim test file that imports the store
// (docs/architecture/multiplayer-sim-harness.md, section 3.8).
//
// The store and convex imports cost seconds under --isolate, so every
// self-test and scenario registers its tests from this one file instead of
// paying that once per file. Each `*.selftest.ts` and `*.scenario.ts` is
// imported here, sorted, by glob, so adding one never edits a shared index.
//
//   SIM_SCENARIO=<substring>  import only the files whose name contains it
//   SIM_SELFTEST=0            skip the self-tests

import { expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const GROUPS: { dir: string; pattern: string; on: boolean }[] = [
  { dir: "selftests", pattern: "*.selftest.ts", on: process.env.SIM_SELFTEST !== "0" },
  { dir: "scenarios", pattern: "*.scenario.ts", on: true },
];

const filter = process.env.SIM_SCENARIO;
const loaded: string[] = [];
for (const { dir, pattern, on } of GROUPS) {
  const cwd = join(import.meta.dir, dir);
  if (!on || !existsSync(cwd)) continue;
  const files = [...new Glob(pattern).scanSync({ cwd })].sort();
  for (const file of files) {
    if (filter && !file.includes(filter)) continue;
    await import(join(cwd, file));
    loaded.push(`${dir}/${file}`);
  }
}

// Always present, so a filter that matches nothing still runs (and passes) as
// a file with zero scenarios rather than a file bun reports as empty.
test(`sim files loaded: ${loaded.length ? loaded.join(", ") : "none"}`, () => {
  for (const file of loaded) expect(filter ? file.includes(filter) : true).toBe(true);
});
