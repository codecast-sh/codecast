import os from "node:os";
import { resourceProbe } from "./resourceProbe.js";
import { envSessionLookup, type EnvSession } from "./processEnv.js";
import fs from "node:fs/promises";
import { execFileAsync } from "./proc.js";
import type { ProcessInfo } from "./resourceMonitor.js";
import { RESOURCE_PROCESS_LIMIT, type MachineResourceSnapshot, type ResourceGroup, type ResourceKind, type ResourceProcess } from "@codecast/shared/contracts";

export function resourceKind(command: string): ResourceKind {
  const name = command.toLowerCase();
  if (/coresimulator|simulator|launchd_sim/.test(name)) return "simulator";
  if (/chrome|chromium|firefox|safari|webkit/.test(name)) return "browser";
  if (/claude|codex|opencode|gemini/.test(name)) return "agent";
  if (/\b(node|bun|tsc|vite|next-server|esbuild|cargo|rustc|swift|xcodebuild|python|pytest|uv)\b/.test(name)) return "tool";
  if (name.includes(".app/")) return "app";
  return "system";
}

/** Each process goes to the session whose agent it descends from; one outside
 *  every tree goes to the session its inherited environment names, as detached. */
export function attributeProcesses(snapshot: Map<number, ProcessInfo>, sessions: Map<string, number>, envSession?: (p: ProcessInfo) => EnvSession | undefined): ResourceProcess[] {
  const owners = new Map<number, string[]>();
  for (const [id, pid] of sessions) owners.set(pid, [...(owners.get(pid) ?? []), id].sort());
  return [...snapshot.values()].map(p => {
    let cursor: ProcessInfo | undefined = p;
    const seen = new Set<number>();
    let ids: string[] | undefined;
    let kind: ResourceKind = owners.has(p.pid) ? "agent" : resourceKind(p.command ?? "");
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      if (resourceKind(cursor.command ?? "") === "simulator") kind = "simulator";
      ids = owners.get(cursor.pid);
      if (ids) break;
      cursor = snapshot.get(cursor.ppid);
    }
    // An agent outside every tree is a session of its own, not the work of the session it was spawned from.
    const outside = !ids && kind !== "agent" ? envSession?.(p) : undefined;
    if (outside) ids = [outside.sessionId];
    return {
      pid: p.pid, ppid: p.ppid, name: (p.command?.split("/").pop() || "Unknown process").slice(0, 120),
      cpu: p.cpu, rss: p.rss, kind,
      ...(p.startedAt === undefined ? {} : { startedAt: p.startedAt }),
      ...(ids?.length === 1 ? { sessionId: ids[0] } : ids?.length && ids.length <= 32 ? { sharedSessionIds: ids } : {}),
      ...(outside ? { detached: outside.via } : {}),
    };
  });
}

/**
 * What a session started outside its agent's tree that is still running: what
 * a move stops beyond the agent itself. The session need not be live (its agent
 * is stopped before the move), and a process another live agent's tree holds
 * stays with that agent.
 */
export function processesStartedOutside(snapshot: Map<number, ProcessInfo>, sessions: Map<string, number>, sessionId: string, read?: Parameters<typeof envSessionLookup>[2], self?: number): ResourceProcess[] {
  // A live agent keeps its tree (that stops with the agent); a stopped one still names its outside work.
  const withTarget = sessions.has(sessionId) ? sessions : new Map(sessions).set(sessionId, -1);
  return attributeProcesses(snapshot, withTarget, envSessionLookup(snapshot, withTarget, read, self, Infinity)).filter(p => p.sessionId === sessionId && p.detached);
}

export function summarizeProcesses(rows: ResourceProcess[]) {
  const grouped = new Map<ResourceKind, ResourceGroup>();
  for (const p of rows) {
    const g = grouped.get(p.kind) ?? { kind: p.kind, cpu: 0, rss: 0, processCount: 0 };
    g.cpu += p.cpu; g.rss += p.rss; g.processCount++;
    grouped.set(p.kind, g);
  }
  return { groups: [...grouped.values()], processes: listedProcesses(rows), omittedProcessCount: Math.max(0, rows.length - RESOURCE_PROCESS_LIMIT) };
}

/** The processes the snapshot names, within RESOURCE_PROCESS_LIMIT: the ones
 *  ranking highest by either CPU or memory, so a busy small process is named as
 *  readily as a large idle one. */
