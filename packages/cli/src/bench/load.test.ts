import { describe, expect, test } from "bun:test";
import { runLoadBench, measurementFailures, ownedHookUrl, exportedToken, benchPost, MAX_BENCH_FIXTURES } from "./load.js";
import { MAX_BENCH_RECORDS, MAX_BENCH_TIMER_MS } from "./probes.js";
import { fakeLoad, loadDeps, loadOptions } from "./testFixtures.js";

const run = (f = fakeLoad(), options = loadOptions) => f.clock.drive(runLoadBench(loadDeps, options, () => {}, f.io));

test("production orchestrator keeps churn and route probes active during delivery and retains all records", async () => {
  const f = fakeLoad(); const r = await run(f);
  expect(r.spawned).toBe(2); expect(r.mapped).toBe(2);
  expect(r.startup[0].mappedAt! - r.startup[0].startedAt).toBe(40);
  expect(r.mappingMs.n).toBe(2);
  expect(r.roundTrips[0].echoed.outcome).toBe("ok");
  const trip = r.roundTrips[0];
  expect(f.calls.some(c => c.name === "append" && c.at >= trip.injected.startedAt! && c.at <= trip.echoed.finishedAt!)).toBe(true);
  expect(r.loopLag!.records.length).toBe(r.loopLag!.expected);
  expect(r.loopLag!.samples.length).toBeGreaterThan(0);
  expect(r.churn.rounds.length).toBe(r.churn.expectedRounds);
  expect(measurementFailures(r)).toEqual([]);
  expect(r.acceptance.status).toBe("NOT ESTABLISHED");
  expect(f.clean).toEqual(["fixture-0", "fixture-1"]);
  expect(f.clock.timers.size).toBe(0);
});

test("negative old sequential ordering is rejected with unchanged successful percentiles", async () => {
  const r = await run(); const original = r.echoedMs;
  for (const trip of r.roundTrips) for (const leg of [trip.up, trip.injected, trip.echoed]) { leg.startedAt! += r.window!.end; leg.finishedAt! += r.window!.end; }
  expect(measurementFailures(r)).toContain("delivery/churn/route overlap unproven");
  expect(r.echoedMs).toEqual(original);
});

test("SLO boundary uses >=1000 health and >=50 terminal; missing samples never pass", async () => {
  const good = await run();
  const r = structuredClone(good); r.loopLag!.summary.over1s = 1; r.loopLag!.summary.max = 1000;
  expect(measurementFailures(r)).toContain("health RTT >=1000ms");
  r.termSessions!.summary.p99 = 50;
  expect(measurementFailures(r)).toContain("terminal p99 >=50ms or missing");
  r.roundTrips[0].echoed.outcome = "timeout";
  expect(measurementFailures(r)).toContain("delivery incomplete");
  r.loopLag!.records.pop(); expect(measurementFailures(r)).toContain("health missing or failed slots");
  r.after!.pid = 456; expect(measurementFailures(r)).toContain("runtime changed or unobserved");
});

