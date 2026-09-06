import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BenchFixture, childProcess } from "./fixture.js";
import { runLoadBench } from "./load.js";
import { startFakeHttp } from "./httpFixture.js";
import { loadDeps } from "./testFixtures.js";
import { benchClock, deadlineSignal } from "./probes.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

async function cleanupFixture(fixture: BenchFixture) {
  const deadline = deadlineSignal(benchClock, performance.now() + 15000);
  try {
    const errors: unknown[] = [];
    for (const row of fixture.fixtures) {
      try { await fixture.cleanup(row, deadline.signal); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `retained private fixture resources: ${fixture.scratch}`);
    await fixture.finish(deadline.signal);
  } finally { await deadline.close(); }
}

test("actual load bench uses private tmux doctor stubs, independent HTTP and exact verified cleanup", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pl497-g-http-")));
  const socket = path.join(root, "tmux.sock");
  let http: Awaited<ReturnType<typeof startFakeHttp>> | undefined;
  let fixture: BenchFixture | undefined;
  let fixtureClean = false;
  try {
    const endpoint = await startFakeHttp(root, socket); http = endpoint;
    const observeRuntime = async () => {
      const identity = await fetch(`http://127.0.0.1:${endpoint.port}/identity`).then(r => r.json()) as { pid: number; runtime: string; build: string };
      const processIdentity = (await childProcess("ps", ["-p", String(identity.pid), "-o", "pid=,uid=,lstart=,comm="])).trim();
      return { ...identity, processIdentity, workerSetting: null, workerRouting: "independent fake HTTP endpoint; no daemon workers", configHash: null };
    };
    const report = await runLoadBench({ ...loadDeps, configDir: root, siteUrl: `http://127.0.0.1:${endpoint.port}`, apiToken: "private-integration-api", getDaemonPid: () => endpoint.child.pid ?? null, observeRuntime }, { n: 2, sample: 1, durationMs: 2400, churnIntervalMs: 200, keep: false, port: endpoint.port, authHeaders: { Authorization: "Bearer private-integration-term" }, pollMs: 50, mappingTimeoutMs: 5000, totalTimeoutMs: 15000 }, () => {}, { fixture: id => fixture = new BenchFixture(id, loadDeps.config, root, { home: root, projectDir: root, socket }) });
    fixtureClean = report.teardown.verified;
    console.log("PRIVATE INTEGRATION REPORT", JSON.stringify(report));
    expect(report.before).toEqual(report.after);
    expect(report.before!.pid).toBe(endpoint.child.pid!);
    expect(report.before!.runtime).toMatch(/^v[0-9]+/);
    expect(report.before!.build).toMatch(/^[a-f0-9]{64}$/);
    expect(report.spawned).toBe(2); expect(report.mapped).toBe(2);
    expect(report.failures.every(f => ["churn", "probes"].includes(f.phase))).toBe(true);
    const probes = [report.loopLag!, report.hookStatus!, report.termSessions!];
    for (const probe of probes) expect(probe.records.length).toBe(probe.expected);
    const missed = probes.some(p => p.records.some(slot => slot.outcome !== "ok"));
    if (missed || report.failures.length) expect(report.acceptance.status).toBe("FAIL");
    expect(report.teardown.warnings).toEqual([]);
    expect(report.teardown.verified).toBe(true); expect(report.teardown.conversationsDeleted).toBe(2);
    expect(report.roundTrips[0].up.outcome).toBe("ok"); expect(report.roundTrips[0].injected.outcome).toBe("ok"); expect(report.roundTrips[0].echoed.outcome).toBe("ok");
    expect(report.hookStatus!.statuses["200"]).toBeGreaterThan(0);
    expect(report.resources.every(f => f.transcriptVerified && f.transcriptLines! >= 2)).toBe(true);
    const events = await fetch(`http://127.0.0.1:${endpoint.port}/events`).then(r => r.json()) as { hooks: { session_id: string; pid: number }[]; records: unknown[] };
    expect(events.records).toEqual([]);
    expect(events.hooks.length).toBeGreaterThan(0);
    for (const hook of events.hooks) expect(report.resources.some(f => f.sessionId === hook.session_id && f.pid === hook.pid)).toBe(true);
    for (const f of report.resources) {
      expect(await fs.stat(f.jsonlPath).then(() => true, () => false)).toBe(false);
      expect(await fs.stat(f.registryPath).then(() => true, () => false)).toBe(false);
      expect(await fs.stat(f.statusPath).then(() => true, () => false)).toBe(false);
      await expect(childProcess("ps", ["-p", String(f.pid), "-o", "pid="])).rejects.toThrow();
    }
    expect(await fs.stat(report.scratchDir).then(() => true, () => false)).toBe(false);
  } finally {
    try { if (fixture && !fixtureClean) await cleanupFixture(fixture); }
    finally { await http?.close(); }
    const left = await fs.readdir(path.join(root, "session-registry")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    if (left.length) throw new Error(`retained failed fixture resources at ${root}: ${left.join(",")}`);
    await fs.rm(root, { recursive: true });
  }
}, 25000);

test("childProcess abort kills only its owned child and waits for exit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl497-g-abort-"));
  const file = path.join(root, "owned.cjs"); const pidFile = path.join(root, "pid");
  const abort = new AbortController();
  let sentinel: Awaited<ReturnType<typeof startFakeHttp>> | undefined;
  let settled: Promise<string> | undefined;
  try {
    await fs.writeFile(file, `require('fs').writeFileSync(process.argv[2], String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`);
    sentinel = await startFakeHttp(root, path.join(root, "unused.sock"));
    settled = childProcess("node", [file, pidFile], abort.signal).then(() => "success", e => e.name);
    const deadline = Date.now() + 5000;
    while (!await fs.stat(pidFile).then(() => true, () => false)) { if (Date.now() >= deadline) throw new Error("owned child not ready"); await new Promise(r => setTimeout(r, 10)); }
    const pid = Number(await fs.readFile(pidFile, "utf8")); abort.abort();
    expect(await settled).toBe("AbortError");
    await expect(childProcess("ps", ["-p", String(pid), "-o", "pid="])).rejects.toThrow();
    expect((await fetch(`http://127.0.0.1:${sentinel.port}/health`)).status).toBe(200);
  } finally { abort.abort(); await settled; await sentinel?.close(); await fs.rm(root, { recursive: true }); }
}, 15000);

