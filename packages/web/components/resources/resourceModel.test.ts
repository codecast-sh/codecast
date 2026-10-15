import { describe, expect, test } from "bun:test";
import { attribute, buildRows, freshness, machineTotals } from "./resourceModel";
import { buildScenario } from "./fixtures";

const now = 1_800_000_000_000;

describe("attribute", () => {
  const { machines, sessions } = buildScenario("pressure", now);
  const laptop = machines.find((m) => m.deviceId === "dev-laptop")!;

  test("rows add up to the machine's own totals: nothing counted twice or dropped", () => {
    const rows = attribute(laptop.deviceId, laptop.snapshot!);
    const sum = rows.reduce((a, r) => ({ cpu: a.cpu + r.usage.cpu, rss: a.rss + r.usage.rss, count: a.count + r.usage.count }), { cpu: 0, rss: 0, count: 0 });
    const t = machineTotals(laptop.snapshot!);
    expect(sum.cpu).toBeCloseTo(t.cpu, 6);
    expect(sum.rss).toBeCloseTo(t.rss, 0);
    expect(sum.count).toBe(t.count);
    // The collector's invariant: the sample's process count is every process the groups counted.
    expect(laptop.snapshot!.sample.processCount).toBe(t.count);
  });

  test("a process several sessions share gets one row and is not added to any session", () => {
    const rows = attribute(laptop.deviceId, laptop.snapshot!);
    const tsc = laptop.snapshot!.processes.find((p) => p.name === "tsc --watch")!;
    const holders = rows.filter((r) => r.processes.includes(tsc));
    expect(holders).toHaveLength(1);
    expect(holders[0].type).toBe("shared");
    expect(holders[0].sharedWith).toEqual(["ms-codex", "ms-docs"]);
  });

  test("grouping by kind or project preserves the machine total", () => {
    const t = machineTotals(laptop.snapshot!);
    for (const g of ["kind", "project", "machine"] as const) {
      const rows = buildRows([laptop], sessions, g);
      expect(rows.reduce((a, r) => a + r.usage.rss, 0)).toBeCloseTo(t.rss, 0);
    }
  });
});

describe("freshness", () => {
  const now = 1_800_000_000_000;
  const machine = (online: boolean, ageMs: number) => {
    const m = buildScenario("pressure", now).machines.find((x) => x.role === "local" && x.snapshot)!;
    return { ...m, online, receivedAt: now - ageMs, snapshot: { ...m.snapshot!, sample: { ...m.snapshot!.sample, at: now - ageMs } } };
  };

  test("a fresh report is live even when the device heartbeat has lapsed", () => {
    expect(freshness(machine(false, 30_000), now)).toBe("live");
  });

  test("an old report reads stale while online and offline once the heartbeat lapses", () => {
    expect(freshness(machine(true, 10 * 60_000), now)).toBe("stale");
    expect(freshness(machine(false, 10 * 60_000), now)).toBe("offline");
  });
});
