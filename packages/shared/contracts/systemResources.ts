export type ResourceKind = "agent" | "browser" | "simulator" | "tool" | "app" | "system";
export type ResourcePressure = "normal" | "elevated" | "critical" | "unknown";

export interface ResourceProcess {
  pid: number;
  ppid: number;
  startedAt?: number;
  name: string;
  kind: ResourceKind;
  cpu: number;
  rss: number;
  sessionId?: string;
  sharedSessionIds?: string[];
}

export interface ResourcePoint {
  at: number;
  cpuPercent?: number;
  memoryTotal: number;
  memoryAvailable: number;
  memoryAvailableIsEstimate: boolean;
  compressedBytes?: number;
  swapUsedBytes?: number;
  pressure: ResourcePressure;
  load1: number;
  logicalCpus: number;
  processCount: number;
  threadCount?: number;
  diskReadBytesPerSecond?: number;
  diskWriteBytesPerSecond?: number;
  networkReceivedBytesPerSecond?: number;
  networkSentBytesPerSecond?: number;
}

export interface ResourceGroup {
  kind: ResourceKind;
  cpu: number;
  rss: number;
  processCount: number;
}

export interface MachineResourceSnapshot {
  version: 1;
  deviceId: string;
  platform: string;
  sample: ResourcePoint;
  processes: ResourceProcess[];
  groups: ResourceGroup[];
  omittedProcessCount: number;
  collectionDurationMs: number;
  limitations: string[];
}

export const RESOURCE_PROCESS_LIMIT = 256;
export const RESOURCE_HISTORY_LIMIT = 120;
export const RESOURCE_STALE_MS = 120_000;

export interface ResourceIncident {
  level: "elevated" | "critical";
  since: number;
  reason: string;
}

export function sustainedResourcePressure(points: ResourcePoint[], now: number): ResourceIncident | null {
  const recent = points.filter(p => p.at <= now && now - p.at <= 180_000).sort((a, b) => a.at - b.at);
  if (recent.length < 3 || now - recent[recent.length - 1].at > RESOURCE_STALE_MS) return null;
  const reason = (p: ResourcePoint): string | null => {
    if (p.pressure === "critical") return "The operating system reports critical memory pressure";
    if (p.pressure === "elevated") return "The operating system reports elevated memory pressure";
    if ((p.cpuPercent ?? 0) >= 90) return "CPU use has stayed above 90%";
    if (p.load1 / Math.max(p.logicalCpus, 1) >= 3) return "The runnable work queue has stayed high; CPU saturation is not established";
    return null;
  };
  let start = recent.length - 1;
  while (start >= 0 && reason(recent[start])) start--;
  const sustained = recent.slice(start + 1);
  if (sustained.length < 3 || sustained[sustained.length - 1].at - sustained[0].at < 60_000) return null;
  return { level: sustained.every(p => p.pressure === "critical") ? "critical" : "elevated", since: sustained[0].at, reason: reason(sustained[sustained.length - 1])! };
}
