import { describe, expect, test } from "bun:test";
import { attributeProcesses, collectMachineResources, ioRates, parseLinuxIo, parseLinuxMemory, parseMacIo, parseMacMemory, summarizeProcesses } from "./systemResources";
import { sustainedResourcePressure, type ResourcePoint } from "@codecast/shared/contracts";

describe("machine resource attribution", () => {
  test("I/O excludes duplicate address rows, tunnels and disk partitions", () => {
    const mac = parseMacIo('"Statistics" = {"Bytes (Read)"=100,"Bytes (Write)"=200}', "en0 1500 <Link#1> aa 1 0 1000 2 0 2000 0\nen0 1500 192.1.0.1 aa 1 0 1000 2 0 2000 0\nutun0 1500 <Link#2> aa 1 0 9000 2 0 9000 0");
    expect(mac).toEqual({ diskRead: 100, diskWrite: 200, received: 1000, sent: 2000 });
    const linux = parseLinuxIo("8 0 sda 1 0 10 0 2 0 20 0\n8 1 sda1 1 0 10 0 2 0 20 0", "eth0: 1000 0 0 0 0 0 0 0 2000 0\nlo: 500 0 0 0 0 0 0 0 500 0");
    expect(linux).toEqual({ diskRead: 5120, diskWrite: 10240, received: 1000, sent: 2000 });
    expect(ioRates(mac, { ...mac, received: 2000, sent: 100 }, 1000)).toEqual({ diskReadBytesPerSecond: 0, diskWriteBytesPerSecond: 0, networkReceivedBytesPerSecond: 1000 });
    expect(ioRates(mac, mac, 300_000)).toEqual({});
  });
  test("nested sessions own each process once and shared roots stay explicit", () => {
    const snapshot = new Map([
      [1, { pid: 1, ppid: 0, cpu: 1, rss: 100, command: "claude" }],
      [2, { pid: 2, ppid: 1, cpu: 2, rss: 200, command: "claude" }],
      [3, { pid: 3, ppid: 2, cpu: 3, rss: 300, command: "node" }],
      [4, { pid: 4, ppid: 4, cpu: 0, rss: 400, command: "other" }],
    ]);
    const rows = attributeProcesses(snapshot, new Map([["parent", 1], ["child", 2], ["borrower", 2]]));
    expect(rows[0].sessionId).toBe("parent");
    expect(rows[2].sessionId).toBeUndefined();
    expect(rows[2].sharedSessionIds).toEqual(["borrower", "child"]);
    expect(rows[3].sessionId).toBeUndefined();
    expect(summarizeProcesses(rows).groups.reduce((s, g) => s + g.rss, 0)).toBe(1000);
  });
  test("bounded details retain complete category totals and strip command paths", () => {
    const map = new Map(Array.from({ length: 300 }, (_, i) => [i, { pid: i, ppid: -1, rss: 10, cpu: 1, command: "/private/path/node" }]));
    const summary = summarizeProcesses(attributeProcesses(map, new Map()));
    expect(summary.processes).toHaveLength(256);
    expect(summary.processes[0].name).toBe("node");
    expect(summary.omittedProcessCount).toBe(44);
    expect(summary.groups[0]).toMatchObject({ rss: 3000, processCount: 300 });
  });
  test("known harness roots are agents even when the executable is a generic runtime", () => {
    const rows = attributeProcesses(new Map([
      [1, { pid: 1, ppid: 0, cpu: 2, rss: 100, command: "bun" }],
      [2, { pid: 2, ppid: 1, cpu: 1, rss: 50, command: "node" }],
    ]), new Map([["session", 1]]));
    expect(rows.map(p => p.kind)).toEqual(["agent", "tool"]);
    expect(rows.map(p => p.sessionId)).toEqual(["session", "session"]);
  });
  test("Mac page size and OS pressure do not equate low free memory with pressure", () => {
    const vm = "page size of 16384 bytes\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\nPages occupied by compressor: 4.";
    expect(parseMacMemory(vm, "used = 1.50G", "kern.memorystatus_vm_pressure_level: 1", 1e9)).toEqual({ memoryAvailable: 98304, compressedBytes: 65536, swapUsedBytes: 1.5 * 1024 ** 3, pressure: "normal" });
    expect(parseMacMemory("", "", "", 1e9)).toEqual({ pressure: "unknown" });
    expect(parseLinuxMemory("MemAvailable: 200 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB")).toEqual({ memoryAvailable: 204800, swapUsedBytes: 61440, pressure: "unknown" });
    const psi = (full: number, some = full) => `some avg10=0 avg60=${some} avg300=0 total=1\nfull avg10=0 avg60=${full} avg300=0 total=1`;
    expect(parseLinuxMemory("MemAvailable: 200 kB", psi(0.3)).pressure).toBe("normal");
    expect(parseLinuxMemory("MemAvailable: 200 kB", psi(3)).pressure).toBe("elevated");
    expect(parseLinuxMemory("MemAvailable: 200 kB", psi(1, 12)).pressure).toBe("elevated");
    expect(parseLinuxMemory("MemAvailable: 200 kB", psi(11.5)).pressure).toBe("critical");
  });
});

