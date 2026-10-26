// When CODECAST_SPAWN_TRACE names a file, every synchronous spawn in the test
// process is written there as it starts and as it returns, so the CI watchdog
// (scripts/ci/quiet-watchdog.sh) can name the one that never came back. The
// cli suite hung inside Bun's spawnSync with no child left (ct-71000, Oct 26),
// and the crash report's stack names no JavaScript. Node's spawnSync,
// execFileSync and execSync all run through Bun.spawnSync, so wrapping that one
// covers them. Off unless the variable is set.
import * as fs from "node:fs";

const file = process.env.CODECAST_SPAWN_TRACE;
if (file) {
  const spawnSync = Bun.spawnSync.bind(Bun);
  const cmdOf = (args: unknown[]) => {
    const first = args[0] as { cmd?: unknown } | unknown[];
    return JSON.stringify(Array.isArray(first) ? first : (first as { cmd?: unknown })?.cmd ?? first).slice(0, 240);
  };
  const note = (what: string, args: unknown[]) => {
    try { fs.appendFileSync(file, `${new Date().toISOString()} ${process.pid} ${what} ${cmdOf(args)}\n`); } catch { /* tracing never fails a test */ }
  };
  (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    note("start", args);
    try { return spawnSync(...args); } finally { note("done", args); }
  }) as typeof Bun.spawnSync;
}
