import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

export function mirrorProcessInvocation(execPath = process.execPath, entry = process.argv[1] ?? ""): { command: string; args: string[] } {
  const fromSource = /\.(?:[cm]?js|ts)$/.test(entry) && !entry.startsWith("/$bunfs/") && !entry.includes("~BUN/");
  const args = fromSource ? [path.join(path.dirname(entry), entry.endsWith(".ts") ? "main.ts" : "main.js")] : [];
  return { command: execPath, args: [...args, "cloud", "mirror-run"] };
}

export function startMirrorProcess(opts: {
  shouldRun: () => boolean;
  log: (message: string) => void;
  delayMs?: number;
  stopTimeoutMs?: number;
  invocation?: { command: string; args: string[] };
}): { stop: () => Promise<void>; settled: () => Promise<void> } {
  let child: ChildProcess | undefined;
  let closed = Promise.resolve();
  let stopped = false;
  let deadline = Infinity;
  const killGroup = (pid: number | undefined) => {
    if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") child?.kill("SIGKILL");
    }
  };
  const joinGroup = async (pid: number | undefined) => {
    if (!pid) return;
    killGroup(pid);
    const until = Math.min(deadline, Date.now() + (opts.stopTimeoutMs ?? 2_000));
    for (;;) {
      try { process.kill(-pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        throw err;
      }
      if (Date.now() >= until) throw new Error(`mirror process group ${pid} did not exit`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const timer = setTimeout(() => {
    if (stopped || !opts.shouldRun()) return;
    const invocation = opts.invocation ?? mirrorProcessInvocation();
    child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout?.on("data", (bytes) => opts.log(String(bytes).trimEnd()));
    child.stderr?.on("data", (bytes) => opts.log(String(bytes).trimEnd()));
    child.on("error", (error) => opts.log(`mirror process failed: ${error.message}`));
    const pid = child.pid;
    child.once("exit", () => killGroup(pid));
    closed = new Promise<void>((resolve) => child!.once("close", (code, signal) => {
      if (!stopped) opts.log(`mirror process exited (${signal ?? code})`);
      resolve();
    })).then(() => joinGroup(pid));
    void closed.catch((error) => opts.log(`mirror cleanup failed: ${error.message}`));
  }, opts.delayMs ?? 64_000);
  timer.unref();
  return {
    settled: () => closed,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      deadline = Date.now() + (opts.stopTimeoutMs ?? 2_000);
      if (!child || child.exitCode !== null || child.signalCode !== null) return closed;
      const pid = child.pid;
      child.kill("SIGTERM");
      const kill = setTimeout(() => {
        killGroup(pid);
      }, (opts.stopTimeoutMs ?? 2_000) / 2);
      return closed.finally(() => clearTimeout(kill));
    },
  };
}