export function listedProcesses(rows: ResourceProcess[]): ResourceProcess[] {
  const rank = new Map<ResourceProcess, number>();
  [...rows].sort((a, b) => b.cpu - a.cpu || a.pid - b.pid).forEach((p, i) => rank.set(p, i));
  [...rows].sort((a, b) => b.rss - a.rss || a.pid - b.pid).forEach((p, i) => rank.set(p, Math.min(rank.get(p)!, i)));
  return [...rows]
    .sort((a, b) => rank.get(a)! - rank.get(b)! || a.pid - b.pid)
    .slice(0, RESOURCE_PROCESS_LIMIT)
    .sort((a, b) => b.rss - a.rss || a.pid - b.pid);
}

export function parseMacMemory(vm: string, swap: string, pressure: string, total: number) {
  const size = Number(vm.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (label: string) => Number(vm.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"))?.[1]);
  const free = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
  const compressed = pages("Pages occupied by compressor");
  const used = swap.match(/used\s*=\s*([\d.]+)([MG])/);
  const level = Number(pressure.trim().split(/\s+/).pop());
  return {
    ...(size > 0 && Number.isFinite(free) ? { memoryAvailable: Math.min(total, free * size) } : {}),
    ...(size > 0 && Number.isFinite(compressed) ? { compressedBytes: compressed * size } : {}),
    ...(used ? { swapUsedBytes: Number(used[1]) * (used[2] === "G" ? 1024 ** 3 : 1024 ** 2) } : {}),
    pressure: level === 1 ? "normal" as const : level === 2 ? "elevated" as const : level === 4 ? "critical" as const : "unknown" as const,
  };
}

export function parseLinuxMemory(text: string) {
  const kb = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1]) * 1024;
  const available = kb("MemAvailable"), swap = kb("SwapTotal") - kb("SwapFree");
  return {
    ...(Number.isFinite(available) ? { memoryAvailable: available } : {}),
    ...(Number.isFinite(swap) ? { swapUsedBytes: swap } : {}),
  };
}

let previousCpu: { idle: number; total: number } | undefined;
type IoCounters = { diskRead?: number; diskWrite?: number; received?: number; sent?: number };
let previousIo: { at: number; counters: IoCounters } | undefined;

export function parseMacIo(disk: string, network: string): IoCounters {
  const counters: IoCounters = {};
  const stats = disk.split("\n").filter(l => l.includes('"Statistics" ='));
  if (stats.length) {
    counters.diskRead = stats.reduce((n, line) => n + Number(line.match(/"Bytes \(Read\)"=(\d+)/)?.[1] ?? 0), 0);
    counters.diskWrite = stats.reduce((n, line) => n + Number(line.match(/"Bytes \(Write\)"=(\d+)/)?.[1] ?? 0), 0);
  }
  const interfaces = new Set<string>();
  for (const line of network.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (!/^en\d+\*?$/.test(p[0]) || !p[2]?.startsWith("<Link#") || interfaces.has(p[0]) || p.length < 10) continue;
    const received = Number(p[p.length - 5]), sent = Number(p[p.length - 2]);
    if (!Number.isFinite(received) || !Number.isFinite(sent)) continue;
    interfaces.add(p[0]);
    counters.received = (counters.received ?? 0) + received;
    counters.sent = (counters.sent ?? 0) + sent;
  }
  return counters;
}

export function parseLinuxIo(disk: string, network: string): IoCounters {
  const counters: IoCounters = {};
  for (const line of disk.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(p[2] ?? "") || p.length < 10) continue;
    counters.diskRead = (counters.diskRead ?? 0) + Number(p[5]) * 512;
    counters.diskWrite = (counters.diskWrite ?? 0) + Number(p[9]) * 512;
  }
  for (const line of network.split("\n")) {
    const [name, rest] = line.split(":");
    if (!/^(eth\d+|en\w+|wl\w+)$/.test(name.trim()) || !rest) continue;
    const p = rest.trim().split(/\s+/);
    if (p.length < 9) continue;
    counters.received = (counters.received ?? 0) + Number(p[0]);
    counters.sent = (counters.sent ?? 0) + Number(p[8]);
  }
  return counters;
}

