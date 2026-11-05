import { describe, expect, test } from "bun:test";
import type { AppWatch } from "@codecast/shared/contracts/appConnector";
import { appHealth, callActor, callReason, callsFailing, failureLine, groupCalls, liveFailures, groupState, groupTone, lastFailure, schemaParams, titleLookup, usageByName, watchRowVerdict, watchRows, watchTally } from "./appsModel";
import type { OpsAppCall } from "./opsTypes";

const NOW = Date.parse("2026-10-12T22:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let n = 0;
const call = (over: Partial<OpsAppCall>): OpsAppCall => ({ _id: `c${n++}`, source_id: "s", user_id: "u", kind: "read", name: "jobs.failed", args_hash: "", status: "ok", ms: 100, bytes: 10, created_at: NOW, ...over });
const watchFail = (ago: number, error = "no answer in 15s", name = "jobs.failed", key = "job:jobs.failed") => call({ name, status: "error", error: `watch ${key}: ${error}`, ms: 15_000, bytes: 0, created_at: NOW - ago });

const WATCHES: AppWatch[] = [
  { reader: "jobs.failed", every: "5m", every_ms: 5 * MIN, kind: "job", map: { id: "id", ok: "ok", at: "failedAt" } },
  { reader: "invariants.list", every: "1h", every_ms: HOUR, kind: "check", map: { id: "id", ok: "ok" } },
];

describe("callReason", () => {
  test("names the outcome in a word or two and drops the watch prefix", () => {
    expect(callReason(call({}))).toBe("OK");
    expect(callReason(call({ status: "denied", error: "views.token is not granted: a person grants it in the browser" }))).toBe("Denied");
    expect(callReason(watchFail(0))).toBe("Timed out");
    expect(callReason(watchFail(0, "Could not reach the app at https://x.fly.dev: error sending request for url (https://x.fly.dev/a): reset"))).toBe("Unreachable");
    expect(callReason(watchFail(0, "answered 502"))).toBe("HTTP 502");
    expect(callReason(call({ status: "error", http_status: 500, error: "answered 500" }))).toBe("HTTP 500");
    expect(callReason(call({ status: "error", error: "the answer is not JSON" }))).toBe("Bad answer");
    expect(callReason(call({ status: "error" }))).toBe("Failed");
    // A source's own error names the manifest fetch the same way.
    expect(callReason({ status: "error", error: "manifest: answered 401" })).toBe("HTTP 401");
  });

  test("an unknown error is its first clause, clipped", () => {
    expect(callReason(call({ status: "error", error: "reader jobs.failed did not answer with a list of rows: got an object" }))).toBe("Reader jobs.failed did not…");
    expect(callReason(call({ status: "error", error: "args.jobId: required" }))).toBe("Args.jobId");
  });
});

test("callActor tells a session from a watch poll from a terminal", () => {
  expect(callActor(call({ conversation_id: "k1" }))).toBe("session");
  expect(callActor(watchFail(0))).toBe("watch");
  expect(callActor(call({ status: "error", error: "answered 500" }))).toBe("cli");
});

describe("groupCalls", () => {
  const ctx = (over = {}) => ({ grants: [], watchState: [], watches: WATCHES, now: NOW, ...over });

  test("one group per reader or action, its different errors as reasons", () => {
    const calls = [watchFail(3 * DAY), watchFail(4 * DAY, "answered 502"), watchFail(5 * DAY), watchFail(6 * DAY)];
    const groups = groupCalls(calls, ctx());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 4, status: "error", actor: "watch", latest: NOW - 3 * DAY, oldest: NOW - 6 * DAY });
    expect(groups[0].reasons).toEqual([
      { reason: "Timed out", count: 3, error: "watch job:jobs.failed: no answer in 15s" },
      { reason: "HTTP 502", count: 1, error: "watch job:jobs.failed: answered 502" },
    ]);
    expect(lastFailure(calls)).toBe(NOW - 3 * DAY);
    expect(lastFailure([])).toBeNull();
  });

  test("a group stands where its newest call left it, and keeps what went wrong before as reasons", () => {
    const calls = [
      call({ kind: "do", name: "views.token", created_at: NOW - MIN, conversation_id: "k1" }),
      call({ kind: "do", name: "views.token", status: "denied", error: "views.token is not granted", created_at: NOW - 10 * MIN, conversation_id: "k1" }),
    ];
    const [g] = groupCalls(calls, ctx());
    expect([groupState(g), groupTone(g), g.live, g.count]).toEqual(["OK", "ok", false, 2]);
    expect(g.reasons).toEqual([{ reason: "Denied", count: 1, error: "views.token is not granted" }]);
  });

  test("a failure with no good answer since is live and leads; an answered or old one is not", () => {
    const calls = [
      call({ name: "errors.stats", created_at: NOW - MIN }),
      call({ name: "errors.list", status: "error", error: "answered 500", created_at: NOW - HOUR }),
      watchFail(2 * HOUR),
      call({ name: "jobs.queues", status: "error", error: "answered 500", created_at: NOW - 3 * DAY }),
    ];
    const live = groupCalls(calls, ctx({ watchState: [{ key: "job:jobs.failed", polled_at: NOW - 2 * HOUR, last_error: "no answer in 15s" }] }));
    expect(live.map((g) => [g.name, groupState(g), groupTone(g)])).toEqual([
      ["errors.list", "Failing", "bad"],
      ["jobs.failed", "Failing", "bad"],
      ["errors.stats", "OK", "ok"],
      ["jobs.queues", "Failed", "off"],
    ]);
    // The watch has polled well since: its failures are history.
    const recovered = groupCalls(calls, ctx({ watchState: [{ key: "job:jobs.failed", polled_at: NOW - MIN }] })).find((g) => g.name === "jobs.failed")!;
    expect([groupState(recovered), groupTone(recovered), recovered.live]).toEqual(["Recovered", "off", false]);
  });

  test("a refusal stays live until the action is granted", () => {
    const calls = [call({ kind: "do", name: "views.token", status: "denied", error: "views.token is not granted", created_at: NOW - 10 * MIN })];
    const refused = groupCalls(calls, ctx())[0];
    expect([groupState(refused), groupTone(refused), refused.live]).toEqual(["Denied", "warn", true]);
    const granted = groupCalls(calls, ctx({ grants: [{ action: "views.token", granted_by: "u", granted_at: NOW - MIN }] }))[0];
    expect([groupState(granted), groupTone(granted), granted.live]).toEqual(["Granted", "ok", false]);
  });
});

