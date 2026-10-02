// CPU load for delivery tests and soaks: busy `yes` processes that compete
// with the pane under test for the scheduler, the condition a paste splits or
// stalls under (typed-delivery-soak.ts, daemon.inject-cross-user-paste.e2e).
//
// `yes` is spawned directly, never through a shell: killing `sh -c "yes"`
// leaves `yes` running under launchd, and 88 of them starved the machine on
// 2026-09-20. Each runs in its own process group so the kill reaches it even
// if bun's handle is gone, and process exit runs the same cleanup.
import { spawn, type ChildProcess } from "node:child_process";

export type CpuLoad = { on(n: number): void; off(): void };

export function cpuLoad(): CpuLoad {
  const loaders: ChildProcess[] = [];
  const off = () => {
    for (const p of loaders.splice(0)) {
      if (p.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } }
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
    }
  };
  process.on("exit", off);
  return {
    on: (n) => { for (let i = 0; i < n; i++) loaders.push(spawn("yes", [], { stdio: "ignore", detached: true })); },
    off,
  };
}
