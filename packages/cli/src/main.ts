#!/usr/bin/env node
// Process entry for `cast` / `codecast`: the compiled binary, dist, and
// from-source wrapper scripts all start here. Hot-path verbs run from
// fastPath.ts's small graph; everything else loads the full CLI. The dynamic
// import() is load-bearing: it keeps index.js lazy in the compiled bundle.
import { runFastPath } from "./fastPath.js";

if (!runFastPath(process.argv)) {
  import("./index.js").catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