describe("watchRows and health", () => {
  const calls = [watchFail(2 * DAY), watchFail(3 * DAY), watchFail(2 * DAY, "no answer in 15s", "invariants.list", "check:invariants.list")];

  test("a watch is ok, failing, stale or waiting, with its failures counted", () => {
    const rows = watchRows(WATCHES, [{ key: "job:jobs.failed", polled_at: NOW - 2 * MIN }], calls, NOW);
    expect(rows.map((r) => [r.key, r.tone, r.label, r.failures])).toEqual([
      ["job:jobs.failed", "ok", "OK", 2],
      ["check:invariants.list", "off", "Waiting", 1],
    ]);
    expect(watchRows(WATCHES, [{ key: "job:jobs.failed", polled_at: NOW - HOUR }], [], NOW)[0].label).toBe("Stale");
    // A cached row painted before the feed answers is old by nature: not called stale.
    expect(watchRows(WATCHES, [{ key: "job:jobs.failed", polled_at: NOW - HOUR }], [], NOW, false)[0].label).toBe("OK");
    const failing = watchRows(WATCHES, [{ key: "job:jobs.failed", polled_at: NOW - MIN, last_error: "answered 502" }], [], NOW)[0];
    expect([failing.tone, failing.label, failing.error]).toEqual(["bad", "HTTP 502", "answered 502"]);
  });

  test("health reads the source first, then watches, then live failures", () => {
    const okWatches = watchRows(WATCHES, [{ key: "job:jobs.failed", polled_at: NOW - MIN }, { key: "check:invariants.list", polled_at: NOW - MIN }], calls, NOW);
    const groups = groupCalls(calls, { grants: [], watchState: [{ key: "job:jobs.failed", polled_at: NOW - MIN }, { key: "check:invariants.list", polled_at: NOW - MIN }], watches: WATCHES, now: NOW });
    expect(appHealth({ status: "active" }, okWatches, groups)).toEqual({ tone: "ok", label: "Healthy", detail: null });
    expect(callsFailing(groups)).toBe(0);
    expect(appHealth({ status: "error", last_error: "manifest: answered 401" }, okWatches, groups)).toEqual({ tone: "bad", label: "Error", detail: "manifest: answered 401" });
    expect(appHealth({ status: "paused" }, okWatches, groups).label).toBe("Paused");

    const badWatches = watchRows(WATCHES, [{ key: "job:jobs.failed", polled_at: NOW - MIN, last_error: "no answer in 15s" }], [], NOW);
    expect(appHealth({ status: "active" }, badWatches, []).label).toBe("Failing");
    // A failing watch is counted among the watches, never again as a failing call.
    expect(watchTally(badWatches.map(watchRowVerdict)).text).toBe("1 of 2 watches failing");

    const liveRead = groupCalls([call({ name: "errors.list", status: "error", error: "answered 500", created_at: NOW - HOUR })], { grants: [], watchState: [], watches: [], now: NOW });
    expect(appHealth({ status: "active" }, [], liveRead).label).toBe("Degraded");
    expect(callsFailing(liveRead)).toBe(1);
  });
});

