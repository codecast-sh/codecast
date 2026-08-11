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
  type SessionResources,
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
      const result = await collectSessionResources(sessionPids, new Set());
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
      const result = await collectSessionResources(sessionPids, new Set());
      expect(result.size).toBe(0);
    });

    // Real Codex ids from ~/.codex/sessions/2026/08/02: UUIDv7, so a parent and
    // the subagents it spawns share the leading millisecond timestamp.
    const PARENT = "019fb73a-a85c-7d31-b0a2-3f9c5e2d8a41";
    const SUBAGENT = "019fb73a-a740-7c02-9e11-6b4d0a7f3c88";

    it("credits a shared root pid to exactly one session", async () => {
      if (process.platform !== "darwin") return;
      // The live defect: 15 distinct Codex session ids all resolved to pid 55521
      // and each reported the SAME subtree, summed 15x into the fleet total.
      const sessionPids = new Map<string, number>([
        [PARENT, process.pid],
        [SUBAGENT, process.pid],
      ]);
      const result = await collectSessionResources(sessionPids, new Set());

      expect(result.size).toBe(2);
      const credited = [...result.values()].filter((r) => r.pidCount > 0);
      expect(credited.length).toBe(1);
      // Lexicographically smallest wins, so the winner does not depend on the
      // caller's (unstable) map iteration order.
      expect(credited[0].sessionId).toBe(SUBAGENT);
      const loser = result.get(PARENT)!;
      expect(loser.sharesRootPid).toBe(true);
      expect(loser.cpu).toBe(0);
      expect(loser.memory).toBe(0);
      expect(loser.pidCount).toBe(0);
    });

    it("never credits a session that shares another's process, even when it sorts first", async () => {
      if (process.platform !== "darwin") return;
      // SUBAGENT sorts BEFORE parent, so it would win the tie-break — being a
      // known borrower must override that entirely.
      const sessionPids = new Map<string, number>([
        [SUBAGENT, process.pid],
        [PARENT, process.pid],
      ]);
      const result = await collectSessionResources(sessionPids, new Set([SUBAGENT]));

      const parent = result.get(PARENT)!;
      expect(parent.pidCount).toBeGreaterThanOrEqual(1);
      expect(parent.memory).toBeGreaterThan(0);
      expect(parent.sharesRootPid).toBeUndefined();

      const sub = result.get(SUBAGENT)!;
      expect(sub.sharesRootPid).toBe(true);
      expect(sub.cpu).toBe(0);
      expect(sub.memory).toBe(0);
      expect(sub.pidCount).toBe(0);
    });

    it("leaves a subtree uncounted when every claimant is a borrower", async () => {
      if (process.platform !== "darwin") return;
      // Two subagents of a parent that isn't tracked: nobody owns the tree, so
      // nobody is credited. Uncounted beats attributed to the wrong session.
      const sessionPids = new Map<string, number>([
        [SUBAGENT, process.pid],
        [PARENT, process.pid],
      ]);
      const result = await collectSessionResources(sessionPids, new Set([SUBAGENT, PARENT]));
      expect([...result.values()].every((r) => r.sharesRootPid === true && r.pidCount === 0)).toBe(true);
    });

    it("picks the same winner regardless of insertion order", async () => {
      if (process.platform !== "darwin") return;
      // The process cache is evicted and refilled between ticks. If the winner
      // followed iteration order, the credited session would alternate and both
      // sessions' graphs would flicker.
      const forward = await collectSessionResources(
        new Map([[PARENT, process.pid], [SUBAGENT, process.pid]]), new Set(),
      );
      const reverse = await collectSessionResources(
        new Map([[SUBAGENT, process.pid], [PARENT, process.pid]]), new Set(),
      );
      const winner = (m: Map<string, SessionResources>) =>
        [...m.values()].find((r) => r.pidCount > 0)!.sessionId;
      expect(winner(forward)).toBe(winner(reverse));
    });

    // CONTROL (passes pre-fix by construction): guards against the dedupe
    // OVER-firing and starving ordinary, non-colliding sessions of metrics.
    it("still counts distinct root pids independently", async () => {
      if (process.platform !== "darwin") return;
      const sessionPids = new Map<string, number>([
        [PARENT, process.pid],
        [SUBAGENT, process.ppid],
      ]);
      const result = await collectSessionResources(sessionPids, new Set());
      expect([...result.values()].every((r) => !r.sharesRootPid)).toBe(true);
      expect(result.get(PARENT)!.pidCount).toBeGreaterThanOrEqual(1);
      expect(result.get(SUBAGENT)!.pidCount).toBeGreaterThanOrEqual(1);
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

    it("does NOT accrue idle time on a cpu=0 we zeroed ourselves", () => {
      // A shared-root-pid row reports cpu=0 because its subtree was credited to
      // the session that OWNS the pid. Accruing on that fiction would march the
      // counter toward the Sessions page's 2h "idle" bucket, which feeds the bulk
      // "Kill all" selection — manufacturing a kill candidate from our own zero.
      // Pre-dedupe a borrower inherited the parent's real CPU, so a busy parent
      // kept resetting it; nothing would now.
      const banked = 90 * 60 * 1000;
      const after = nextAwakeIdleMs({
        prevIdleMs: banked, cpu: 0, status: undefined, elapsedMs: TICK,
        sleepSkip: false, sharesRootPid: true,
      });
      expect(after).toBe(banked);
    });

    it("a borrower that is actually WORKING still resets to 0", () => {
      // Order matters: the activity test runs before the carry-forward, so a
      // stale total can't survive on a session the agent says is working.
      const after = nextAwakeIdleMs({
        prevIdleMs: 90 * 60 * 1000, cpu: 0, status: "working", elapsedMs: TICK,
        sleepSkip: false, sharesRootPid: true,
      });
      expect(after).toBe(0);
    });

    it("an ordinary session still accrues normally (sharesRootPid absent)", () => {
      const after = nextAwakeIdleMs({
        prevIdleMs: TICK, cpu: 0, status: "idle", elapsedMs: TICK, sleepSkip: false,
      });
      expect(after).toBe(2 * TICK);
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

    it("distinguishes a Codex parent from its subagent (UUIDv7 prefixes collide)", () => {
      // Both ids start "019fb73a" — the shared UUIDv7 millisecond timestamp — so
      // an 8-char log prefix rendered a parent and its subagent as the same
      // session, which is exactly what made the live misattribution unreadable.
      const parent = "019fb73a-a85c-7d31-b0a2-3f9c5e2d8a41";
      const subagent = "019fb73a-a740-7c02-9e11-6b4d0a7f3c88";
      const result = formatResourcesLog(new Map([
        [parent, { sessionId: parent, cpu: 12, memory: 104857600, pidCount: 10, collectedAt: 1 }],
        [subagent, { sessionId: subagent, cpu: 0, memory: 0, pidCount: 0, collectedAt: 1, sharesRootPid: true }],
      ]));

      expect(result).toContain("019fb73a-a85c");
      expect(result).toContain("019fb73a-a740");
      // The two rendered ids must actually differ — the whole point.
      const ids = [...result.matchAll(/019fb73a-[0-9a-f]+/g)].map((m) => m[0]);
      expect(new Set(ids).size).toBe(2);
      // And the borrower is reported as not counted, not as a real 0% session.
      expect(result).toContain("shares another session's pid (not counted)");
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

    it("reports a restart immediately, even on an idle session with a reused pid", () => {
      // The web fences background watches on this timestamp, so sitting on the
      // idle throttle would leave dead watchers showing as running for minutes.
      const prev: ReportedMetrics = { ...base, agentStartedAt: 900_000 };
      const restarted = { ...cur, agentStartedAt: 999_000 };
      expect(shouldReportMetrics({ cur: restarted, prev, status: "idle", now: base.at + 30_000 })).toBe(true);
      // Same process, same everything: still throttled.
      expect(shouldReportMetrics({ cur: { ...cur, agentStartedAt: 900_000 }, prev, status: "idle", now: base.at + 30_000 })).toBe(false);
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
