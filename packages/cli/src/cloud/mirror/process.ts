import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { agentSpawnPath } from "../../agentSpawnPath.js";

export interface MirrorProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  started: string;
}

interface MirrorProcessAllocation {
  child: ChildProcess;
  closed: boolean;
  known: Map<number, MirrorProcessIdentity>;
  ready: Promise<void>;
  cleanup?: Promise<void>;
}

export function mirrorProcessSnapshot(timeoutMs: number, pid?: number): Promise<MirrorProcessIdentity[]> {
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", [...(pid ? ["-p", String(pid)] : ["-ax"]), "-o", "pid=,ppid=,pgid=,uid=,lstart="], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, out) => {
      if (error) { reject(error); return; }
      const rows: MirrorProcessIdentity[] = [];
      for (const line of out.split("\n").filter((s) => s.trim())) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) { reject(new Error("cannot parse mirror process identity")); return; }
        rows.push({ pid: +match[1]!, ppid: +match[2]!, pgid: +match[3]!, uid: +match[4]!, started: match[5]! });
      }
      resolve(rows);
    });
  });
}

export function sameMirrorProcess(a: MirrorProcessIdentity, b: MirrorProcessIdentity): boolean {
  return a.pid === b.pid && a.pgid === b.pgid && a.uid === b.uid && a.started === b.started;
}

export function mirrorProcessInvocation(execPath = process.execPath, entry = process.argv[1] ?? ""): { command: string; args: string[] } {
  const fromSource = /\.(?:[cm]?js|ts)$/.test(entry) && !entry.startsWith("/$bunfs/") && !entry.includes("~BUN/");
  const args = fromSource ? [path.join(path.dirname(entry), entry.endsWith(".ts") ? "main.ts" : "main.js")] : [];
  return { command: execPath, args: [...args, "cloud", "mirror-run"] };
}

