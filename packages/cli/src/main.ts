#!/usr/bin/env node
// Process entry for `cast` / `codecast`: the compiled binary, dist, and
// from-source wrapper scripts all start here. Hot-path verbs run from
// fastPath.ts's small graph; everything else loads the full CLI. The dynamic
// import() is load-bearing: it keeps index.js lazy in the compiled bundle.
import { runFastPath } from "./fastPath.js";

const workerArgs = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
if (workerArgs[0] === "_worker") {
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
