import { describe, expect, it } from "bun:test";
import { promisify } from "node:util";
import { execFile, execFileSync, spawnSync, withWindowsHide, SLOW_SYNC_SPAWN_MS } from "./proc.js";
import { setSlowSyncSink } from "./slowSync.js";

describe("withWindowsHide", () => {
  it("appends options when only a command is given", () => {
    expect(withWindowsHide(["cmd"])).toEqual(["cmd", { windowsHide: true }]);
  });

  it("appends options after an args array", () => {
    expect(withWindowsHide(["cmd", ["-a"]])).toEqual(["cmd", ["-a"], { windowsHide: true }]);
  });

  it("merges into existing options", () => {
    expect(withWindowsHide(["cmd", ["-a"], { timeout: 5 }])).toEqual([
      "cmd",
      ["-a"],
      { windowsHide: true, timeout: 5 },
    ]);
  });

  it("respects an explicit windowsHide from the caller", () => {
    expect(withWindowsHide(["cmd", { windowsHide: false }])).toEqual(["cmd", { windowsHide: false }]);
  });

  it("inserts options before a trailing callback", () => {
    const cb = () => {};
    expect(withWindowsHide(["cmd", cb])).toEqual(["cmd", { windowsHide: true }, cb]);
    expect(withWindowsHide(["cmd", ["-a"], cb])).toEqual(["cmd", ["-a"], { windowsHide: true }, cb]);
  });

  it("fills an explicit undefined options slot", () => {
    expect(withWindowsHide(["cmd", ["-a"], undefined])).toEqual(["cmd", ["-a"], { windowsHide: true }]);
  });
});

describe("wrapped child_process functions", () => {
  it("spawnSync still runs commands and honors options", () => {
    const res = spawnSync("echo", ["hi"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
  });

  it("execFileSync still returns output", () => {
    const out = execFileSync("echo", ["hi"], { encoding: "utf-8" });
    expect(out.trim()).toBe("hi");
  });

  it("promisify(execFile) still resolves {stdout, stderr}", async () => {
    const execFileAsync = promisify(execFile);
    const { stdout, stderr } = await execFileAsync("echo", ["hi"]);
    expect(stdout.trim()).toBe("hi");
    expect(stderr).toBe("");
  });
});

describe("slow sync spawn reporting", () => {
  it("reports a sync spawn that outlives the threshold, naming the command", () => {
    const seen: string[] = [];
    setSlowSyncSink((m) => seen.push(m));
    try {
      execFileSync("sleep", [String((SLOW_SYNC_SPAWN_MS + 200) / 1000)]);
    } finally {
      setSlowSyncSink(null);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\[SLOW-SYNC-SPAWN\] execFileSync blocked the event loop \d+ms: sleep 1\.2$/);
  });

  it("stays silent for a fast sync spawn and after the sink is cleared", () => {
    const seen: string[] = [];
    setSlowSyncSink((m) => seen.push(m));
    execFileSync("true");
    setSlowSyncSink(null);
    execFileSync("sleep", [String((SLOW_SYNC_SPAWN_MS + 200) / 1000)]);
    expect(seen).toEqual([]);
  });

  it("still reports when the slow command fails", () => {
    const seen: string[] = [];
    setSlowSyncSink((m) => seen.push(m));
    try {
      expect(() => execFileSync("sh", ["-c", `sleep ${(SLOW_SYNC_SPAWN_MS + 200) / 1000}; exit 3`])).toThrow();
    } finally {
      setSlowSyncSink(null);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("execFileSync blocked the event loop");
  });
});