export function startMirrorProcess(opts: {
  shouldRun: () => boolean;
  log: (message: string) => void;
  delayMs?: number;
  retryMs?: number;
  stopTimeoutMs?: number;
  invocation?: { command: string; args: string[] };
  snapshot?: typeof mirrorProcessSnapshot;
  spawnChild?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
}): { stop: () => Promise<void>; settled: () => Promise<void> } {
  const snapshot = opts.snapshot ?? mirrorProcessSnapshot;
  const budget = opts.stopTimeoutMs ?? 2_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let active: MirrorProcessAllocation | undefined;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void attempt(); }, delay);
    timer.unref();
  };
  const cleanup = (allocation: MirrorProcessAllocation): Promise<void> => {
    if (allocation.cleanup) return allocation.cleanup;
    const deadline = performance.now() + budget;
    let expiry: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => { expiry = setTimeout(() => reject(new Error("mirror cleanup timed out; child close or process-group retirement unconfirmed")), budget); });
    const retire = async () => {
      await allocation.ready;
      const pid = allocation.child.pid;
      let termSent = false;
      while (performance.now() < deadline) {
        if (!pid) {
          if (allocation.closed) return;
        } else {
          const rows = await snapshot(Math.max(1, Math.ceil(deadline - performance.now())));
          if (performance.now() >= deadline) throw new Error("mirror cleanup deadline elapsed during identity probe");
          const group = rows.filter((row) => row.pgid === pid);
          if (!group.length && allocation.closed) return;
          if (group.length) {
            const leader = group.find((row) => row.pid === pid);
            const acquired = allocation.known.get(pid);
            const leaderLive = allocation.child.exitCode === null && allocation.child.signalCode === null;
            if (leaderLive && leader && acquired && sameMirrorProcess(leader, acquired)) {
              for (const row of group) allocation.known.set(row.pid, row);
            }
            if (group.some((row) => !allocation.known.has(row.pid) || !sameMirrorProcess(row, allocation.known.get(row.pid)!))) throw new Error(`mirror group ${pid} identity unknown or replaced; cleanup refused`);
            if (!termSent || deadline - performance.now() <= budget / 2 || allocation.closed) {
              const signal = !termSent && leaderLive ? "SIGTERM" : "SIGKILL";
              try { process.kill(-pid, signal); } catch (err) {
                if (!["ESRCH", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
              }
              termSent = true;
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("mirror cleanup timed out; process-group retirement unconfirmed");
    };
    allocation.cleanup = Promise.race([retire(), expired]).finally(() => clearTimeout(expiry));
    return allocation.cleanup;
  };
  const attempt = async () => {
    if (stopped) return;
    try {
      if (active) { await cleanup(active); active = undefined; }
      if (stopped || !opts.shouldRun()) { schedule(opts.retryMs ?? 60_000); return; }
      const invocation = opts.invocation ?? mirrorProcessInvocation();
      const child = (opts.spawnChild ?? spawn)(invocation.command, invocation.args, {
        detached: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: agentSpawnPath(), CODECAST_NO_AUTO_UPDATE: "1", CODECAST_MIRROR_SUPERVISED: "1" },
      });
      const allocation: MirrorProcessAllocation = { child, closed: false, known: new Map<number, MirrorProcessIdentity>(), ready: Promise.resolve() };
      active = allocation;
      child.stdin?.on("error", () => {});
      child.stdout?.on("data", (bytes) => opts.log(String(bytes).trimEnd()));
      child.stderr?.on("data", (bytes) => opts.log(String(bytes).trimEnd()));
      child.on("error", (error) => opts.log(`mirror process failed: ${error.message}`));
      allocation.ready = snapshot(1_000).then((rows) => {
        const leader = rows.find((row) => row.pid === child.pid && row.ppid === process.pid && row.pgid === child.pid && row.uid === process.getuid?.());
        if (leader) for (const row of rows) if (row.pgid === leader.pgid) allocation.known.set(row.pid, row);
      }).catch((error) => opts.log(`mirror identity acquisition failed: ${error.message}`));
      child.once("close", (code, signal) => {
        allocation.closed = true;
        if (!stopped) {
          opts.log(`mirror process exited (${signal ?? code})`);
          schedule(opts.retryMs ?? 60_000);
        }
      });
    } catch (error) {
      opts.log(`mirror process unavailable: ${error instanceof Error ? error.message : String(error)}`);
      if (!stopped && active) active.cleanup = undefined;
      schedule(opts.retryMs ?? 60_000);
    }
  };
  schedule(opts.delayMs ?? 64_000);
  return {
    settled: () => active?.cleanup ?? active?.ready ?? Promise.resolve(),
    stop: () => {
      if (stopping) return stopping;
      stopped = true;
      clearTimeout(timer);
      return stopping = active ? cleanup(active) : Promise.resolve();
    },
  };
}

export function watchMirrorParent(stop: () => Promise<void>, log: (message: string) => void, timeoutMs = 2_000): () => void {
  if (process.env.CODECAST_MIRROR_SUPERVISED !== "1") return () => {};
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  let lost = false;
  const retire = async () => {
    const rows = await mirrorProcessSnapshot(500, process.pid);
    const own = rows.find((row) => row.pid === process.pid && row.pgid === process.pid && row.uid === process.getuid?.());
    if (!own) throw new Error("mirror parent lost; own process group identity unknown");
    process.kill(-process.pid, "SIGKILL");
  };
  const parentLost = () => {
    if (lost) return;
    lost = true;
    log("mirror supervisor pipe closed; retiring sender and descendants");
    const timeout = setTimeout(() => { void retire().catch((error) => { log(error.message); process.exitCode = 1; }); }, timeoutMs);
    void stop().catch((error) => { log(error.message); }).then(retire).catch((error) => { log(error.message); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
  };
  process.stdin.once("end", parentLost);
  process.stdin.once("close", parentLost);
  process.stdin.resume();
  return () => {
    process.stdin.removeListener("end", parentLost);
    process.stdin.removeListener("close", parentLost);
    process.stdin.pause();
  };
}