test("pressure suggestions require sustained fresh evidence", () => {
  const point = (at: number): ResourcePoint => ({ at, cpuPercent: 95, memoryTotal: 100, memoryAvailable: 50, memoryAvailableIsEstimate: false, logicalCpus: 8, load1: 2, pressure: "normal", processCount: 30 });
  expect(sustainedResourcePressure([point(0)], 0)).toBeNull();
  const minutes = (n: number) => Array.from({ length: n * 2 + 1 }, (_, i) => point(i * 30_000));
  expect(sustainedResourcePressure(minutes(1), 60_000)).toBeNull();
  expect(sustainedResourcePressure(minutes(3), 180_000)?.reason).toContain("CPU");
  expect(sustainedResourcePressure(minutes(3), 360_000)).toBeNull();
  expect(sustainedResourcePressure([...minutes(3).slice(0, -1), { ...point(180_000), cpuPercent: 20 }], 180_000)).toBeNull();
});

test("a high load average with idle CPU and free memory is not pressure", () => {
  const point = (at: number): ResourcePoint => ({ at, cpuPercent: 45, memoryTotal: 100, memoryAvailable: 50, memoryAvailableIsEstimate: false, logicalCpus: 16, load1: 48, pressure: "normal", processCount: 900 });
  const points = Array.from({ length: 11 }, (_, i) => point(i * 30_000));
  expect(sustainedResourcePressure(points, 300_000)).toBeNull();
});

test("pressure recovery has hysteresis and sampling gaps break an incident", () => {
  const p = (at: number, cpuPercent: number): ResourcePoint => ({ at, cpuPercent, memoryTotal: 100, memoryAvailable: 50, memoryAvailableIsEstimate: false, logicalCpus: 8, load1: 2, pressure: "normal", processCount: 30 });
  const high = Array.from({ length: 7 }, (_, i) => p(i * 30000, 95));
  expect(sustainedResourcePressure([...high, p(210000, 70)], 210000)).not.toBeNull();
  expect(sustainedResourcePressure([...high, p(210000, 70), p(240000, 70), p(270000, 70)], 270000)).toBeNull();
  expect(sustainedResourcePressure([...high, p(290000, 95)], 290000)).toBeNull();
});

test("a sustained incident escalates when critical memory pressure persists", () => {
  const p = (at: number, pressure: ResourcePoint["pressure"]): ResourcePoint => ({ at, cpuPercent: 95, memoryTotal: 100, memoryAvailable: 50, memoryAvailableIsEstimate: true, logicalCpus: 8, load1: 2, pressure, processCount: 30 });
  const points = [...Array.from({ length: 7 }, (_, i) => p(i * 30000, "normal")), p(210000, "critical"), p(240000, "critical"), p(270000, "critical")];
  expect(sustainedResourcePressure(points, 270000)?.level).toBe("critical");
});


test("process capture failure still yields honest machine telemetry", async () => {
  const report = await collectMachineResources("collector-test", undefined, new Map());
  expect(report.sample.memoryTotal).toBeGreaterThan(0);
  expect(report.sample.processCount).toBeUndefined();
  expect(report.processes).toEqual([]);
  expect(report.groups).toEqual([]);
  expect(report.limitations.some(s => s.includes("Process capture failed"))).toBe(true);
}, 60000);


test("missing memory pressure probes do not falsely recover an incident", () => {
  const now = 1_000_000;
  const point = (at: number, pressure: "critical" | "unknown" | "normal") => ({ at, pressure,
    cpuPercent: 10, load1: 1, logicalCpus: 8, memoryTotal: 100, memoryAvailable: 50, memoryAvailableIsEstimate: true });
  const history = [...Array.from({ length: 7 }, (_, i) => point(now - 330000 + i * 30000, "critical")),
    point(now - 120000, "unknown"), point(now - 90000, "unknown"), point(now - 60000, "unknown"), point(now - 30000, "unknown"), point(now, "unknown")];
  expect(sustainedResourcePressure(history, now)?.level).toBe("critical");
  expect(sustainedResourcePressure([...history, point(now + 30000, "normal"), point(now + 60000, "normal"), point(now + 90000, "normal")], now + 90000)).toBeNull();
});
