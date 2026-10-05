// Replaces a wedged dev server with a fresh one. See stallWatchdog.ts.
import { workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import fs from "node:fs";

const { beat, stallSeconds, checkMs, execPath, execArgv, argv, cwd, respawns } = workerData;
const heartbeat = new Int32Array(beat);
const nowSec = () => Math.floor(Date.now() / 1000);

// The main thread is the one that is stuck, and a worker's console goes
// through it, so write straight to the process's stderr.
const say = (msg) => fs.writeSync(2, `[codecast-stall-watchdog] ${msg}\n`);

const timer = setInterval(() => {
  const silent = nowSec() - Atomics.load(heartbeat, 0);
  if (silent < stallSeconds) return;
  clearInterval(timer);
  say(`main thread silent for ${silent}s; replacing this dev server (pid ${process.pid}) with a fresh one`);
  // The replacement waits for this pid to exit so it can bind the same port,
  // then runs the exact same command. It stays in this process group so a
  // Ctrl-C in the launching terminal still stops it.
  spawn(
    "/bin/sh",
    ["-c", 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; exec "$@"', String(process.pid), execPath, ...execArgv, ...argv],
    {
      cwd,
      env: { ...process.env, CODECAST_VITE_RESPAWNS: String(respawns + 1) },
      stdio: ["ignore", "inherit", "inherit"],
    },
  ).unref();
  process.kill(process.pid, "SIGKILL");
}, checkMs);
