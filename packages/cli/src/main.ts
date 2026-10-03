#!/usr/bin/env node
// Process entry for `cast` / `codecast`: the compiled binary, dist, and
// from-source wrapper scripts all start here. Hot-path verbs run from
// fastPath.ts's small graph; everything else loads the full CLI. The dynamic
// import() is load-bearing: it keeps index.js lazy in the compiled bundle.
import { spawnSync } from "node:child_process";
import { runFastPath } from "./fastPath.js";

const workerArgs = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
// A prompt dry run (scripts/prompt-dry-run.ts) gives its agent an empty state
// directory and answers every `cast` through a guard, which hands the real CLI
// the real state directory back. Started with that empty directory, this CLI
// was reached around the guard (an absolute path, a profile's PATH), so the
// call goes to the guard too and the run stays in its world. The guard runs
// with DRY_RUN_GUARD cleared, so there is never a second hop.
const dryRunGuard = process.env.DRY_RUN_GUARD;
if (dryRunGuard && process.env.CODECAST_DIR && process.env.CODECAST_DIR === process.env.DRY_RUN_EMPTY_CODECAST_DIR) {
  const guarded = spawnSync(dryRunGuard, workerArgs, { stdio: "inherit", env: { ...process.env, DRY_RUN_GUARD: "" } });
  process.exit(guarded.status ?? 1);
} else if (workerArgs[0] === "_worker") {
  import("./workers/runtime.js").then(({ runWorker }) => runWorker(workerArgs.length === 2 ? workerArgs[1] : "")).catch(() => {
    process.stderr.write("worker startup failed\n");
    process.exit(64);
  });
} else if (process.env.CODECAST_WORKER === "1") {
  process.stderr.write("worker CLI recursion refused\n");
  process.exit(64);
} else if (!runFastPath(process.argv)) {
  import("./index.js").catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