describe("failure and cleanup matrix through actual runLoadBench", () => {
  for (const fail of ["prepare", "allocate", "spawn", "mapping", "append", "verify", "pause", "hasToken", "/cli/export", "/cli/messages/send", "route", "cleanup", "finish", "/cli/conversations/delete-by-path"]) test(fail, async () => {
    const f = fakeLoad(); f.setFail(fail);
    const r = await run(f);
    expect(r.acceptance.status).toBe("FAIL");
    expect(r.roundTrips.length).toBe(loadOptions.sample);
    expect(r.failures.length + r.teardown.warnings.length + (r.loopLag?.errors ?? 0)).toBeGreaterThan(0);
    expect(f.calls.some(c => c.name === "cleanup") || f.fixture.fixtures.length === 0).toBe(true);
    expect(f.clock.timers.size).toBe(0);
  });
  test("partial spawn retains failed fixture and exact cleanup population", async () => {
    const f = fakeLoad(); f.setHook((name, row) => { if (name === "spawn" && row?.sessionId === "fixture-1") throw new Error("second spawn"); });
    const r = await run(f);
    expect(r.spawned).toBe(1); expect(r.spawnErrors).toEqual(["fixture-1"]);
    expect(r.startup).toHaveLength(2); expect(f.clean).toHaveLength(2);
    expect(r.acceptance.status).toBe("FAIL");
  });
  for (const changed of ["session_id", "git_root"]) test(`wrong backend ${changed} refuses send and owned hooks`, async () => {
    const f = fakeLoad(); const post = f.io.post;
    f.io.post = async (...args) => { const r = await post(...args); if (args[0] === "/cli/export") r.conversation[changed] = "someone-else"; return r; };
    const r = await run(f); expect(r.mapped).toBe(0);
    expect(f.calls.some(c => c.name === "/cli/messages/send" || c.name === "route")).toBe(false);
    expect(r.acceptance.status).toBe("FAIL");
  });
  test("missing auth acquires no fixture and still returns failure report", async () => {
    const f = fakeLoad(); const r = await run(f, { ...loadOptions, authHeaders: null });
    expect(r.acceptance.status).toBe("FAIL"); expect(f.fixture.fixtures).toHaveLength(0); expect(f.calls).toEqual([]);
  });
  test("keep is diagnostic; bounded deletion cannot hide hasMore", async () => {
    const keep = fakeLoad(); const r = await run(keep, { ...loadOptions, keep: true }); expect(r.teardown.verified).toBe(false);
    expect(r.acceptance.status).toBe("FAIL");
    const f = fakeLoad(); const post = f.io.post;
    f.io.post = async (...args) => args[0].includes("delete-by-path") ? { conversationsDeleted: 0, hasMore: true } : post(...args);
    const failed = await run(f); expect(failed.teardown.verified).toBe(false); expect(failed.teardown.warnings.some(w => w.startsWith("backend or file cleanup incomplete"))).toBe(true);
  });
});

for (const event of ["SIGINT", "SIGTERM", "timeout"] as const) for (const phase of ["prepare", "allocate", "spawn", "mapping", "append", "pause", "/cli/messages/send", "cleanup"]) test(`${event} at ${phase} settles all work and preserves requested legs`, async () => {
  const f = fakeLoad(); const abort = new AbortController(); let triggered = false;
  f.setHook(name => {
    if (name !== phase || triggered) return; triggered = true;
    if (event === "timeout") abort.abort(new DOMException("fixture deadline", "TimeoutError")); else process.emit(event);
  });
  const initial = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const r = await run(f, { ...loadOptions, signal: abort.signal });
  expect(triggered).toBe(true); expect(r.roundTrips).toHaveLength(1); expect(f.clock.timers.size).toBe(0);
  expect(process.listenerCount("SIGINT")).toBe(initial[0]); expect(process.listenerCount("SIGTERM")).toBe(initial[1]);
  expect(f.calls.filter(c => c.name === "cleanup").length).toBe(f.fixture.fixtures.length);
  if (phase !== "cleanup") expect(r.acceptance.status).toBe("FAIL");
});

test("owned hook URL matches real GET contract and rejects forged objects", async () => {
  const f = fakeLoad(); const row = f.fixture.allocate(); row.created = true; row.pid = 42; row.conversationId = "conv";
  const url = new URL(await ownedHookUrl(1, f.fixture, row, f.clock, new AbortController().signal));
  expect(Object.fromEntries(url.searchParams)).toEqual({ session_id: row.sessionId, status: "working", message: row.lastHook!.message, ts: String(Math.floor(f.clock.wall() / 1000)), transcript_path: row.jsonlPath });
  await expect(ownedHookUrl(1, f.fixture, { ...row }, f.clock, new AbortController().signal)).rejects.toThrow("unowned");
});

test("export pagination refuses malformed/nonadvancing pages and preserves HTTP failure", async () => {
  await expect(exportedToken(async () => ({ conversation: {}, messages: [], next_cursor: "same" }), "c", "t", "user", new AbortController().signal)).rejects.toThrow("cursor");
  await expect(benchPost("http://127.0.0.1", "secret", async () => new Response("not ok", { status: 503 }))("/cli/export", {}, new AbortController().signal)).rejects.toThrow("HTTP 503");
});

