import { expect, test } from "bun:test";
import { runDaemonBench, renderMarkdown, type BenchContext, type DaemonBenchIO } from "./daemonBench.js";
import { buildLogReport } from "./logReport.js";
import { fakeLoad, loadDeps, loadOptions, runtimeIdentity } from "./testFixtures.js";

function fixture() {
  const f = fakeLoad(); const writes = new Map<string, string>();
  const deps = { ...loadDeps, version: "fixture-version", readDaemonState: () => ({}) };
  const context: BenchContext = { at: "fixture-time", runtime: { ...runtimeIdentity }, daemonConnected: true, heartbeatAgeMs: 1, cliVersion: "fixture-version", testerRuntime: "fixture", loadAvg: [0, 0, 0], processCount: 2, tmuxPanes: 2, freeMemMb: 10, port: 43210, termAuth: "private-fake-api private-fake", source: { commit: "fixture-head", dirty: [], error: null }, diskWorkerSetting: true };
  const io: Partial<DaemonBenchIO> = { identity: () => ({ port: 43210, token: "private-fake", reason: null }), context: async () => structuredClone(context), routes: opts => f.io.routes({ ...opts, clock: f.clock }), loadIO: f.io, logs: async () => ({ log: buildLogReport([], { sinceMs: 0, sleepWindows: [] }), windows: [] }), write: async (file, value) => { writes.set(file, value); } };
  const options = { ...loadOptions, load: 2, logSinceMs: 1000, json: true };
  return { f, deps, context, io, options, writes };
}

test("final report retains every raw probe sample and redacts private credentials", async () => {
  const { f, deps, io, options, writes } = fixture();
  const r = await f.clock.drive(runDaemonBench(deps, options, () => {}, io));
  expect(r.observe!.loopLag.samples.length).toBeGreaterThan(0); expect(r.load!.loopLag!.samples.length).toBeGreaterThan(0);
  expect(r.load!.teardown.verified).toBe(true); expect(r.acceptance.status).toBe("NOT ESTABLISHED");
  expect(writes.size).toBe(2);
  for (const text of writes.values()) { expect(text).not.toContain("private-fake"); expect(text).not.toContain("Bearer"); }
  expect(renderMarkdown(r)).toContain("scheduled"); expect(renderMarkdown(r)).toContain("NOT ESTABLISHED");
  expect(f.clock.timers.size).toBe(0);
});

test("startup/observe failure still persists a final report with after observation", async () => {
  for (const phase of ["identity", "context", "routes", "logs", "load"] as const) {
    const { f, deps, io, options, writes } = fixture();
    if (phase === "identity") io.identity = () => { throw new Error("fixture"); };
    else (io as any)[phase] = async () => { throw new Error("fixture"); };
    const r = await f.clock.drive(runDaemonBench(deps, options, () => {}, io));
    expect(r.acceptance.status).toBe("FAIL"); expect(r.errors.length).toBeGreaterThan(0); expect(writes.size).toBe(2);
    expect(f.clock.timers.size).toBe(0);
  }
});

test("persistence failure emits the full failed report without losing samples", async () => {
  const { f, deps, io, options } = fixture(); const emitted: string[] = [];
  io.write = async () => { throw new Error("disk full"); };
  const r = await f.clock.drive(runDaemonBench(deps, options, line => emitted.push(line), io));
  expect(r.acceptance.status).toBe("FAIL"); expect(r.errors).toContain("report persistence failed");
  const fallback = JSON.parse(emitted[emitted.length - 1]); expect(fallback.observe.loopLag.records.length).toBeGreaterThan(0);
});

test("missing listen marker is unknown and drift remains visible", async () => {
  const { f, deps, io, options, context } = fixture(); let observations = 0;
  io.context = async () => { const row = structuredClone(context); if (++observations > 1) { row.runtime.pid = 999; row.source.commit = "other"; } return row; };
  const r = await f.clock.drive(runDaemonBench(deps, options, () => {}, io));
  expect(r.log!.boots).toEqual([]); expect(r.acceptance.reasons).toContain("runtime identity drift or missing");
  expect(r.acceptance.reasons).toContain("source manifest drift or missing");
  expect(r.acceptance.status).not.toBe("PASS");
});
