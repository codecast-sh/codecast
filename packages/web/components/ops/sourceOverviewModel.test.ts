import { describe, expect, test } from "bun:test";
import { appWatchVerdict, metricWatchRow, verdictBreakdown, verdictCounts, watchFailWord, watchVerdict, watchWordBreakdown } from "./appsModel";
import { deliveryWord, eventsLast24h, fixLabel, isOpenProblem, isRunRecord, isSilenceWatch, issueWorkItem, knownSilence, settingsAnchor, silenceWatchInput, silentSourceFacts, sourceSettingsHref, usualBefore } from "./sourceViewModel";
import { matchedOnly, overlayBins, UNMATCHED } from "./timelineModel";
import type { OpsWatch } from "./opsTypes";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12);

const watch = (o: Partial<OpsWatch>): OpsWatch => ({ _id: "w", short_id: "mw-1", name: "Intros a week", status: "active", state: "ok", last_value: 10, last_at: NOW - 60_000, threshold: undefined, query_kind: "reader", query: "metrics.read intros", points: [], ...o } as unknown as OpsWatch);

describe("one reading for every watch count on a source", () => {
  test("alerting, failing, retrying, waiting, ok and paused, in that order of worry", () => {
    expect(watchVerdict(watch({ status: "paused", last_error: "no answer in 15s" }))).toBe("paused");
    expect(watchVerdict(watch({ state: "alert", threshold: 5 }))).toBe("alerting");
    expect(watchVerdict(watch({ last_error: "no answer in 15s", missed: 3 }))).toBe("failing");
    // One failed read with an older value standing is retrying: not ok, but not the home's Watch errors either.
    expect(watchVerdict(watch({ last_error: "no answer in 15s", missed: 1 }))).toBe("retrying");
    expect(watchVerdict(watch({ last_value: null, last_at: null }))).toBe("waiting");
    expect(watchVerdict(watch({}))).toBe("ok");
  });

  test("the tile's count is the sum of the panel's rows, and the Apps board reads the same rows", () => {
    const ws = [watch({ state: "alert", threshold: 5 }), watch({ last_error: "no answer in 15s", missed: 1 }), watch({ last_error: "no answer in 15s", missed: 4 }), watch({}), watch({ status: "paused" })];
    const c = verdictCounts([...ws.map(watchVerdict), appWatchVerdict({ last_error: "answered 502", polled_at: NOW })]);
    expect(c.notOk).toBe(4);
    expect(c.total).toBe(6);
    expect(verdictBreakdown(c)).toBe("1 alerting · 2 failing · 1 retrying");
    const rows = ws.map(metricWatchRow);
    // An ok reading with no line is unjudged, "No line" on every surface, never OK.
    expect(rows.filter((r) => r.tone === "ok" || r.label === "No line").length).toBe(ws.filter((w) => watchVerdict(w) === "ok").length);
    expect(rows.map((r) => r.label)).toEqual(["Alert", "Timed out", "Timed out", "No line", "Paused"]);
    expect(rows.map((r) => r.stale)).toEqual([false, true, true, false, false]);
  });
});

describe("what an overview lists as an open problem", () => {
  const g = (o: Record<string, unknown>) => ({ kind: "error", title: "TypeError", status: "open", ...o }) as never;
  test("a deploy run CI filed as its own group is a record, not an issue", () => {
    expect(isRunRecord(g({ kind: "check", title: "Deploy e5e60f4 for Samvit on union-ai/union-mobile main" }))).toBe(true);
    expect(isRunRecord(g({ kind: "check", title: "Deploy on union-ai/union-mobile main" }))).toBe(false);
    expect(isOpenProblem(g({ kind: "check", title: "Deploy e5e60f4 for Samvit on union-ai/union-mobile main" }))).toBe(false);
  });
  test("a check that passes now is not a problem; a failing one and an open error are", () => {
    expect(isOpenProblem(g({ kind: "check", title: "E2E Tests on a/b main", meta: { ok: true } }))).toBe(false);
    expect(isOpenProblem(g({ kind: "check", title: "E2E Tests on a/b main", meta: { ok: false } }))).toBe(true);
    expect(isOpenProblem(g({}))).toBe(true);
    expect(isOpenProblem(g({ status: "resolved" }))).toBe(false);
  });
  test("a check failing again after its recovery reads regressed on the overview row, as the Issues list reads it", () => {
    // No server regressed_at: a check recovers on its own, and the failure after that recovery is the regression.
    const back = g({ _id: "g", kind: "check", title: "E2E Tests on a/b main", resolved_at: NOW - DAY, last_transition: "check_failed", last_transition_at: NOW - 3_600_000, last_seen: NOW, meta: { ok: false } });
    expect(issueWorkItem(back, null).state).toBe("regressed");
    expect(issueWorkItem(g({ _id: "g", last_seen: NOW }), null).state).toBe("new");
  });
  test("delivery names how events arrive", () => {
    expect(deliveryWord({ provider: "github", keyed: false })).toBe("webhook");
    expect(deliveryWord({ provider: "sdk", keyed: true } as never)).toBe("push");
    expect(deliveryWord({ provider: "posthog", keyed: false })).toBe("poll");
  });
});

