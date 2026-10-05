import { Worker } from "node:worker_threads";
import type { Plugin } from "vite";

/**
 * Replaces the dev server with a fresh copy when its main thread stops running.
 *
 * Sessions launch Vite in many ways (dev.sh, a tmux pane, `vite | tee`), and
 * only dev.sh watched it. A wedged server otherwise holds every page on a
 * spinner until someone notices and restarts it by hand, and every session
 * that loads the app waits behind it.
 *
 * The main thread stamps a shared heartbeat once a second. A worker thread,
 * which keeps running when the main thread does not, checks the stamp; when it
 * has been stale for `stallSeconds` the worker starts the same command again,
 * waiting for this process to exit, and kills this process. Nothing in the
 * main thread is trusted to help, because it is the part that is stuck.
 */

const WORKER_URL = new URL("./stallWatchdog.worker.mjs", import.meta.url);

export interface StallWatchdogOptions {
  /** Seconds without a heartbeat before the server is replaced. */
  stallSeconds?: number;
  /** How often the watchdog checks, in ms. */
  checkMs?: number;
}

export function stallWatchdogPlugin({ stallSeconds, checkMs = 5000 }: StallWatchdogOptions = {}): Plugin {
  return {
    name: "codecast-stall-watchdog",
    apply: "serve",
    configureServer(server) {
      // A middleware-mode server belongs to a host process we must not kill.
      if (!server.httpServer || process.env.CODECAST_VITE_WATCHDOG === "0") return;
      const beat = new SharedArrayBuffer(4);
      const heartbeat = new Int32Array(beat);
      const stamp = () => Atomics.store(heartbeat, 0, Math.floor(Date.now() / 1000));
      stamp();
      const pulse = setInterval(stamp, 1000);
      pulse.unref();

      const respawns = Number(process.env.CODECAST_VITE_RESPAWNS || 0);
      const worker = new Worker(WORKER_URL, {
        workerData: {
          beat,
          stallSeconds: stallSeconds ?? Number(process.env.CODECAST_VITE_STALL_SECONDS || 60),
          checkMs,
          execPath: process.execPath,
          execArgv: process.execArgv.filter((a) => !a.startsWith("--inspect")),
          argv: process.argv.slice(1),
          cwd: process.cwd(),
          respawns,
        },
      });
      worker.unref();

      if (respawns > 0) {
        server.config.logger.warn(`[codecast-stall-watchdog] started as replacement #${respawns} for a wedged dev server`, {
          timestamp: true,
        });
      }

      // A server.restart() closes this server and runs configureServer again.
      server.httpServer.once("close", () => {
        clearInterval(pulse);
        void worker.terminate();
      });
    },
  };
}
