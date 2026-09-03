#!/usr/bin/env bun
// Writes packages/cli/src/daemonBuildId.ts from the daemon's import closure.
//
//   bun scripts/stamp-daemon-build-id.ts           rewrite the constant
//   bun scripts/stamp-daemon-build-id.ts --check   fail when it is stale
//
// The release paths only run --check. They cannot stamp: the finalize workflow
// rejects a release whose packages/cli tree differs from the commit it built,
// so the stamp has to be a normal source edit a developer commits.

import fs from "fs";
import path from "path";
import {
  computeDaemonBuildId,
  findRepoRoot,
  renderBuildIdFile,
  BUILD_ID_RE,
} from "../src/daemonBuildIdCompute.js";

const check = process.argv.includes("--check");
const repoRoot = findRepoRoot();
const target = path.join(repoRoot, "packages/cli/src/daemonBuildId.ts");

const { id, files } = computeDaemonBuildId(repoRoot);
let current: string | null = null;
try {
  current = fs.readFileSync(target, "utf-8").match(BUILD_ID_RE)?.[1] ?? null;
} catch {}

if (current === id) {
  console.log(`daemon build id ${id} is current (${files.length} files)`);
  process.exit(0);
}

if (check) {
  console.error(
    `Stale daemon build id: the stamp says ${current ?? "nothing"} but the closure hashes to ${id} ` +
      `(${files.length} files).\nRun: cd packages/cli && bun scripts/stamp-daemon-build-id.ts, then commit src/daemonBuildId.ts`,
  );
  process.exit(1);
}

fs.writeFileSync(target, renderBuildIdFile(id));
console.log(`daemon build id ${current ?? "none"} -> ${id} (${files.length} files)`);