describe("a silent source's chart and its usual day", () => {
  const day = (i: number) => ({ from: NOW - (30 - i) * DAY, to: NOW - (29 - i) * DAY, parts: {}, total: 0, unknown: true as const });
  test("days after the last event are silence, its own day holds at least the one, older days stay unknown", () => {
    const bins = Array.from({ length: 30 }, (_, i) => day(i));
    const lastAt = bins[11].from + 3600_000;
    const out = knownSilence(bins, lastAt);
    expect(out.slice(0, 11).every((b) => b.unknown)).toBe(true);
    expect(out[11]).toMatchObject({ total: 1, estimated: true });
    expect(out.slice(12).every((b) => !b.unknown && b.total === 0)).toBe(true);
  });
  test("the usual day before going quiet comes from its issues' daily counts", () => {
    const lastAt = NOW - 18 * DAY;
    const days = [40, 38, 0, 45, 42, 39].map((count, i) => ({ day: Math.floor((lastAt - (6 - i) * DAY) / DAY) * DAY, count }));
    expect(usualBefore({ days: [] }, [{ days }], lastAt)).toBe(40);
    expect(usualBefore({ days: [] }, [], lastAt)).toBeNull();
  });
});

describe("a filtered stream chart", () => {
  test("Matching drops the unmatched rest, so the scale follows the rows that match", () => {
    const total = [{ from: 0, to: 10, parts: { events: 500 }, total: 500 }, { from: 10, to: 20, parts: { events: 400 }, total: 400 }];
    const { bins, matched } = overlayBins(total, [{ at: 2, key: "error" }, { at: 12, key: "error" }, { at: 13, key: "error" }]);
    expect(matched).toBe(3);
    expect(bins[0].parts[UNMATCHED]).toBe(499);
    const only = matchedOnly(bins);
    expect(only.map((b) => b.total)).toEqual([1, 2]);
    expect(only.every((b) => !(UNMATCHED in b.parts))).toBe(true);
  });
});

describe("one name and one window for the same fact on every surface", () => {
  test("a watch whose reads time out says so on the overview, the tile and the board", () => {
    const w = watch({ last_error: "metric metrics.read: no answer in 10s" });
    const v = watchVerdict(w);
    expect(watchFailWord(v, w.last_error)).toBe("timed out");
    expect(metricWatchRow(w).label).toBe("Timed out");
    expect(watchWordBreakdown([{ verdict: v, error: w.last_error }, { verdict: v, error: w.last_error }, { verdict: "alerting" }])).toBe("1 alerting · 2 timed out");
    expect(watchFailWord("ok", null)).toBeNull();
  });
  test("the 24h count reads the hour counter the overview tile reads", () => {
    const hour = Math.floor(NOW / 3_600_000) * 3_600_000;
    const source = { _id: "s", days: [{ day: "2026-10-01", events: 1 }], hours: [{ hour, events: 4 }, { hour: hour - 23 * 3_600_000, events: 1 }, { hour: hour - 24 * 3_600_000, events: 9 }] } as any;
    expect(eventsLast24h(source, [], [], NOW)).toBe(5);
    expect(eventsLast24h({ _id: "s" } as any, [], [{ source_id: "s", started_at: NOW - 1000 }], NOW)).toBe(1);
  });
  test("a fix beside a task names the task, in the Fix card's words", () => {
    expect(fixLabel(null, false)).toBe("Start fix");
    expect(fixLabel({ status: "todo", short_id: "ct-7" }, true)).toBe("Start fix on ct-7");
    expect(fixLabel({ status: "done", short_id: "ct-7" }, true)).toBe("Start follow-up fix on ct-7");
  });
  test("a link lands on one source's settings row", () => {
    expect(sourceSettingsHref("src-4")).toBe("/settings/integrations#source-src-4");
    expect(settingsAnchor("#source-src-4")).toEqual({ kind: "source", id: "src-4" });
    expect(settingsAnchor("#product-sources")).toEqual({ kind: "section" });
    expect(settingsAnchor("#app-github")).toBeNull();
  });
  test("a silent source's watch alerts after six quiet hours, and is found again", () => {
    const input = silenceWatchInput({ _id: "s", name: "union-moments" });
    expect(input).toMatchObject({ query_kind: "volume", query: "events", threshold: 1, direction: "below", interval_ms: 3_600_000, eval_reads: 6 });
    expect(isSilenceWatch({ query_kind: "volume", query: "events", threshold: 1, direction: "below" } as any)).toBe(true);
    expect(isSilenceWatch({ query_kind: "volume", query: "events", threshold: 100, direction: "above" } as any)).toBe(false);
    expect(silentSourceFacts({ name: "union-moments", short_id: "src-9", provider: "sdk", keyed: true }, NOW, 3).failure).toContain("about 3 events a day");
  });
});
