import { describe, it, expect } from "bun:test";
import {
  captureProcessSnapshot,
  getSubtreePids,
  getSubtreeResources,
  collectSessionResources,
  formatResourcesLog,
  nextAwakeIdleMs,
  shouldReportMetrics,
  isSessionActive,
  IDLE_METRICS_REFRESH_MS,
  type ProcessInfo,
  type ReportedMetrics,
} from "./resourceMonitor.js";

describe("resourceMonitor", () => {
  describe("captureProcessSnapshot", () => {
    it("should return a non-empty map on darwin", async () => {
      if (process.platform !== "darwin") return;
      const snapshot = await captureProcessSnapshot();
      expect(snapshot.size).toBeGreaterThan(0);
      const first = snapshot.values().next().value!;
      expect(typeof first.pid).toBe("number");
      expect(typeof first.ppid).toBe("number");
      expect(typeof first.cpu).toBe("number");
      expect(typeof first.rss).toBe("number");
      expect(first.rss).toBeGreaterThanOrEqual(0);
    });

    it("should include the current process", async () => {
      if (process.platform !== "darwin") return;
      const snapshot = await captureProcessSnapshot();
      const self = snapshot.get(process.pid);
      expect(self).toBeDefined();
      expect(self!.pid).toBe(process.pid);
      expect(self!.rss).toBeGreaterThan(0);
    });
  });

  describe("getSubtreePids", () => {
    it("should walk the process tree", () => {
      const snapshot = new Map<number, ProcessInfo>([
        [1, { pid: 1, ppid: 0, cpu: 0, rss: 100 }],
        [10, { pid: 10, ppid: 1, cpu: 1, rss: 200 }],
        [20, { pid: 20, ppid: 10, cpu: 2, rss: 300 }],
        [30, { pid: 30, ppid: 10, cpu: 0.5, rss: 400 }],
        [40, { pid: 40, ppid: 1, cpu: 0, rss: 50 }],
        [99, { pid: 99, ppid: 0, cpu: 5, rss: 1000 }],
      ]);

      const pids = getSubtreePids(snapshot, 10);
      expect(pids).toContain(10);
      expect(pids).toContain(20);
      expect(pids).toContain(30);
      expect(pids).not.toContain(1);
      expect(pids).not.toContain(40);
      expect(pids).not.toContain(99);
    });

    it("should handle leaf nodes", () => {
      const snapshot = new Map<number, ProcessInfo>([
        [1, { pid: 1, ppid: 0, cpu: 0, rss: 100 }],
        [10, { pid: 10, ppid: 1, cpu: 1, rss: 200 }],
      ]);
      const pids = getSubtreePids(snapshot, 10);
      expect(pids).toEqual([10]);
    });

    it("should handle missing root pid gracefully", () => {
      const snapshot = new Map<number, ProcessInfo>();
      const pids = getSubtreePids(snapshot, 999);
      expect(pids).toEqual([999]);
    });
  });

  describe("getSubtreeResources", () => {
    it("should sum CPU and memory across subtree", () => {
      const snapshot = new Map<number, ProcessInfo>([
        [1, { pid: 1, ppid: 0, cpu: 0, rss: 100 }],
        [10, { pid: 10, ppid: 1, cpu: 1.5, rss: 2048 }],
        [20, { pid: 20, ppid: 10, cpu: 3.2, rss: 4096 }],
        [30, { pid: 30, ppid: 10, cpu: 0.3, rss: 1024 }],
      ]);

      const resources = getSubtreeResources(snapshot, 10);
      expect(resources.cpu).toBe(5);
      expect(resources.memory).toBe(2048 + 4096 + 1024);
      expect(resources.pidCount).toBe(3);
    });

    it("should return zeros for nonexistent root", () => {
      const snapshot = new Map<number, ProcessInfo>();
      const resources = getSubtreeResources(snapshot, 999);
      expect(resources.cpu).toBe(0);
      expect(resources.memory).toBe(0);
      expect(resources.pidCount).toBe(0);
    });
  });

  describe("collectSessionResources", () => {
    it("should collect resources for real sessions on darwin", async () => {
      if (process.platform !== "darwin") return;
      const sessionPids = new Map<string, number>([
        ["test-session-self", process.pid],
      ]);
      const result = await collectSessionResources(sessionPids);
      expect(result.size).toBe(1);
      const r = result.get("test-session-self")!;
      expect(r.sessionId).toBe("test-session-self");
      expect(r.memory).toBeGreaterThan(0);
      expect(r.pidCount).toBeGreaterThanOrEqual(1);
      expect(r.collectedAt).toBeGreaterThan(0);
    });

    it("should skip sessions whose root pid is not in snapshot", async () => {
      if (process.platform !== "darwin") return;
      const sessionPids = new Map<string, number>([
        ["dead-session", 999999999],
      ]);
      const result = await collectSessionResources(sessionPids);
      expect(result.size).toBe(0);
    });
  });

  describe("nextAwakeIdleMs", () => {
    const TICK = 30_000;

    it("accumulates idle time across awake ticks", () => {
      let idle = 0;
      idle = nextAwakeIdleMs({ prevIdleMs: idle, cpu: 0.1, status: "idle", elapsedMs: TICK, sleepSkip: false });
      idle = nextAwakeIdleMs({ prevIdleMs: idle, cpu: 0.0, status: "connected", elapsedMs: TICK, sleepSkip: false });
      expect(idle).toBe(2 * TICK);
    });

    it("resets to 0 when CPU is above the floor", () => {
      const idle = nextAwakeIdleMs({ prevIdleMs: 5 * TICK, cpu: 25, status: "idle", elapsedMs: TICK, sleepSkip: false });
      expect(idle).toBe(0);
    });

    it("resets to 0 on a working status even at near-zero CPU (blocked on a tool/network call)", () => {
      const idle = nextAwakeIdleMs({ prevIdleMs: 5 * TICK, cpu: 0.0, status: "working", elapsedMs: TICK, sleepSkip: false });
      expect(idle).toBe(0);
    });

    it("does NOT count a sleep gap as idle (laptop closed for 2h)", () => {
      const before = 10 * 60 * 1000; // 10 min of genuine awake-idle already banked
      const twoHourGap = 2 * 60 * 60 * 1000;
      const after = nextAwakeIdleMs({ prevIdleMs: before, cpu: 0.0, status: "idle", elapsedMs: twoHourGap, sleepSkip: true });
      // The frozen 2h is excluded — the counter is unchanged, so reopening the
      // lid does not suddenly mark the session killable.
      expect(after).toBe(before);
    });

    it("treats undefined status as not-working (idle accrues on low CPU)", () => {
      const idle = nextAwakeIdleMs({ prevIdleMs: 0, cpu: 0.0, status: undefined, elapsedMs: TICK, sleepSkip: false });
      expect(idle).toBe(TICK);
    });
  });

  describe("formatResourcesLog", () => {
    it("should format empty resources", () => {
      const result = formatResourcesLog(new Map());
      expect(result).toBe("No active sessions with resource data");
    });

    it("should format session resources", () => {
      const resources = new Map([
        ["abcdef12-3456-7890", {
          sessionId: "abcdef12-3456-7890",
          cpu: 15.5,
          memory: 104857600,
          pidCount: 5,
          collectedAt: Date.now(),
        }],
      ]);
      const result = formatResourcesLog(resources);
      expect(result).toContain("abcdef1");
      expect(result).toContain("cpu=15.5%");
      expect(result).toContain("mem=100.0MB");
      expect(result).toContain("procs=5");
    });
  });

  describe("shouldReportMetrics", () => {
    const base: ReportedMetrics = { cpu: 0, memory: 100_000_000, pidCount: 1, agentPid: 42, at: 1_000_000 };
    const cur = { cpu: 0, memory: 100_000_000, pidCount: 1, agentPid: 42 };

    it("always reports when there is no prior sample", () => {
      expect(shouldReportMetrics({ cur, prev: undefined, status: "idle", now: base.at })).toBe(true);
    });

    it("skips an idle, flat, recently-reported session (the fleet-saturation case)", () => {
      expect(shouldReportMetrics({ cur, prev: base, status: "idle", now: base.at + 30_000 })).toBe(false);
      expect(shouldReportMetrics({ cur, prev: base, status: "stopped", now: base.at + 60_000 })).toBe(false);
    });

    it("reports active sessions every tick for full-fidelity graphs", () => {
      expect(shouldReportMetrics({ cur, prev: base, status: "working", now: base.at + 30_000 })).toBe(true);
      // burning CPU counts as active even with an idle status
      expect(shouldReportMetrics({ cur: { ...cur, cpu: 25 }, prev: base, status: "idle", now: base.at + 30_000 })).toBe(true);
    });

    it("reports on a meaningful change while idle", () => {
      // ≥10% memory swing
      expect(shouldReportMetrics({ cur: { ...cur, memory: 115_000_000 }, prev: base, status: "idle", now: base.at + 30_000 })).toBe(true);
      // process-tree shape change
      expect(shouldReportMetrics({ cur: { ...cur, pidCount: 3 }, prev: base, status: "idle", now: base.at + 30_000 })).toBe(true);
      // agent_pid change (the server snapshot patch keys off this)
      expect(shouldReportMetrics({ cur: { ...cur, agentPid: 99 }, prev: base, status: "idle", now: base.at + 30_000 })).toBe(true);
    });

    it("re-reports an idle session on the slow keep-alive cadence", () => {
      expect(shouldReportMetrics({ cur, prev: base, status: "idle", now: base.at + IDLE_METRICS_REFRESH_MS - 1 })).toBe(false);
      expect(shouldReportMetrics({ cur, prev: base, status: "idle", now: base.at + IDLE_METRICS_REFRESH_MS })).toBe(true);
    });

    it("isSessionActive matches the idle accounting definition", () => {
      expect(isSessionActive(0, "idle")).toBe(false);
      expect(isSessionActive(5, "idle")).toBe(true);
      expect(isSessionActive(0, "working")).toBe(true);
      expect(isSessionActive(0, undefined)).toBe(false);
    });
  });
});
