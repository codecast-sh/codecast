// SAMPLE DATA for the resource monitor preview (_resources.html). Shaped like
// the Oct 3 investigation (a 16-core, 128 GB laptop under heavy load, two
// simulator trees, dozens of agent processes) but every value, title and id
// here is invented. Nothing in this file reflects or touches a real machine.
import type { MachineResourceSnapshot, ResourceKind, ResourcePoint, ResourceProcess } from "@codecast/shared/contracts";
import type { OffloadPlan, OffloadRun, ResourceMachine, ResourceSession } from "./types";
import { buildOffloadPlan, type OffloadDeviceEvidence } from "../../lib/resourceOffload";
import type { MigrationCandidate } from "../../lib/migrationPlan";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function history(now: number, base: Partial<ResourcePoint> & { memoryTotal: number; logicalCpus: number }, opts: { cpu: [number, number]; used: [number, number]; load: [number, number]; pressureFrom?: number; criticalFrom?: number; seed: number; points?: number }): ResourcePoint[] {
  const r = rng(opts.seed);
  const n = opts.points ?? 120;
  const out: ResourcePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const at = now - (n - 1 - i) * 30_000;
    const cpu = opts.cpu[0] + (opts.cpu[1] - opts.cpu[0]) * t ** 1.6 + (r() - 0.5) * 8;
    const used = opts.used[0] + (opts.used[1] - opts.used[0]) * t ** 1.4 + (r() - 0.5) * 2;
    const load = opts.load[0] + (opts.load[1] - opts.load[0]) * t ** 1.5 + (r() - 0.5) * 20;
    const pressure = opts.criticalFrom !== undefined && i >= opts.criticalFrom ? "critical" : opts.pressureFrom !== undefined && i >= opts.pressureFrom ? "elevated" : "normal";
    out.push({
      ...base,
      at,
      cpuPercent: Math.max(0, Math.min(100, cpu)),
      memoryTotal: base.memoryTotal,
      memoryAvailable: Math.max(0, base.memoryTotal - (used / 100) * base.memoryTotal),
      memoryAvailableIsEstimate: false,
      compressedBytes: base.compressedBytes !== undefined ? base.compressedBytes * (0.4 + 0.6 * t) : undefined,
      swapUsedBytes: base.swapUsedBytes,
      pressure,
      load1: Math.max(0, load),
      logicalCpus: base.logicalCpus,
      processCount: Math.round((base.processCount ?? 1500) * (0.85 + 0.15 * t)),
      threadCount: base.threadCount !== undefined ? Math.round(base.threadCount * (0.8 + 0.2 * t)) : undefined,
      diskReadBytesPerSecond: base.diskReadBytesPerSecond !== undefined ? base.diskReadBytesPerSecond * (0.5 + r()) : undefined,
      diskWriteBytesPerSecond: base.diskWriteBytesPerSecond !== undefined ? base.diskWriteBytesPerSecond * (0.5 + r()) : undefined,
      networkReceivedBytesPerSecond: base.networkReceivedBytesPerSecond !== undefined ? base.networkReceivedBytesPerSecond * (0.5 + r()) : undefined,
      networkSentBytesPerSecond: base.networkSentBytesPerSecond !== undefined ? base.networkSentBytesPerSecond * (0.5 + r()) : undefined,
    });
  }
  return out;
}

let pid = 40000;
const proc = (name: string, kind: ResourceKind, cpu: number, rssMb: number, sessionId?: string, shared?: string[], startedMinAgo = 90): ResourceProcess => ({
  pid: pid++, ppid: 1, name, kind, cpu, rss: rssMb * MB, sessionId, sharedSessionIds: shared, startedAt: Date.now() - startedMinAgo * 60_000,
});

