// The daemon's data sync tick: every minute, `cast datasync now --quiet` in a
// child process, so walking and hashing a folder never holds the daemon's
// event loop. One pass at a time; a pass that runs past its budget is killed
// and the next tick starts over from the state file.

import { spawn, type ChildProcess } from "../proc.js";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { mirrorProcessInvocation } from "../cloud/mirror/process.js";

export const DATA_SYNC_TICK_MS = 60_000;
const PASS_BUDGET_MS = 20 * 60_000;

export function startDataSyncLoop(o: { shouldRun: () => boolean; log: (line: string) => void; firstTickMs?: number }): { stop: () => void } {
  let child: ChildProcess | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || child || !o.shouldRun()) return;
    const inv = mirrorProcessInvocation(process.execPath, process.argv[1] ?? "", process.platform, ["datasync", "now", "--quiet"]);
    const c = spawn(inv.command, inv.args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: agentSpawnPath(), CODECAST_NO_AUTO_UPDATE: "1" } });
    child = c;
    const kill = setTimeout(() => c.kill("SIGKILL"), PASS_BUDGET_MS);
    kill.unref();
    const relay = (b: Buffer) => { for (const line of String(b).split("\n")) if (line.trim()) o.log(line.trimEnd()); };
    c.stdout?.on("data", relay);
    c.stderr?.on("data", relay);
    c.on("error", (err) => o.log(`pass did not start: ${err.message}`));
    c.on("close", () => { clearTimeout(kill); child = undefined; });
  };
  const first = setTimeout(tick, o.firstTickMs ?? 45_000);
  first.unref();
  const every = setInterval(tick, DATA_SYNC_TICK_MS);
  every.unref();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
      child?.kill("SIGTERM");
    },
  };
}