export function ioRates(before: IoCounters, after: IoCounters, elapsedMs: number) {
  const names = { diskRead: "diskReadBytesPerSecond", diskWrite: "diskWriteBytesPerSecond", received: "networkReceivedBytesPerSecond", sent: "networkSentBytesPerSecond" } as const;
  const result: Partial<Record<typeof names[keyof typeof names], number>> = {};
  if (elapsedMs <= 0 || elapsedMs > 120_000) return result;
  for (const key of Object.keys(names) as Array<keyof IoCounters>) {
    const a = before[key], b = after[key];
    if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) && b >= a) result[names[key]] = Math.round((b - a) * 1000 / elapsedMs);
  }
  return result;
}

async function readIo(): Promise<IoCounters> {
  if (process.platform === "linux") {
    const [disk, net] = await Promise.all([resourceProbe("diskstats", () => fs.readFile("/proc/diskstats", "utf8"), 3000).then(s => s ?? ""), resourceProbe("netdev", () => fs.readFile("/proc/net/dev", "utf8"), 3000).then(s => s ?? "")]);
    return parseLinuxIo(disk, net);
  }
  if (process.platform === "darwin") {
    const run = (name: string, args: string[]) => resourceProbe(name, () => execFileAsync(name, args, { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 }), 3000).then(r => r?.stdout ?? "");
    const [disk, net] = await Promise.all([run("ioreg", ["-r", "-c", "IOBlockStorageDriver", "-d", "1", "-l"]), run("netstat", ["-ibn"])]);
    return parseMacIo(disk, net);
  }
  return {};
}

function cpuPercent(): number | undefined {
  const value = os.cpus().reduce((sum, c) => ({ idle: sum.idle + c.times.idle, total: sum.total + Object.values(c.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
  const old = previousCpu;
  previousCpu = value;
  const total = old ? value.total - old.total : 0;
  return old && total > 0 ? Math.round(Math.max(0, Math.min(100, 100 * (1 - (value.idle - old.idle) / total)))) : undefined;
}

async function readMemory(total: number) {
  if (process.platform === "linux") {
    const text = await resourceProbe("meminfo", () => fs.readFile("/proc/meminfo", "utf8"), 3000).then(s => s ?? "");
    return { ...parseLinuxMemory(text), pressure: "unknown" as const };
  }
  if (process.platform === "darwin") {
    const run = (name: string, args: string[]) => resourceProbe(name, () => execFileAsync(name, args, { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }), 3000).then(r => r?.stdout ?? "");
    const [vm, sys] = await Promise.all([run("vm_stat", []), run("sysctl", ["vm.swapusage", "kern.memorystatus_vm_pressure_level"])]);
    return parseMacMemory(vm, sys, sys.split("\n").find(l => l.startsWith("kern.memorystatus")) ?? "", total);
  }
  return { pressure: "unknown" as const };
}

export async function collectMachineResources(deviceId: string, snapshot: Map<number, ProcessInfo> | undefined, sessions: Map<string, number>): Promise<MachineResourceSnapshot> {
  const start = Date.now();
  const memoryTotal = os.totalmem();
  const memory = await readMemory(memoryTotal);
  const cpu = cpuPercent();
  const counters = await readIo();
  const ioAt = Date.now();
  const rates = previousIo ? ioRates(previousIo.counters, counters, ioAt - previousIo.at) : {};
  previousIo = { at: ioAt, counters };
  return {
    version: 1, deviceId, platform: process.platform,
    sample: {
      at: start, memoryTotal, memoryAvailable: os.freemem(), memoryAvailableIsEstimate: process.platform !== "linux" || !("memoryAvailable" in memory),
      load1: os.loadavg()[0], logicalCpus: os.cpus().length, ...(snapshot ? { processCount: snapshot.size } : {}),
      ...(cpu === undefined ? {} : { cpuPercent: cpu }), ...memory, ...rates,
    },
    ...summarizeProcesses(attributeProcesses(snapshot ?? new Map(), sessions, snapshot && envSessionLookup(snapshot, sessions))),
    collectionDurationMs: Date.now() - start,
    limitations: [...(snapshot ? [] : ["Process capture failed or timed out; process totals and session attribution are unavailable."]), "Process RSS includes shared pages and is not reclaimable memory.", "Shared and detached services may remain after a session moves.", "Network totals cover physical Ethernet/Wi-Fi interfaces; loopback and tunnels are excluded.", "Disk rates cover block devices, including disk images on Mac; they are not per-session I/O.", "Thread counts are not collected by this adapter.", "Processes with more than 32 session owners are left unattributed.", ...(process.platform === "linux" ? ["Process CPU is the ps lifetime average; machine CPU uses the interval between samples."] : [])],
  };
}