export const SAMPLE_SESSIONS: ResourceSession[] = [
  { sessionId: "ms-ios", conversationId: "conv-ios", shortId: "jx7a1c2", title: "Fix share sheet crash on iOS 19 simulator", projectPath: "/Users/sample/src/mobile-app", agentType: "claude_code", deviceId: "dev-laptop", state: "working", lastActiveAt: Date.now() - 40_000 },
  { sessionId: "ms-sync", conversationId: "conv-sync", shortId: "jx7b3d4", title: "Sync engine: delta channel soak test", projectPath: "/Users/sample/src/platform", agentType: "claude_code", deviceId: "dev-laptop", state: "working", lastActiveAt: Date.now() - 15_000 },
  { sessionId: "ms-docs", conversationId: "conv-docs", shortId: "jx7c5e6", title: "Rewrite onboarding docs for the CLI", projectPath: "/Users/sample/src/platform", agentType: "claude_code", deviceId: "dev-laptop", state: "idle", lastActiveAt: Date.now() - 52 * 60_000 },
  { sessionId: "ms-perf", conversationId: "conv-perf", shortId: "jx7d7f8", title: "Profile inbox render under 400 sessions", projectPath: "/Users/sample/src/web-app", agentType: "claude_code", deviceId: "dev-laptop", state: "needs_input", lastActiveAt: Date.now() - 9 * 60_000 },
  { sessionId: "ms-migr", conversationId: "conv-migr", shortId: "jx7e9a0", title: "Postgres migration dry run for billing tables", projectPath: "/Users/sample/src/billing", agentType: "claude_code", deviceId: "dev-laptop", state: "idle", lastActiveAt: Date.now() - 3.2 * 3600_000 },
  { sessionId: "ms-e2e", conversationId: "conv-e2e", shortId: "jx7f1b2", title: "Playwright e2e for checkout flow", projectPath: "/Users/sample/src/web-app", agentType: "claude_code", deviceId: "dev-laptop", state: "working", lastActiveAt: Date.now() - 70_000 },
  { sessionId: "ms-codex", conversationId: "conv-codex", shortId: "jx7g3c4", title: "Refactor auth middleware", projectPath: "/Users/sample/src/platform", agentType: "codex", deviceId: "dev-laptop", state: "working", lastActiveAt: Date.now() - 4 * 60_000 },
  { sessionId: "ms-pinned", conversationId: "conv-pinned", shortId: "jx7h5d6", title: "Release checklist 1.4", projectPath: "/Users/sample/src/platform", agentType: "claude_code", deviceId: "dev-laptop", state: "idle", lastActiveAt: Date.now() - 6 * 3600_000, pinned: true },
  { sessionId: "ms-api", conversationId: "conv-api", shortId: "jx7k2a3", title: "Load-test the public API rate limiter", projectPath: "/Users/sample/src/platform", agentType: "claude_code", deviceId: "dev-laptop", state: "idle", lastActiveAt: Date.now() - 24 * 60_000 },
  { sessionId: "ms-cloud", conversationId: "conv-cloud", shortId: "jx7i7e8", title: "Nightly dependency upgrade sweep", projectPath: "/home/sample/src/platform", agentType: "claude_code", deviceId: "dev-linux", state: "working", lastActiveAt: Date.now() - 20_000 },
  { sessionId: "ms-hib", conversationId: "conv-hib", shortId: "jx7j9f0", title: "Investigate flaky webhook retries", projectPath: "/Users/sample/src/billing", agentType: "claude_code", deviceId: "dev-laptop", state: "hibernated", lastActiveAt: Date.now() - 11 * 3600_000 },
];

