import { expect, test } from "bun:test";
import { levelOf, loadColor, needleAngle } from "./ResourcePressureGauge";
import { loadPercent } from "./resourceModel";

test("the gauge's dot follows the sustained incident, the same one the overload notification reports", () => {
  expect(levelOf(null)).toBe("calm");
  expect(levelOf({ level: "elevated", since: 0, reason: "CPU use has stayed above 90%" })).toBe("elevated");
  expect(levelOf({ level: "critical", since: 0, reason: "The operating system reports critical memory pressure" })).toBe("critical");
});

test("the needle sweeps 240 degrees with load and the color warms from muted through yellow to red", () => {
  expect(needleAngle(0)).toBe(0);
  expect(needleAngle(50)).toBe(120);
  expect(needleAngle(140)).toBe(240);
  expect(loadColor(30)).toBe("color-mix(in srgb, var(--sol-yellow) 0%, var(--sol-text-muted))");
  expect(loadColor(75)).toBe("color-mix(in srgb, var(--sol-yellow) 100%, var(--sol-text-muted))");
  expect(loadColor(96)).toBe("color-mix(in srgb, var(--sol-red) 100%, var(--sol-yellow))");
});

test("load is the busier of CPU and memory, raised to the OS pressure verdict", () => {
  const p = { at: 0, cpuPercent: 40, memoryTotal: 100, memoryAvailable: 30, memoryAvailableIsEstimate: false, pressure: "normal" as const, load1: 1, logicalCpus: 8 };
  expect(loadPercent(p)).toBe(70);
  expect(loadPercent({ ...p, cpuPercent: 96 })).toBe(96);
  expect(loadPercent({ ...p, pressure: "elevated" })).toBe(80);
  expect(loadPercent({ ...p, pressure: "critical" })).toBe(95);
});
