import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BenchFixture, childProcess } from "./fixture.js";
import { runLoadBench } from "./load.js";
import { startFakeHttp } from "./httpFixture.js";
import { loadDeps } from "./testFixtures.js";

test("actual load bench uses private tmux doctor stubs, independent HTTP and exact verified cleanup", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pl497-g-http-")));
  const socket = path.join(root, "tmux.sock");
  const http = await startFakeHttp(root, socket);
  let fixture: BenchFixture;
  const observeRuntime = async () => {
    const identity = await fetch(`http://127.0.0.1:${http.port}/identity`).then(r => r.json()) as { pid: number; runtime: string; build: string };
    const processIdentity = (await childProcess("ps", ["-p", String(identity.pid), "-o", "pid=,uid=,lstart=,comm="])).trim();
    return { ...identity, processIdentity, workerSetting: null, workerRouting: "independent fake HTTP endpoint; no daemon workers", configHash: null };
  };
  try {
    const report = await runLoadBench({ ...loadDeps, configDir: root, siteUrl: `http://127.0.0.1:${http.port}`, apiToken: "private-integration-api", getDaemonPid: () => http.child.pid ?? null, observeRuntime }, { n: 2, sample: 1, durationMs: 2400, churnIntervalMs: 200, keep: false, port: http.port, authHeaders: { Authorization: "Bearer private-integration-term" }, pollMs: 50, mappingTimeoutMs: 5000, totalTimeoutMs: 15000 }, () => {}, { fixture: id => fixture = new BenchFixture(id, loadDeps.config, root, { home: root, projectDir: root, socket }) });
    console.log("PRIVATE INTEGRATION REPORT", JSON.stringify(report));
    expect(report.before).toEqual(report.after);
    expect(report.before!.pid).toBe(http.child.pid!);
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
    const events = await fetch(`http://127.0.0.1:${http.port}/events`).then(r => r.json()) as { hooks: { session_id: string; pid: number }[]; records: unknown[] };
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
    await http.close();
    const left = await fs.readdir(path.join(root, "session-registry")).catch(() => []);
    if (left.length) throw new Error(`retained failed fixture resources at ${root}: ${left.join(",")}`);
    await fs.rm(root, { recursive: true });
  }
}, 25000);

test("childProcess abort kills only its owned child and waits for exit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl497-g-abort-"));
  const file = path.join(root, "owned.cjs"); const pidFile = path.join(root, "pid");
  await fs.writeFile(file, `require('fs').writeFileSync(process.argv[2], String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`);
  const sentinel = await startFakeHttp(root, path.join(root, "unused.sock"));
  const abort = new AbortController();
  const owned = childProcess("node", [file, pidFile], abort.signal);
  const settled = owned.then(() => "success", e => e.name);
  try {
    const deadline = Date.now() + 5000;
    while (!await fs.stat(pidFile).then(() => true, () => false)) { if (Date.now() >= deadline) throw new Error("owned child not ready"); await new Promise(r => setTimeout(r, 10)); }
    const pid = Number(await fs.readFile(pidFile, "utf8")); abort.abort();
    expect(await settled).toBe("AbortError");
    await expect(childProcess("ps", ["-p", String(pid), "-o", "pid="])).rejects.toThrow();
    expect((await fetch(`http://127.0.0.1:${sentinel.port}/health`)).status).toBe(200);
  } finally { abort.abort(); await settled; await sentinel.close(); await fs.rm(root, { recursive: true }); }
}, 15000);

test("real fixture custody refuses changed PID, registry and foreign handle without harming its sibling", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pl497-g-custody-")));
  const fixture = new BenchFixture(`bench-${crypto.randomUUID()}`, loadDeps.config, root, { home: root, projectDir: root, socket: path.join(root, "tmux.sock") });
  const signal = AbortSignal.timeout(10000);
  await fixture.prepare(signal);
  const first = fixture.allocate(), sibling = fixture.allocate();
  await fixture.spawn(first, signal); await fixture.spawn(sibling, signal);
  try {
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
    await fixture.cleanup(first, signal); await fixture.cleanup(sibling, signal); await fixture.finish();
    await fs.rm(root, { recursive: true });
  }
}, 15000);