function laptopSnapshot(now: number, sample: ResourcePoint): MachineResourceSnapshot {
  pid = 40000;
  const processes: ResourceProcess[] = [
    proc("claude", "agent", 38, 610, "ms-ios"),
    proc("xcodebuild", "tool", 412, 3900, "ms-ios", undefined, 12),
    proc("Simulator", "simulator", 96, 2400, "ms-ios"),
    proc("launchd_sim", "simulator", 34, 5200, "ms-ios"),
    proc("claude", "agent", 22, 540, "ms-sync"),
    proc("bun test --watch", "tool", 188, 2100, "ms-sync", undefined, 30),
    proc("bun soak.ts", "tool", 240, 1700, "ms-sync", undefined, 25),
    proc("claude", "agent", 0.4, 420, "ms-docs"),
    proc("claude", "agent", 1.1, 480, "ms-perf"),
    proc("Google Chrome Helper (Renderer)", "browser", 61, 1900, "ms-perf"),
    proc("node vite", "tool", 18, 1300, "ms-perf"),
    proc("claude", "agent", 0.2, 390, "ms-migr"),
    proc("postgres", "tool", 3, 820, "ms-migr", undefined, 200),
    proc("claude", "agent", 15, 520, "ms-e2e"),
    proc("node playwright", "tool", 74, 980, "ms-e2e"),
    proc("Chromium (headless)", "browser", 120, 2600, "ms-e2e"),
    proc("codex", "agent", 30, 700, "ms-codex"),
    proc("claude", "agent", 0.1, 350, "ms-pinned"),
    // One watcher and one dev server serving several sessions: counted once.
    proc("tsc --watch", "tool", 96, 3400, undefined, ["ms-docs", "ms-codex"], 300),
    proc("claude", "agent", 0.3, 410, "ms-api"),
    proc("bun server.ts", "tool", 35, 1400, "ms-api"),
    proc("k6 run", "tool", 120, 900, "ms-api"),
    proc("node next dev :3200", "tool", 44, 2800, undefined, ["ms-perf", "ms-e2e"], 280),
    // Nobody's session started these.
    proc("Google Chrome", "browser", 28, 2300),
    proc("Google Chrome Helper (Renderer)", "browser", 140, 9800),
    proc("Slack Helper", "app", 9, 1200),
    proc("Docker VM", "app", 52, 8200),
    proc("WindowServer", "system", 31, 900),
    proc("kernel_task", "system", 64, 3100),
    proc("mds_stores", "system", 22, 600),
    proc("Simulator", "simulator", 40, 3100, undefined, undefined, 600),
  ];
  // The machine counted far more than the top list: every kind carries a tail.
  const tail: Record<ResourceKind, [number, number, number]> = {
    agent: [12, 9 * GB, 54], tool: [140, 11 * GB, 420], browser: [80, 14 * GB, 160],
    simulator: [30, 4 * GB, 210], app: [40, 6 * GB, 300], system: [120, 7 * GB, 640],
  };
  const groups = (Object.keys(tail) as ResourceKind[]).map((kind) => {
    const listed = processes.filter((p) => p.kind === kind);
    return {
      kind,
      cpu: listed.reduce((a, p) => a + p.cpu, 0) + tail[kind][0],
      rss: listed.reduce((a, p) => a + p.rss, 0) + tail[kind][1],
      processCount: listed.length + tail[kind][2],
    };
  });
  return {
    version: 1, deviceId: "dev-laptop", platform: "darwin", sample, processes, groups,
    omittedProcessCount: Object.values(tail).reduce((a, t) => a + t[2], 0),
    collectionDurationMs: 410,
    limitations: ["Resident memory includes pages shared between processes; it is not the memory a move would free."],
  };
}

function linuxSnapshot(sample: ResourcePoint): MachineResourceSnapshot {
  pid = 900;
  const processes = [
    proc("claude", "agent", 12, 480, "ms-cloud"),
    proc("npm install", "tool", 85, 900, "ms-cloud"),
    proc("codecast daemon", "system", 2, 160),
    proc("Xvfb", "system", 1, 120),
  ];
  return {
    version: 1, deviceId: "dev-linux", platform: "linux", sample, processes,
    groups: (["agent", "tool", "system"] as ResourceKind[]).map((kind) => {
      const l = processes.filter((p) => p.kind === kind);
      return { kind, cpu: l.reduce((a, p) => a + p.cpu, 0) + 4, rss: l.reduce((a, p) => a + p.rss, 0) + 600 * MB, processCount: l.length + 80 };
    }),
    omittedProcessCount: 240, collectionDurationMs: 60,
    limitations: ["Thread counts are not collected on this host yet."],
  };
}

export type Scenario = "pressure" | "calm" | "degraded" | "cold" | "empty" | "stale_offline" | "no_cloud" | "run_progress" | "run_failed";
export const SCENARIOS: Array<{ id: Scenario; label: string }> = [
  { id: "pressure", label: "Sustained pressure" },
  { id: "calm", label: "Healthy" },
  { id: "run_progress", label: "Offload in progress" },
  { id: "run_failed", label: "Offload with failure" },
  { id: "no_cloud", label: "No cloud host" },
  { id: "degraded", label: "Process list timed out" },
  { id: "stale_offline", label: "Stale and offline" },
  { id: "cold", label: "Waiting for first sample" },
  { id: "empty", label: "No machines" },
];

