import { describe, it, expect } from "bun:test";
import { parseEtimeSeconds, captureProcessSnapshot, stableAgentStartedAt } from "./resourceMonitor.js";

// ps `etime` is the only whitespace-free way to get a process's age on macOS
// (`lstart` has spaces and `etimes` does not exist there), and the snapshot
// parser splits on whitespace — so this format is load-bearing.
describe("parseEtimeSeconds", () => {
  it("reads every column width ps uses as the process ages", () => {
    expect(parseEtimeSeconds("00:07")).toBe(7);
    expect(parseEtimeSeconds("01:04:47")).toBe(3887);
    expect(parseEtimeSeconds("09-22:25:17")).toBe(9 * 86400 + 22 * 3600 + 25 * 60 + 17);
    expect(parseEtimeSeconds("  01:04:47  ")).toBe(3887);
  });

  it("returns undefined rather than guessing on anything unexpected", () => {
    // A wrong start time here would fence live watches as dead, so an
    // unrecognized format must produce no opinion at all.
    for (const bad of ["", "-", "abc", "1-2-3", "Wed Aug 12", "12"]) {
      expect(parseEtimeSeconds(bad)).toBeUndefined();
    }
  });
});

describe("captureProcessSnapshot", () => {
  it("stamps a plausible start time on this very process", async () => {
    if (process.platform !== "darwin") return;
    const snap = await captureProcessSnapshot();
    const me = snap.get(process.pid);
    expect(me).toBeDefined();
    expect(me!.startedAt).toBeDefined();
    // Started in the past, and not before the machine plausibly booted.
    expect(me!.startedAt!).toBeLessThanOrEqual(Date.now());
    expect(me!.startedAt!).toBeGreaterThan(Date.now() - 365 * 24 * 3600_000);
  });
});

// ps has one-second resolution, so `now - floor(elapsed)` moves a little every
// tick. That jitter must not read as a restart: it would patch the hot
// managed_sessions doc every 30s per session and re-push the liveness overlay
// with a start time that never settles.
describe("stableAgentStartedAt", () => {
  const T = 1_786_000_000_000;

  it("holds the previous value across sampling jitter", () => {
    expect(stableAgentStartedAt(T + 700, T)).toBe(T);
    expect(stableAgentStartedAt(T - 999, T)).toBe(T);
    expect(stableAgentStartedAt(T, T)).toBe(T);
  });

  it("takes the new value when the process really restarted", () => {
    const restarted = T + 3600_000;
    expect(stableAgentStartedAt(restarted, T)).toBe(restarted);
  });

  it("adopts the first reading, and claims nothing without one", () => {
    expect(stableAgentStartedAt(T, undefined)).toBe(T);
    // No sample this tick — better to have no opinion than to re-assert a
    // start time we can no longer see.
    expect(stableAgentStartedAt(undefined, T)).toBeUndefined();
  });
});
