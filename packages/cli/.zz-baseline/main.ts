#!/usr/bin/env node
// Process entry for `cast` / `codecast`: the compiled binary, dist, and
// from-source wrapper scripts all start here. Hot-path verbs run from
// fastPath.ts's small graph; everything else loads the full CLI. The dynamic
// import() is load-bearing: it keeps index.js lazy in the compiled bundle.
import { spawnSync } from "./proc.js";
import { runFastPath } from "./fastPath.js";
import { installSyncStdio } from "./syncStdio.js";

// Before anything can touch process.stdout: a large write into a pipe must
// arrive whole (syncStdio.ts).
installSyncStdio();

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
  runInteractiveIfClamped().then((ran) => ran || import("./index.js")).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

/**
 * Heavy cloud verbs started from an agent's shell re-run themselves at
 * Interactive priority (interactiveJob.ts), or they starve for tens of
 * minutes looking hung. A prompt given on stdin travels in a file.
 */
async function runInteractiveIfClamped(): Promise<boolean> {
  const { priorityClamped, runAsInteractiveJob, wantsInteractivePriority } = await import("./interactiveJob.js");
  if (!wantsInteractivePriority(workerArgs) || !priorityClamped()) return false;
  const { selfExecInfo } = await import("./selfExec.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  let stdin: string | undefined;
  if (!process.stdin.isTTY && workerArgs.includes("-")) {
    stdin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-stdin-")), "in");
    fs.writeFileSync(stdin, fs.readFileSync(0));
  }
  const self = selfExecInfo(...workerArgs);
  const code = await runAsInteractiveJob([self.executablePath, ...self.args], { stdin });
  if (stdin) fs.rmSync(path.dirname(stdin), { recursive: true, force: true });
  process.exit(code);
}
