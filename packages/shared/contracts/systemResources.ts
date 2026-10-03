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
  processCount?: number;
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
  const recent = points.filter(p => p.at <= now && now - p.at <= 10 * 60_000).sort((a, b) => a.at - b.at);
  if (recent.length < 3 || now - recent[recent.length - 1].at > RESOURCE_STALE_MS) return null;
  const reason = (p: ResourcePoint): string | null => {
    if (p.pressure === "critical") return "The operating system reports critical memory pressure";
    if (p.pressure === "elevated") return "The operating system reports elevated memory pressure";
    if (!p.memoryAvailableIsEstimate && p.memoryTotal > 0 && p.memoryAvailable / p.memoryTotal < 0.1) return "Available memory has stayed below 10%";
    if ((p.cpuPercent ?? 0) >= 90) return "CPU use has stayed above 90%";
    if (p.load1 / Math.max(p.logicalCpus, 1) >= 3) return "System load has stayed high; load alone does not establish CPU saturation";
    return null;
  };
  let incident: ResourceIncident | null = null;
  let high: ResourcePoint[] = [], recovery: ResourcePoint[] = [];
  let previous: ResourcePoint | undefined;
  for (const point of recent) {
    if (previous && point.at - previous.at > 90_000) { incident = null; high = []; recovery = []; }
    previous = point;
    const why = reason(point);
    if (!incident) {
      high = why ? [...high, point] : [];
      if (high.length >= 3 && point.at - high[0].at >= 60_000) {
        incident = { level: high.every(p => p.pressure === "critical") ? "critical" : "elevated", since: high[0].at, reason: why! };
      }
      continue;
    }
    high = why ? [...high, point] : [];
    let criticalStart = high.length - 1;
    while (criticalStart >= 0 && high[criticalStart].pressure === "critical") criticalStart--;
    const critical = high.slice(criticalStart + 1);
    if (critical.length >= 3 && point.at - critical[0].at >= 60_000) incident = { ...incident, level: "critical", reason: why! };
    else if (why && incident.level !== "critical") incident = { ...incident, reason: why };
    const recovered = !why && point.cpuPercent !== undefined && point.cpuPercent < 75 && point.load1 / Math.max(point.logicalCpus, 1) < 2 && (point.memoryAvailableIsEstimate || point.memoryAvailable / Math.max(point.memoryTotal, 1) >= 0.15);
    recovery = recovered ? [...recovery, point] : [];
    if (recovery.length >= 3 && point.at - recovery[0].at >= 60_000) { incident = null; high = []; recovery = []; }
  }
  return incident;
}
