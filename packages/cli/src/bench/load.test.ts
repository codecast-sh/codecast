import { describe, expect, test } from "bun:test";
import { runLoadBench, measurementFailures, ownedHookUrl, exportedToken, benchPost } from "./load.js";
import { fakeLoad, loadDeps, loadOptions } from "./testFixtures.js";

const run = (f = fakeLoad(), options = loadOptions) => f.clock.drive(runLoadBench(loadDeps, options, () => {}, f.io));

test("production orchestrator keeps churn and route probes active during delivery and retains all records", async () => {
  const f = fakeLoad(); const r = await run(f);
  expect(r.spawned).toBe(2); expect(r.mapped).toBe(2);
  expect(r.startup[0].mappedAt! - r.startup[0].startedAt).toBe(30);
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
  r.after!.pid++; expect(measurementFailures(r)).toContain("runtime changed or unobserved");
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
  test("wrong backend conversation mapping refuses send and owned hooks", async () => {
    const f = fakeLoad(); const post = f.io.post;
    f.io.post = async (...args) => { const r = await post(...args); if (args[0] === "/cli/export") r.conversation.session_id = "someone-else"; return r; };
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
    const failed = await run(f); expect(failed.teardown.verified).toBe(false); expect(failed.teardown.warnings).toContain("backend or file cleanup incomplete");
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
  expect(Object.fromEntries(url.searchParams)).toEqual({ session_id: row.sessionId, status: "working", ts: String(Math.floor(f.clock.wall() / 1000)), transcript_path: row.jsonlPath });
  await expect(ownedHookUrl(1, f.fixture, { ...row }, f.clock, new AbortController().signal)).rejects.toThrow("unowned");
});

test("export pagination refuses malformed/nonadvancing pages and preserves HTTP failure", async () => {
  await expect(exportedToken(async () => ({ conversation: {}, messages: [], next_cursor: "same" }), "c", "t", "user", new AbortController().signal)).rejects.toThrow("cursor");
  await expect(benchPost("http://127.0.0.1", "secret", async () => new Response("not ok", { status: 503 }))("/cli/export", {}, new AbortController().signal)).rejects.toThrow("HTTP 503");
});
