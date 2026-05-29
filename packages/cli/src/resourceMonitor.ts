import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  cpu: number;
  rss: number;
}

export interface SessionResources {
  sessionId: string;
  cpu: number;
  memory: number;
  pidCount: number;
  collectedAt: number;
}

// Below this CPU% (and not in a working status) a tick counts as idle.
export const IDLE_CPU_FLOOR_PCT = 2;
const WORKING_STATUSES = new Set(["working", "thinking", "compacting", "starting", "resuming"]);

// A session is "active" this tick if it's burning CPU or its agent_status is a
// working state. Single source of truth for both idle accounting and the metrics
// report gate, so the two never disagree about what counts as idle.
export function isSessionActive(cpu: number, status: string | undefined): boolean {
  return cpu >= IDLE_CPU_FLOOR_PCT || (status !== undefined && WORKING_STATUSES.has(status));
}

// Idle sessions' metrics are flat, but the old code reported every session every
// tick — one session_metrics insert (+ a cleanup scan) per session per 30s. With
// a fleet of ~100 mostly-idle sessions that burst saturates the daemon's socket
// pool and starves message-sync mutations (they hang to their 60s timeout). Cap
// how often an idle/unchanged session re-reports so per-tick write volume tracks
// the number of ACTIVE sessions, not the total.
export const IDLE_METRICS_REFRESH_MS = 3 * 60 * 1000;
const METRICS_MEM_DELTA_FRAC = 0.1; // a ≥10% memory move is worth reporting

export interface ReportedMetrics {
  cpu: number;
  memory: number;
  pidCount: number;
  agentPid?: number;
  at: number;
}

/**
 * Decide whether a metrics report is worth sending given the last one sent for
 * this session. Active sessions always report (full-fidelity graphs); idle ones
 * report only on a meaningful change (cpu, pid count, process-tree shape, a
 * memory swing, or an agent_pid change the server's snapshot patch needs) or a
 * slow keep-alive so the graph/liveness never goes stale.
 */
export function shouldReportMetrics(args: {
  cur: { cpu: number; memory: number; pidCount: number; agentPid?: number };
  prev: ReportedMetrics | undefined;
  status: string | undefined;
  now: number;
}): boolean {
  const { cur, prev, status, now } = args;
  if (!prev) return true; // never reported
  if (isSessionActive(cur.cpu, status)) return true; // working or burning CPU
  if (cur.agentPid !== prev.agentPid) return true; // feeds the server snapshot patch
  if (cur.pidCount !== prev.pidCount) return true; // process tree changed
  if (Math.abs(cur.memory - prev.memory) >= prev.memory * METRICS_MEM_DELTA_FRAC) return true;
  return now - prev.at >= IDLE_METRICS_REFRESH_MS; // otherwise a slow keep-alive
}

/**
 * Per-tick update of a session's awake-idle counter.
 *
 * Returns the new accumulated idle time. The counter measures idle time only
 * while the machine is AWAKE: a `sleepSkip` tick (first tick, wake grace, or an
 * oversized gap from suspend/stall) carries the previous value forward unchanged,
 * so a closed-lid period never inflates idle time. Any sign of activity — CPU at
 * or above the floor, or a working status — resets the counter to 0.
 */
export function nextAwakeIdleMs(params: {
  prevIdleMs: number;
  cpu: number;
  status: string | undefined;
  elapsedMs: number;
  sleepSkip: boolean;
}): number {
  if (isSessionActive(params.cpu, params.status)) return 0;
  if (params.sleepSkip) return params.prevIdleMs;
  return params.prevIdleMs + params.elapsedMs;
}

export async function captureProcessSnapshot(): Promise<Map<number, ProcessInfo>> {
  if (process.platform !== "darwin") return new Map();

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,pcpu=,rss="], {
    timeout: 5000,
    killSignal: "SIGKILL",
  });

  const result = new Map<number, ProcessInfo>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const cpu = parseFloat(parts[2]);
    const rss = parseInt(parts[3], 10);
    if (isNaN(pid) || isNaN(ppid) || isNaN(cpu) || isNaN(rss)) continue;
    result.set(pid, { pid, ppid, cpu, rss: rss * 1024 });
  }
  return result;
}

export function getSubtreePids(
  snapshot: Map<number, ProcessInfo>,
  rootPid: number,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const info of snapshot.values()) {
    let children = childrenOf.get(info.ppid);
    if (!children) {
      children = [];
      childrenOf.set(info.ppid, children);
    }
    children.push(info.pid);
  }

  const result: number[] = [];
  const stack = [rootPid];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    result.push(pid);
    const children = childrenOf.get(pid);
    if (children) {
      for (const child of children) stack.push(child);
    }
  }
  return result;
}

export function getSubtreeResources(
  snapshot: Map<number, ProcessInfo>,
  rootPid: number,
): { cpu: number; memory: number; pidCount: number } {
  const pids = getSubtreePids(snapshot, rootPid);
  let cpu = 0;
  let memory = 0;
  let pidCount = 0;
  for (const pid of pids) {
    const info = snapshot.get(pid);
    if (!info) continue;
    cpu += info.cpu;
    memory += info.rss;
    pidCount++;
  }
  return { cpu: Math.round(cpu * 100) / 100, memory, pidCount };
}

export async function collectSessionResources(
  sessionPids: Map<string, number>,
): Promise<Map<string, SessionResources>> {
  if (process.platform !== "darwin") return new Map();

  const snapshot = await captureProcessSnapshot();
  if (snapshot.size === 0) return new Map();

  const result = new Map<string, SessionResources>();
  const now = Date.now();
  for (const [sessionId, rootPid] of sessionPids) {
    if (!snapshot.has(rootPid)) continue;
    const resources = getSubtreeResources(snapshot, rootPid);
    if (resources.pidCount === 0) continue;
    result.set(sessionId, {
      sessionId,
      ...resources,
      collectedAt: now,
    });
  }
  return result;
}

export function formatResourcesLog(resources: Map<string, SessionResources>): string {
  if (resources.size === 0) return "No active sessions with resource data";
  const lines: string[] = [];
  for (const [sessionId, r] of resources) {
    const memMB = (r.memory / (1024 * 1024)).toFixed(1);
    lines.push(`${sessionId.slice(0, 8)}: cpu=${r.cpu}% mem=${memMB}MB procs=${r.pidCount}`);
  }
  return `Resource snapshot (${resources.size} sessions): ${lines.join(", ")}`;
}
