import { describe, it, expect } from "bun:test";
import {
  captureProcessSnapshot,
  getSubtreePids,
  getSubtreeResources,
  collectSessionResources,
  formatResourcesLog,
  type ProcessInfo,
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
});
