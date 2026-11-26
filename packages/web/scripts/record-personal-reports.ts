// Records the real runner's progress reports for the personal Ship (cli personalFlow.e2e.test.ts, which runs the shipped
// template on real git) into lib/ship/__tests__/personalReports.json, which the web's personal journey, diagram and
// report tests replay through the server's merge (lib/ship/__tests__/replayReports.ts), then the render gallery's
// personal runs from them (gen-personal-gallery-runs.ts). Run it again whenever the
// template or the runner changes what it reports:
//
//   bun packages/web/scripts/record-personal-reports.ts
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..", "..", "..");
const out = path.join(root, "packages/web/lib/ship/__tests__/personalReports.json");
const r = spawnSync("bun", ["test", "src/workflow/personalFlow.e2e.test.ts"], {
  cwd: path.join(root, "packages/cli"), stdio: "inherit", env: { ...process.env, RECORD_PERSONAL_REPORTS: out },
});
if (r.status !== 0) process.exit(r.status ?? 1);
// The gallery's personal runs are moments of these recordings.
process.exit(spawnSync("bun", [path.join(import.meta.dir, "gen-personal-gallery-runs.ts")], { stdio: "inherit" }).status ?? 1);
