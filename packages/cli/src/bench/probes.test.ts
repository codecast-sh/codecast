import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFakeHttp } from "./httpFixture.js";
import { FakeClock } from "./testFixtures.js";
import { benchClock, runRouteProbes } from "./probes.js";
import { readLoopbackIdentity, localAuthHeaders, runLoopLagProbe, runLatencyProbe } from "./probes.js";

describe("readLoopbackIdentity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-identity-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("no hook-port means no port", () => {
    expect(readLoopbackIdentity(dir)).toEqual({ port: null, token: null, reason: "hook-port missing" });
  });

  test("missing identity file", () => {
    fs.writeFileSync(path.join(dir, "hook-port"), "40123\n");
    expect(readLoopbackIdentity(dir)).toEqual({ port: 40123, token: null, reason: "missing" });
  });

  test("port mismatch marks the token stale", () => {
    fs.writeFileSync(path.join(dir, "loopback-identity.json"), JSON.stringify({ port: 40124, token: "t", pid: process.pid }));
    expect(readLoopbackIdentity(dir)).toEqual({ port: 40123, token: null, reason: "port mismatch" });
  });

  test("dead pid marks the token stale", () => {
    fs.writeFileSync(path.join(dir, "loopback-identity.json"), JSON.stringify({ port: 40123, token: "t", pid: 2 ** 22 - 1 }));
    expect(readLoopbackIdentity(dir).reason).toBe("pid not alive");
  });

  test("matching port and live pid yields the token", () => {
    fs.writeFileSync(path.join(dir, "loopback-identity.json"), JSON.stringify({ port: 40123, token: "secret", pid: process.pid }));
    expect(readLoopbackIdentity(dir)).toEqual({ port: 40123, token: "secret", reason: null });
  });
});

test("localAuthHeaders is the loopback origin plus the bearer token", () => {
  expect(localAuthHeaders(5, "abc")).toEqual({ Origin: "http://127.0.0.1:5", Authorization: "Bearer abc" });
});


test("fixed probe denominator records tester stalls without catch-up bursts", async () => {
  const clock = new FakeClock(); let calls = 0;
  const r = await clock.drive(runLatencyProbe({ url: "http://private/health", durationMs: 1000, intervalMs: 100, clock, fetch: async () => { if (calls++ === 0) clock.time += 450; return new Response("ok"); } }));
  expect(r.expected).toBe(10); expect(r.records).toHaveLength(10);
  expect(r.missing).toBe(3); expect(r.attempted).toBe(7);
  expect(r.records[1].latenessMs).toBe(350);
  expect(clock.timers.size).toBe(0);
});

test("inflight overload, timeout and failed status keep full denominator", async () => {
  const clock = new FakeClock();
  const r = await clock.drive(runLatencyProbe({ url: "http://private/health", durationMs: 1000, intervalMs: 100, maxInFlight: 1, requestTimeoutMs: 250, clock, fetch: async (_url, init) => { await clock.sleep(2000, init.signal!); return new Response("ok"); } }));
  expect(r.expected).toBe(10); expect(r.records).toHaveLength(10);
  expect(r.timeouts).toBeGreaterThan(0); expect(r.skipped).toBeGreaterThan(0); expect(r.summary.n).toBe(0); expect(clock.timers.size).toBe(0);
  const bad = await clock.drive(runLatencyProbe({ url: "http://private/bad", durationMs: 200, intervalMs: 100, clock, fetch: async () => new Response("bad", { status: 503 }) }));
  expect(bad.errors).toBe(2); expect(bad.statuses["503"]).toBe(2); expect(bad.summary.n).toBe(0);
});

test("abort settles outstanding transport and marks every remaining slot", async () => {
  const clock = new FakeClock(); const abort = new AbortController(); let pending = 0;
  const work = runLatencyProbe({ url: "http://private/hang", durationMs: 5000, clock, signal: abort.signal, fetch: async (_url, init) => {
    pending++; try { await clock.sleep(5000, init.signal!); return new Response("ok"); } finally { pending--; }
  } });
  await Promise.resolve(); abort.abort();
  const r = await clock.drive(work); expect(r.cancelled).toBe(r.expected); expect(pending).toBe(0); expect(clock.timers.size).toBe(0);
});

describe("independent fake HTTP server", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof startFakeHttp>>;
  beforeAll(async () => { root = fs.mkdtempSync(path.join(os.tmpdir(), "pl497-g-probes-")); server = await startFakeHttp(root, path.join(root, "unused.sock")); });
  afterAll(async () => { await server.close(); fs.rmSync(root, { recursive: true }); });
  test("real server stall remains visible at >=1s", async () => {
    await fetch(`http://127.0.0.1:${server.port}/stall-next`);
    const r = await runLoopLagProbe({ port: server.port, durationMs: 1700, intervalMs: 100, maxInFlight: 20 });
    expect(r.summary.over1s).toBeGreaterThanOrEqual(1); expect(r.summary.max!).toBeGreaterThanOrEqual(1000);
    expect(r.records).toHaveLength(r.expected); expect(r.errors).toBe(0); expect(r.timeouts).toBe(0);
  }, 5000);
  test("deliberate tester stall is reported as missing scheduled slots", async () => {
    let first = true;
    const r = await runLatencyProbe({ url: `http://127.0.0.1:${server.port}/health`, durationMs: 800, intervalMs: 100, fetch: async (url, init) => {
      if (first) { first = false; const until = performance.now() + 350; while (performance.now() < until) {} }
      return fetch(url, init);
    } });
    expect(r.missing).toBeGreaterThanOrEqual(2); expect(r.records).toHaveLength(r.expected); expect(r.lateness.max!).toBeGreaterThanOrEqual(200);
  }, 5000);
  test("real hanging requests abort promptly; healthy and dispatch-only routes retain distinct statuses", async () => {
    const abort = new AbortController(); const started = performance.now();
    const work = runLatencyProbe({ url: `http://127.0.0.1:${server.port}/hang`, durationMs: 5000, signal: abort.signal });
    await benchClock.sleep(20); abort.abort();
    const r = await work; expect(performance.now() - started).toBeLessThan(1000); expect(r.cancelled).toBe(r.expected);
    const probes = await runRouteProbes({ port: server.port, durationMs: 250, authHeaders: { Authorization: "Bearer private-integration-term" } });
    expect(probes.loopLag.errors).toBe(0); expect(probes.hookStatus.label).toContain("invalid hook dispatch"); expect(probes.hookStatus.statuses["400"]).toBe(1);
    expect(probes.termSessions!.statuses["200"]).toBe(1);
  }, 5000);
});