for (const key of ["jsonlPath", "registryPath", "statusPath"] as const) test(`cleanup refuses a replaced ${key} at its removal boundary`, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bench-replacement-")));
  let target = "", replaced = false;
  const fixture = new BenchFixture(`bench-${crypto.randomUUID()}`, loadDeps.config, root, { home: root, projectDir: root, socket: path.join(root, "tmux.sock"), beforeRemove: async file => {
    if (file !== target || replaced) return;
    replaced = true;
    const raw = await fs.readFile(file); await fs.rename(file, `${file}.acquired`); await fs.writeFile(file, raw, { flag: "wx" });
  } });
  try {
    await fixture.prepare(AbortSignal.timeout(5000));
    const row = fixture.allocate(); await fixture.spawn(row, AbortSignal.timeout(5000)); target = row[key];
    if (key === "statusPath") {
      const stamp = { message: "exact private cleanup token", ts: 123 };
      await fixture.recordHook(row, stamp); await fs.mkdir(path.dirname(row.statusPath), { recursive: true });
      await fs.writeFile(row.statusPath, JSON.stringify({ ...stamp, transcript_path: row.jsonlPath }), { flag: "wx" });
    }
    await expect(fixture.cleanup(row, AbortSignal.timeout(5000))).rejects.toThrow("removal identity changed");
    expect(replaced).toBe(true); expect((await fs.lstat(target)).ino).not.toBe((await fs.lstat(`${target}.acquired`)).ino);
    await fs.unlink(target); await fs.rename(`${target}.acquired`, target);
  } finally { await cleanupFixture(fixture); await fs.rm(root, { recursive: true }); }
}, 15000);