test("usageByName counts calls, failures and the last use per reader or action", () => {
  const usage = usageByName([call({ created_at: NOW - MIN }), watchFail(HOUR), call({ kind: "do", name: "jobs.rerun", created_at: NOW - DAY })]);
  expect(usage.get("read:jobs.failed")).toEqual({ count: 2, failed: 1, last: NOW - MIN });
  expect(usage.get("do:jobs.rerun")).toEqual({ count: 1, failed: 0, last: NOW - DAY });
});

test("schemaParams lists arguments with their type and whether they are required", () => {
  expect(schemaParams({ type: "object", required: ["view"], properties: { view: { type: "string", enum: ["call", "need"] }, at: { type: "string", description: "ISO time" } } })).toEqual([
    { name: "view", type: "call | need", required: true, description: null },
    { name: "at", type: "string", required: false, description: "ISO time" },
  ]);
  expect(schemaParams(undefined)).toEqual([]);
});

test("titleLookup names a call by its manifest title, else by its own name", () => {
  const titleOf = titleLookup({ readers: [{ name: "jobs.failed", title: "Recent job failures", method: "GET", path: "/x", input: {} }], actions: [] }, [{ name: "issue.resolve", title: "Resolve an issue" }]);
  expect(titleOf("read", "jobs.failed")).toBe("Recent job failures");
  expect(titleOf("do", "issue.resolve")).toBe("Resolve an issue");
  expect(titleOf("do", "gone.action")).toBe("gone.action");
});

