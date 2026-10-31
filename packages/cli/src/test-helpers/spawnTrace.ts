// When CODECAST_SPAWN_TRACE names a file, every synchronous spawn in the test
// process is written there as it starts and as it returns, so the CI watchdog
// (scripts/ci/quiet-watchdog.sh) can name the one that never came back. The
// cli suite hung inside Bun's spawnSync with no child left (ct-71000, Oct 26),
// and the crash report's stack names no JavaScript. Node's spawnSync,
// execFileSync and execSync all run through Bun.spawnSync, so wrapping that one
// covers them. Off unless the variable is set.
//
// The same file records each test file as it starts (this preload runs before
// the file loads) and as it ends. `bun test --parallel` prints a file's header
// and output only when the file reports, so the log cannot say which files are
// in flight; this can. Bun.main is the test file's path only where the preload
// runs once per file, which --isolate and --parallel give.
import { afterAll } from "bun:test";
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
  note("file-start", [Bun.main]);
  afterAll(() => note("file-done", [Bun.main]));
  (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    note("start", args);
    try { return spawnSync(...args); } finally { note("done", args); }
  }) as typeof Bun.spawnSync;
}