test("failure before the second spawn still cleans the first acquired stub", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bench-partial-")));
  const fixture = new BenchFixture(`bench-${crypto.randomUUID()}`, loadDeps.config, root, { home: root, projectDir: root, socket: path.join(root, "tmux.sock") });
  let firstPid: number | undefined;
  let cleanupComplete = false;
  try {
    await expect((async () => {
      try {
        await fixture.prepare(AbortSignal.timeout(5000));
        const first = fixture.allocate(); await fixture.spawn(first, AbortSignal.timeout(5000)); firstPid = first.pid;
        const cancelled = new AbortController(); cancelled.abort();
        await fixture.spawn(fixture.allocate(), cancelled.signal);
      } finally { await cleanupFixture(fixture); cleanupComplete = true; }
    })()).rejects.toThrow();
    expect(cleanupComplete).toBe(true);
    expect(firstPid).toBeGreaterThan(1);
    await expect(childProcess("ps", ["-p", String(firstPid), "-o", "pid="])).rejects.toThrow();
    expect(await fs.stat(fixture.scratch).then(() => true, () => false)).toBe(false);
  } finally { if (cleanupComplete) await fs.rm(root, { recursive: true }); }
}, 15000);

for (const failure of ["exit", "timeout"]) test(`HTTP startup ${failure} joins its exact child before rejection`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-http-failure-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  let closed = false;
  let joined = Promise.resolve();
  try {
    const entrypoint = path.join(root, "failed-http.cjs");
    await fs.writeFile(entrypoint, failure === "exit" ? "process.exit(2)" : "process.stdin.resume()", { flag: "wx" });
    await expect(startFakeHttp(root, path.join(root, "unused.sock"), { entrypoint, startupTimeoutMs: failure === "exit" ? 5000 : 250, onSpawn: value => {
      children.push(value); joined = new Promise(resolve => value.once("close", () => { closed = true; resolve(); }));
    } })).rejects.toThrow(failure === "exit" ? "fake HTTP exited" : "fake HTTP startup failed");
    expect(closed).toBe(true);
    await expect(childProcess("ps", ["-p", String(children[0].pid), "-o", "pid="])).rejects.toThrow();
  } finally { if (children[0] && !closed) children[0].kill("SIGKILL"); await joined; await fs.rm(root, { recursive: true }); }
}, 10000);

test("real fixture custody refuses changed PID, registry and foreign handle without harming its sibling", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pl497-g-custody-")));
  const fixture = new BenchFixture(`bench-${crypto.randomUUID()}`, loadDeps.config, root, { home: root, projectDir: root, socket: path.join(root, "tmux.sock") });
  const signal = AbortSignal.timeout(10000);
  try {
    await fixture.prepare(signal);
    const first = fixture.allocate(), sibling = fixture.allocate();
    await fixture.spawn(first, signal); await fixture.spawn(sibling, signal);
    first.created = false;
    await expect(fixture.cleanup(first, signal)).rejects.toThrow("partial spawn with unknown custody");
    first.created = true;
    const pid = first.pid; first.pid = sibling.pid;
    await expect(fixture.verify(first, signal)).rejects.toThrow("custody changed");
    await expect(fixture.cleanup(first, signal)).rejects.toThrow("custody changed");
    first.pid = pid;
    await fixture.verify(sibling, signal);
    const registry = await fs.readFile(first.registryPath, "utf8");
    await fs.writeFile(first.registryPath, JSON.stringify({ pid: sibling.pid, term: "tmux" }));
    await expect(fixture.cleanup(first, signal)).rejects.toThrow("registry changed");
    await fs.writeFile(first.registryPath, registry);
    await expect(fixture.cleanup({ ...first }, signal)).rejects.toThrow("ownership refused");
    const saved = `${first.jsonlPath}.owned-backup`;
    const siblingBefore = await fs.readFile(sibling.jsonlPath, "utf8");
    await fs.rename(first.jsonlPath, saved);
    try {
      await fs.symlink(sibling.jsonlPath, first.jsonlPath);
      await expect(fixture.append(first, "must not reach sibling", signal)).rejects.toThrow();
    } finally { await fs.unlink(first.jsonlPath); await fs.rename(saved, first.jsonlPath); }
    expect(await fs.readFile(sibling.jsonlPath, "utf8")).toBe(siblingBefore);
    await fixture.verify(first, signal); await fixture.verify(sibling, signal);
    process.kill(first.pid!, "SIGKILL");
    const stoppedBy = Date.now() + 5000;
    for (;;) {
      const live = await childProcess("ps", ["-p", String(first.pid), "-o", "pid="]).then(() => true, () => false);
      if (!live) break;
      if (Date.now() >= stoppedBy) throw new Error("owned crashed stub did not exit");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await fixture.verify(sibling, signal);
  } finally {
    await cleanupFixture(fixture);
    await fs.rm(root, { recursive: true });
  }
}, 15000);
