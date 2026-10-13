// CPU load for delivery tests and soaks: busy `yes` processes that compete
// with the pane under test for the scheduler, the condition a paste splits or
// stalls under (typed-delivery-soak.ts, daemon.inject-cross-user-paste.e2e).
//
// `yes` is spawned directly, never through a shell: killing `sh -c "yes"`
// leaves `yes` running under launchd, and 88 of them starved the machine on
// 2026-09-20. Each runs in its own process group so the kill reaches it even
// if bun's handle is gone. That same group keeps a terminal's Ctrl-C from
// reaching the loaders, so the cleanup runs on exit AND on SIGINT, SIGTERM and
// SIGHUP, registered once per process for every caller. When no other
// listener handles the signal, the process then exits as the signal would
// have made it; a caller with its own handler (the soak) still runs it.
import { spawn, type ChildProcess } from "../proc.js";
import os from "node:os";

export type CpuLoad = { on(n: number): void; off(): void };

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const live = new Set<ChildProcess>();
let cleanupInstalled = false;

function kill(p: ChildProcess): void {
  live.delete(p);
  if (p.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } }
  try { p.kill("SIGKILL"); } catch { /* already gone */ }
}

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const offAll = () => { for (const p of [...live]) kill(p); };
  process.on("exit", offAll);
  for (const sig of SIGNALS) {
    const onSignal = () => {
      offAll();
      if (process.listenerCount(sig) === 1) process.exit(128 + (os.constants.signals[sig] ?? 1));
    };
    process.on(sig, onSignal);
  }
}

export function cpuLoad(): CpuLoad {
  installCleanup();
  const loaders: ChildProcess[] = [];
  return {
    on: (n) => {
      for (let i = 0; i < n; i++) {
        const p = spawn("yes", [], { stdio: "ignore", detached: true });
        loaders.push(p);
        live.add(p);
      }
    },
    off: () => { for (const p of loaders.splice(0)) kill(p); },
  };
}
