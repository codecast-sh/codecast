import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BenchFixture, childProcess } from "./fixture.js";
import { runLoadBench } from "./load.js";
import { startFakeHttp } from "./httpFixture.js";
import { loadDeps, runtimeIdentity } from "./testFixtures.js";

test("actual load bench uses private tmux doctor stubs, independent HTTP and exact verified cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl497-g-http-"));
  const socket = path.join(root, "tmux.sock");
  const http = await startFakeHttp(root, socket);
  let fixture: BenchFixture;
  try {
    const report = await runLoadBench({ ...loadDeps, configDir: root, siteUrl: `http://127.0.0.1:${http.port}`, apiToken: "private-integration-api", observeRuntime: async () => ({ ...runtimeIdentity, pid: http.child.pid! }) }, { n: 2, sample: 1, durationMs: 2400, churnIntervalMs: 200, keep: false, port: http.port, authHeaders: { Authorization: "Bearer private-integration-term" }, pollMs: 50, mappingTimeoutMs: 5000, totalTimeoutMs: 15000 }, () => {}, { fixture: id => fixture = new BenchFixture(id, loadDeps.config, root, { home: root, projectDir: root, socket }) });
    console.log("PRIVATE INTEGRATION REPORT", JSON.stringify(report));
    expect(report.spawned).toBe(2); expect(report.mapped).toBe(2);
    expect(report.failures).toEqual([]); expect(report.teardown.warnings).toEqual([]);
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
