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