for (const value of [NaN, Infinity, 0]) test(`invalid measurement duration ${value} acquires nothing`, async () => {
  const f = fakeLoad(); const r = await run(f, { ...loadOptions, durationMs: value });
  expect(r.acceptance.status).toBe("FAIL"); expect(f.fixture.fixtures).toHaveLength(0); expect(f.calls).toEqual([]);
});

for (const options of [
  { sample: Infinity }, { sample: NaN }, { sample: -1 }, { sample: 1.5 }, { sample: Number.MAX_SAFE_INTEGER },
  { n: Infinity }, { n: MAX_BENCH_FIXTURES + 1 }, { n: Number.MAX_SAFE_INTEGER, sample: Number.MAX_SAFE_INTEGER },
  { churnIntervalMs: Number.MIN_VALUE }, { churnIntervalMs: loadOptions.durationMs / (MAX_BENCH_RECORDS + 1) },
  { durationMs: Number.MAX_VALUE }, { durationMs: MAX_BENCH_TIMER_MS, totalTimeoutMs: undefined },
]) test(`computed bounds refuse ${Object.entries(options).map(([key, value]) => `${key}=${String(value)}`).join(",")} before fixture factory or timer`, async () => {
  const f = fakeLoad(); let factories = 0, timers = 0;
  f.io.fixture = () => { factories++; return f.fixture; };
  const sleep = f.clock.sleep; f.clock.sleep = (...args) => { timers++; return sleep(...args); };
  const r = await run(f, { ...loadOptions, ...options });
  expect(r.acceptance.status).toBe("FAIL"); expect(r.failures[0].reason).toContain("invalid load bounds");
  expect(r.roundTrips).toEqual([]); expect(r.churn.expectedRounds).toBe(0);
  expect(factories).toBe(0); expect(timers).toBe(0); expect(f.calls).toEqual([]);
});

test("bounded N200 measurement shape reaches preparation with its full requested sample", async () => {
  const f = fakeLoad(); const abort = new AbortController();
  f.setHook(name => { if (name === "prepare") abort.abort(); });
  const r = await run(f, { ...loadOptions, n: 200, sample: 10, durationMs: 120000, churnIntervalMs: 2000, signal: abort.signal });
  expect(f.calls[0].name).toBe("prepare"); expect(r.roundTrips).toHaveLength(10); expect(r.churn.expectedRounds).toBe(60);
  expect(r.failures.some(f => f.reason.includes("invalid load bounds"))).toBe(false); expect(f.clock.timers.size).toBe(0);
});

test("fixture factory failure retains bounded requested legs in the report", async () => {
  const f = fakeLoad(); f.io.fixture = () => { throw new Error("factory failure"); };
  const r = await run(f);
  expect(r.acceptance.status).toBe("FAIL"); expect(r.roundTrips).toHaveLength(loadOptions.sample);
  expect(r.failures[0].reason).toContain("factory failure"); expect(f.clock.timers.size).toBe(0); expect(f.calls).toEqual([]);
});

for (const mode of ["healthy", "cancel", "late-join", "late-synchronous"]) test(`cleanup finish ${mode} receives its budget and settles before reporting`, async () => {
  const f = fakeLoad(); let received: AbortSignal | undefined, started = 0, finished = 0, settled = false;
  f.fixture.finish = async signal => {
    received = signal; started = f.clock.now();
    try {
      if (mode === "late-synchronous") f.clock.time += 20000;
      else await f.clock.sleep(mode === "healthy" ? 5 : 20000, mode === "late-join" ? undefined : signal);
    } finally { finished = f.clock.now(); settled = true; }
  };
  const r = await run(f);
  expect(received).toBeDefined(); expect(settled).toBe(true);
  expect(finished - started).toBe(mode === "healthy" ? 5 : mode === "cancel" ? 11990 : 20000);
  expect(r.teardown.verified).toBe(mode === "healthy");
  expect(r.acceptance.status).toBe(mode === "healthy" ? "NOT ESTABLISHED" : "FAIL");
  if (mode !== "healthy") expect(r.teardown.warnings.some(w => w.includes("cleanup deadline"))).toBe(true);
  expect(f.clock.timers.size).toBe(0);
});