export type ScenarioData = {
  machines: ResourceMachine[];
  sessions: ResourceSession[];
  ready: boolean;
  plans: OffloadPlan[];
  runs: OffloadRun[];
};

export function buildScenario(id: Scenario, now: number): ScenarioData {
  if (id === "empty") return { machines: [], sessions: [], ready: true, plans: [], runs: [] };
  const hot = id !== "calm";
  const laptopHist = history(now, {
    memoryTotal: 128 * GB, logicalCpus: 16, processCount: 1900, threadCount: 11500, compressedBytes: 14 * GB, swapUsedBytes: 0,
    diskReadBytesPerSecond: 40 * MB, diskWriteBytesPerSecond: 22 * MB, networkReceivedBytesPerSecond: 3 * MB, networkSentBytesPerSecond: 1.2 * MB,
  }, hot
    ? { cpu: [38, 86], used: [62, 91], load: [120, 720], pressureFrom: 96, criticalFrom: 112, seed: 7 }
    : { cpu: [22, 31], used: [48, 52], load: [18, 30], seed: 7 });
  const linuxHist = history(now, { memoryTotal: 32 * GB, logicalCpus: 8, processCount: 320 }, { cpu: [8, 14], used: [18, 22], load: [1, 2], seed: 3 });
  const laptop: ResourceMachine = {
    deviceId: "dev-laptop", name: "MacBook Pro (sample)", role: "local", platform: "darwin", online: true,
    receivedAt: now - 8_000, history: laptopHist, snapshot: laptopSnapshot(now, laptopHist[laptopHist.length - 1]),
  };
  const linux: ResourceMachine = {
    deviceId: "dev-linux", name: "Cloud Linux (sample)", role: "cloud_linux", platform: "linux", online: true,
    receivedAt: now - 12_000, history: linuxHist, snapshot: linuxSnapshot(linuxHist[linuxHist.length - 1]),
  };
  const mac: ResourceMachine = { deviceId: "dev-cmac", name: "Cloud Mac (sample)", role: "cloud_mac", platform: "darwin", online: false, asleep: true, history: [] };
  const mini: ResourceMachine = {
    deviceId: "dev-mini", name: "Mac mini (sample)", role: "local", platform: "darwin", online: true,
    receivedAt: now - 9 * 60_000,
    history: history(now - 9 * 60_000, { memoryTotal: 32 * GB, logicalCpus: 10, processCount: 700 }, { cpu: [12, 18], used: [40, 44], load: [4, 6], seed: 11, points: 60 }),
  };
  mini.snapshot = { ...linuxSnapshot(mini.history[mini.history.length - 1]), deviceId: "dev-mini", platform: "darwin", processes: [], groups: [{ kind: "system", cpu: 140, rss: 13 * GB, processCount: 700 }], omittedProcessCount: 700 };
  const old: ResourceMachine = { deviceId: "dev-old", name: "Old iMac (sample)", role: "local", platform: "darwin", online: false, receivedAt: now - 3 * 86400_000, history: [] };

  if (id === "cold") {
    return { machines: [{ ...laptop, snapshot: undefined, receivedAt: undefined, history: [] }, { ...linux, snapshot: undefined, receivedAt: undefined, history: [] }], sessions: SAMPLE_SESSIONS, ready: true, plans: [], runs: [] };
  }
  if (id === "degraded") {
    // Vitals arrived; the process listing did not (ps timed out under load).
    const hist = laptopHist.map((q, i) => (i >= laptopHist.length - 6 ? { ...q, processCount: undefined, threadCount: undefined } : q));
    const sample = hist[hist.length - 1];
    return {
      machines: [{ ...laptop, history: hist, snapshot: { ...laptop.snapshot!, sample, processes: [], groups: [], omittedProcessCount: 0, limitations: ["Listing processes timed out after 5s; CPU, memory and load are still current."] } }, linux],
      sessions: SAMPLE_SESSIONS, ready: true, plans: [], runs: [],
    };
  }
  if (id === "stale_offline") {
    return { machines: [mini, old, { ...laptop, receivedAt: now - 6 * 60_000 }, linux], sessions: SAMPLE_SESSIONS, ready: true, plans: [], runs: [] };
  }
  const machines = id === "no_cloud" ? [laptop] : [laptop, linux, mac];
  const plans = hot ? samplePlan(now, machines) : [];
  const runs = id === "run_progress" ? [sampleRun(now, false)] : id === "run_failed" ? [sampleRun(now, true)] : [];
  return { machines, sessions: SAMPLE_SESSIONS, ready: true, plans, runs };
}