describe("one failing-call aggregate for the board and every health line", () => {
  const NOW2 = Date.UTC(2026, 10, 3, 12);
  const metricFail = (at: number, error: string, http_status?: number) => ({ _id: `m${at}`, source_id: "s", kind: "read", name: "metrics.read", status: "error", error, http_status, created_at: at, ms: 10, bytes: 0 }) as any;
  const ctx = { grants: [], watchState: [], watches: [], now: NOW2 };

  test("a metric watch's poll names its reader once, and its reasons read as what the reader does", () => {
    const calls = [metricFail(NOW2 - 60_000, "metric metrics.read: answered 502", 502), metricFail(NOW2 - 120_000, "metric metrics.read: no answer in 10s"), metricFail(NOW2 - 3 * 3600_000, "metric metrics.read: answered 502", 502)];
    expect(callReason(calls[1])).toBe("Timed out");
    expect(callActor(calls[1])).toBe("watch");
    const [f] = liveFailures(calls, ctx);
    expect([f.name, f.count, f.since]).toEqual(["metrics.read", 3, NOW2 - 3 * 3600_000]);
    expect(failureLine(f, NOW2)).toBe("metrics.read returns HTTP 502 or times out, 3× in the last 3h");
  });

  test("one watch sentence: failing and retrying are failing, alerting is its own noun, a mix names both", () => {
    expect(watchTally(["ok", "failing", "retrying", "ok"]).text).toBe("2 of 4 watches failing");
    expect(watchTally(["ok", "retrying"]).tone).toBe("warn");
    expect(watchTally(["alerting", "ok"]).text).toBe("1 of 2 watches alerting");
    expect(watchTally(["alerting", "failing", "ok"])).toMatchObject({ bad: 2, word: "alerting or failing", tone: "bad" });
    expect(watchTally(["ok", "paused"])).toMatchObject({ bad: 0, text: "2 watches ok", tone: "ok" });
  });

  test("watches with no line are counted apart, the same tally on the Apps head and the overview tile", () => {
    const eleven = Array.from({ length: 11 }, () => "ok" as const);
    // Every watch unjudged: nothing to count ok, so no "0/11" that reads as failure.
    expect(watchTally(eleven, { noLine: 11 })).toMatchObject({ bad: 0, ok: 0, noLine: 11, total: 11, tone: "off", sub: "", unjudged: true, label: "watches · no lines", text: "11 watches · no lines" });
    expect(watchTally(["alerting", "ok", "ok", "ok", "ok"], { noLine: 2 })).toMatchObject({ bad: 1, ok: 2, word: "alerting", tone: "bad", sub: "1 alerting · 2 no line", unjudged: false });
  });

  test("a tile's number is always the watches ok, whichever state the rest are in", () => {
    expect(watchTally(["ok", "ok", "ok"])).toMatchObject({ value: 3, total: 3, label: "watches ok" });
    expect(watchTally(["ok", "failing", "retrying", "ok", "ok"])).toMatchObject({ value: 3, total: 5, label: "watches ok", sub: expect.stringContaining("2") });
    expect(watchTally(["alerting", "ok", "ok", "ok", "ok"], { noLine: 2 })).toMatchObject({ value: 2, label: "watches ok" });
    // A no-line count can never exceed the watches reading fine.
    expect(watchTally(["failing"], { noLine: 3 }).noLine).toBe(0);
  });

  test("a reader settles once a metric watch reads through it cleanly after the failure", () => {
    const calls = [metricFail(NOW2 - 55 * 60_000, "metric metrics.read: no answer in 10s")];
    const watch = (over: object) => ({ query_kind: "reader" as const, query: 'metrics.read {"key":"x"}', last_error: undefined, last_at: NOW2 - 3 * 60_000, updated_at: NOW2 - 3 * 60_000, ...over });
    const recovered = groupCalls(calls, { ...ctx, metricWatches: [watch({})] })[0];
    expect([recovered.settled, recovered.live, groupState(recovered), groupTone(recovered)]).toEqual([true, false, "Recovered", "off"]);
    expect(liveFailures(calls, { ...ctx, metricWatches: [watch({})] })).toEqual([]);
    // Still failing: the watch's last read failed, it read before the failure, or it reads another reader.
    for (const w of [watch({ last_error: "no answer in 10s" }), watch({ last_at: NOW2 - 2 * 3600_000, updated_at: NOW2 - 2 * 3600_000 }), watch({ query: "metrics.list" }), watch({ query_kind: "hogql", query: "metrics.read" })]) {
      expect(groupCalls(calls, { ...ctx, metricWatches: [w as never] })[0].live).toBe(true);
    }
  });

  test("a manifest watch's poll failure stays the watch's, out of the live failures", () => {
    const w = { _id: "w", source_id: "s", kind: "read", name: "jobs.failed", status: "error", error: "watch job:jobs.failed: answered 500", created_at: NOW2 - 60_000, ms: 1, bytes: 0 } as any;
    expect(liveFailures([w], ctx)).toEqual([]);
  });
});

test("a 2xx answer that failed for another reason is named by that reason, not its status", () => {
  expect(callReason({ status: "error", http_status: 200, error: "watch check:invariants.list: the response is over 256 KB" })).toBe("The response is over 256 KB");
  expect(callReason({ status: "error", http_status: 502, error: "answered 502" })).toBe("HTTP 502");
});
