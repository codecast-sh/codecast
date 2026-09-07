import fs from "node:fs";
import path from "node:path";
import { ensureWatchdogSupervised, runWatchdog } from "../daemon.js";

if (process.argv[2] === "supervise") {
  fs.writeFileSync(path.join(process.env.HOME!, "fixture-pid"), String(process.pid));
  await ensureWatchdogSupervised(true);
  await ensureWatchdogSupervised(true);
} else {
  await runWatchdog();
}
process.exit(0);