// The suggestion comes from the real planner (lib/resourceOffload) over the
// sample machines, so the preview shows exactly what the policy allows.
function sampleDevices(now: number): OffloadDeviceEvidence[] {
  return [
    { device_id: "dev-laptop", is_remote: false, online: true, label: "MacBook Pro (sample)", platform: "darwin" },
    {
      device_id: "dev-linux", is_remote: true, online: true, label: "Cloud Linux (sample)", platform: "linux",
      host_readiness: { at: now - 2 * 60_000, setup: { ok: true }, tools: { ok: 14, installed: 14, missing: [] }, mirror: { complete: true, files: 412, host_edited: [] } },
    },
    { device_id: "dev-cmac", is_remote: true, online: false, label: "Cloud Mac (sample)", platform: "darwin" },
  ];
}

function sampleCandidates(): MigrationCandidate[] {
  return SAMPLE_SESSIONS.filter((x) => x.conversationId).map((x) => ({
    _id: x.conversationId!, short_id: x.shortId ?? null, title: x.title, owner_device_id: x.deviceId ?? null,
    agent_type: x.agentType ?? null, project_path: x.projectPath ?? null, worktree_name: null, worktree_branch: null,
    updated_at: x.lastActiveAt ?? 0, has_pending_messages: false, migration: null, cloud_placement: null,
    inbox_stashed_at: null, inbox_dismissed_at: null,
  }));
}

function samplePlan(now: number, machines: ResourceMachine[]): OffloadPlan[] {
  const source = machines.find((m) => m.deviceId === "dev-laptop");
  if (!source) return [];
  const plan = buildOffloadPlan({ source, machines, sessions: SAMPLE_SESSIONS, devices: sampleDevices(now), candidates: sampleCandidates(), now });
  return plan ? [plan] : [];
}

function sampleRun(now: number, failed: boolean): OffloadRun {
  return {
    batchId: "mb-sample01",
    createdAt: now - 4 * 60_000,
    waitForTurnMs: 10 * 60_000,
    rows: failed
      ? [
        { sessionId: "ms-docs", destinationId: "dev-linux", status: "done", startedAt: now - 4 * 60_000 },
        { sessionId: "ms-sync", destinationId: "dev-linux", status: "failed", error: "Turn did not end within 10 min; left running here, nothing was interrupted", startedAt: now - 4 * 60_000 },
        { sessionId: "ms-migr", destinationId: "dev-linux", status: "failed", error: "Mirror push failed: host disk full (sample)", startedAt: now - 3 * 60_000 },
      ]
      : [
        { sessionId: "ms-docs", destinationId: "dev-linux", status: "done", startedAt: now - 4 * 60_000 },
        { sessionId: "ms-migr", destinationId: "dev-linux", status: "transferring", startedAt: now - 2 * 60_000 },
        { sessionId: "ms-sync", destinationId: "dev-linux", status: "waiting_idle", startedAt: now - 4 * 60_000 },
      ],
    finishedAt: failed ? now - 60_000 : undefined,
    measured: failed ? {
      before: { at: now - 4 * 60_000, cpuPercent: 86, memoryTotal: 128 * GB, memoryAvailable: 11 * GB, memoryAvailableIsEstimate: false, pressure: "critical", load1: 690, logicalCpus: 16, processCount: 1900 },
      after: { at: now - 30_000, cpuPercent: 84, memoryTotal: 128 * GB, memoryAvailable: 12.6 * GB, memoryAvailableIsEstimate: false, pressure: "critical", load1: 670, logicalCpus: 16, processCount: 1880 },
    } : { before: { at: now - 4 * 60_000, cpuPercent: 86, memoryTotal: 128 * GB, memoryAvailable: 11 * GB, memoryAvailableIsEstimate: false, pressure: "critical", load1: 690, logicalCpus: 16, processCount: 1900 } },
  };
}
