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
    expect(parseLinuxMemory("MemAvailable: 200 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB")).toEqual({ memoryAvailable: 204800, swapUsedBytes: 61440 });
  });
});

test("pressure suggestions require sustained fresh evidence", () => {
  const point = (at: number): ResourcePoint => ({ at, cpuPercent: 95, memoryTotal: 100, memoryAvailable: 50, memoryAvailableIsEstimate: false, logicalCpus: 8, load1: 2, pressure: "normal", processCount: 30 });
  expect(sustainedResourcePressure([point(0)], 0)).toBeNull();
  expect(sustainedResourcePressure([point(0), point(30_000), point(60_000)], 60_000)?.reason).toContain("CPU");
  expect(sustainedResourcePressure([point(0), point(30_000), point(60_000)], 240_000)).toBeNull();
  expect(sustainedResourcePressure([point(0), point(30_000), { ...point(60_000), cpuPercent: 20 }], 60_000)).toBeNull();
});

test("pressure recovery has hysteresis and sampling gaps break an incident", () => {
  const p = (at: number, cpuPercent: number): ResourcePoint => ({ at, cpuPercent, memoryTotal: 100, memoryAvailable: 50, memoryAvailableIsEstimate: false, logicalCpus: 8, load1: 2, pressure: "normal", processCount: 30 });
  const high = [p(0, 95), p(30000, 95), p(60000, 95)];
  expect(sustainedResourcePressure([...high, p(90000, 70)], 90000)).not.toBeNull();
  expect(sustainedResourcePressure([...high, p(90000, 70), p(120000, 70), p(150000, 70)], 150000)).toBeNull();
  expect(sustainedResourcePressure([...high, p(170000, 95)], 170000)).toBeNull();
});

test("a sustained incident escalates when critical memory pressure persists", () => {
  const p = (at: number, pressure: ResourcePoint["pressure"]): ResourcePoint => ({ at, cpuPercent: 95, memoryTotal: 100, memoryAvailable: 50, memoryAvailableIsEstimate: true, logicalCpus: 8, load1: 2, pressure, processCount: 30 });
  const points = [p(0, "normal"), p(30000, "normal"), p(60000, "normal"), p(90000, "critical"), p(120000, "critical"), p(150000, "critical")];
  expect(sustainedResourcePressure(points, 150000)?.level).toBe("critical");
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
  const history = [point(now - 150000, "critical"), point(now - 120000, "critical"), point(now - 90000, "critical"),
    point(now - 60000, "unknown"), point(now - 30000, "unknown"), point(now, "unknown")];
  expect(sustainedResourcePressure(history, now)?.level).toBe("critical");
  expect(sustainedResourcePressure([...history, point(now + 30000, "normal"), point(now + 60000, "normal"), point(now + 90000, "normal")], now + 90000)).toBeNull();
});
