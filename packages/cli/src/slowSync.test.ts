import { describe, expect, it } from "bun:test";
import { SLOW_SYNC_FS_MS, setSlowSyncSink, timeSync, timeSyncFs } from "./slowSync.js";

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {}
}

describe("slow sync reporting", () => {
  it("reports work past the threshold with the tag, name, duration and detail", () => {
    const seen: string[] = [];
    setSlowSyncSink((m) => seen.push(m));
    try {
      const out = timeSync("SLOW-SYNC-FS", 20, "walkDirsSync", () => "/tmp/tree", () => { busyWait(40); return 7; });
      expect(out).toBe(7);
    } finally {
      setSlowSyncSink(null);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\[SLOW-SYNC-FS\] walkDirsSync blocked the event loop \d+ms: \/tmp\/tree$/);
  });

  it("stays silent under the threshold and after the sink is cleared", () => {
    const seen: string[] = [];
    setSlowSyncSink((m) => seen.push(m));
    timeSync("SLOW-SYNC-FS", 500, "fast", "x", () => 1);
    setSlowSyncSink(null);
    timeSync("SLOW-SYNC-FS", 5, "unsunk", "x", () => busyWait(20));
    expect(seen).toEqual([]);
  });

  it("still reports when fn throws, and rethrows", () => {
    const seen: string[] = [];
    setSlowSyncSink((m) => seen.push(m));
    try {
      expect(() => timeSync("SLOW-SYNC-SPAWN", 10, "execSync", "boom", () => { busyWait(30); throw new Error("nope"); })).toThrow("nope");
    } finally {
      setSlowSyncSink(null);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("[SLOW-SYNC-SPAWN] execSync blocked the event loop");
  });

  it("timeSyncFs uses the filesystem threshold", () => {
    const seen: string[] = [];
    setSlowSyncSink((m) => seen.push(m));
    try {
      timeSyncFs("readAvailableSkills", "global", () => busyWait(SLOW_SYNC_FS_MS + 30));
    } finally {
      setSlowSyncSink(null);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\[SLOW-SYNC-FS\] readAvailableSkills blocked the event loop \d+ms: global$/);
  });
});
