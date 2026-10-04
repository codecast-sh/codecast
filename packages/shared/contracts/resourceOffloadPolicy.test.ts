import { expect, test } from "bun:test";
import { evaluateOffloadRequirements } from "./resourceOffloadPolicy";
import type { OffloadRequirements } from "./resourceOffloadPolicy";
const input = (): OffloadRequirements => ({ processes: [{ pid: 1, ppid: 0, name: "node", kind: "tool", cpu: 10, rss: 100 }], targetPlatform: "linux", targetOnline: true, targetWakeable: false, now: 1000000 });
test("unknown portability and absent measurements remain prerequisites", () => {
  const check = evaluateOffloadRequirements(input());
  expect(check.blockers).toEqual([]);
  expect(check.pending).toContain("Measure available memory and CPU on the destination");
  expect(check.pending.some(p => p.includes("OS/architecture"))).toBe(true);
  expect(check.passed).toEqual([]);
});
test("Apple tooling needs Mac and attached simulator state blocks all destinations", () => {
  const args = input();
  args.processes[0].name = "xcodebuild";
  expect(evaluateOffloadRequirements(args).blockers[0]).toContain("requires a Mac");
  args.targetPlatform = "darwin";
  expect(evaluateOffloadRequirements(args).blockers).toEqual([]);
  args.processes[0].kind = "simulator";
  expect(evaluateOffloadRequirements(args).blockers[0]).toContain("live state");
});
test("reported setup failures block, stale reports do not imply success", () => {
  const args = input();
  args.readiness = { at: args.now, setup: { ok: false, error: "missing service" } };
  expect(evaluateOffloadRequirements(args).blockers[0]).toContain("missing service");
  args.readiness = { at: 0, setup: { ok: true } };
  expect(evaluateOffloadRequirements(args).passed).toEqual([]);
  expect(evaluateOffloadRequirements(args).pending[0]).toContain("Refresh");
});

test("an elevated or backed-up destination is not treated as available capacity", () => {
  const args = input();
  args.targetSample = { at: args.now, memoryTotal: 1000, memoryAvailable: 500, memoryAvailableIsEstimate: false, pressure: "elevated", cpuPercent: 20, logicalCpus: 4, load1: 2, processCount: 10 };
  expect(evaluateOffloadRequirements(args).blockers).toContain("The destination is already under heavy pressure");
  args.targetSample.pressure = "normal";
  args.targetSample.load1 = 50;
  expect(evaluateOffloadRequirements(args).blockers).toContain("The destination is already under heavy pressure");
});

test("tools missing from the laptop's hook inventory are a note, never a blocker", () => {
  const args = input();
  args.readiness = { at: args.now, setup: { ok: true }, tools: { ok: 3, installed: 0, missing: [{ tool: "afplay" }, { tool: "powershell.exe" }] } };
  const check = evaluateOffloadRequirements(args);
  expect(check.blockers).toEqual([]);
  expect(check.notes).toEqual(["Hooks call tools this host lacks: afplay, powershell.exe"]);
});
