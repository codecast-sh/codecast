import { describe, expect, test } from "bun:test";
import {
  windowName,
  alertBands, alertSince, crossings, filterWatches, groupWatches, healthCounts, hogqlFirstCell, inWindow, margin, niceTicks, parseThreshold, previousPeriod,
  priorDelta, rangeWindow, segments, sortWatches, watchHealth, yDomain,
  METRICS_QUERY_DEFAULT, argFields, cardWindow, changeTone, chartPoints, metricsQueryParams, parseMetricsQuery, readerQueryText, readerQueryValues, seriesArgs, seriesKey,
  tickLabels, tickStep, timeTicks, watchMarks, windowAround, windowChange,
  allWindow, argOptions, argSourceReader, bandAt, changeFromZero, hintFields, readerAnswersNumber,
  alertEpisodes, breaksIn, continuousTail, currentEpisodeSince, episodeSummary, errorRollups, fitStart, lineRuns, transitionRows, watchErrorText, wouldCross,
  clusterShips, distribution, formatMeasure, isIntegral, isTestEventName, lineSuggestions, periodChange, suggestDirection, relatedShips,
  changeRange, changeSpan, openHistory, roundToScale, stats, timeWeights, volumeOptions,
  bandsFromTransitions, changeState, clipRunToWindow, durationShort, fullestHeld, rangeChange, runningCrossing, sharePast,
  changeAmount, duplicateWatch, volumeOptions, volumePreview, eventRows, hogqlOfPick, nameOfPick, queryIdentity, shipMarks, ticksOf, tinyBaseline, transitionsIn, windowDelta, dataHoles, cutHoles, measuresCount,
} from "./metricModel";
import type { OpsWatch } from "./opsTypes";

const H = 3600_000;
const D = 24 * H;
const NOW = 1_800_000_000_000;

function watch(over: Partial<OpsWatch> = {}): OpsWatch {
  const points = over.points ?? [{ at: NOW - H, value: 5 }];
  const last = points[points.length - 1];
  return {
    _id: over.short_id ?? "w", workspace: "team:t", source_id: "s", short_id: "mw-1", name: "W", query_kind: "hogql", query: "select 1",
    direction: "above", interval_ms: H, status: "active", state: "ok", last_value: last?.value ?? null, last_at: last?.at ?? null,
    source_name: "union-posthog", source_short_id: "src-1", updated_at: NOW, points, ...over,
  } as OpsWatch;
}

describe("time windows", () => {
  test("a range ends now; All starts at the oldest point", () => {
    expect(rangeWindow("24h", [], NOW)).toEqual({ from: NOW - D, to: NOW });
    expect(rangeWindow("all", [{ at: NOW - 9 * D, value: 1 }], NOW)).toEqual({ from: NOW - 9 * D, to: NOW });
  });

  test("a window keeps one point either side, so the line runs to its edges", () => {
    const pts = [0, 1, 2, 3, 4].map((i) => ({ at: NOW - (4 - i) * H, value: i }));
    expect(inWindow(pts, { from: NOW - 2.5 * H, to: NOW - 0.5 * H }).map((p) => p.value)).toEqual([1, 2, 3, 4]);
  });
});

describe("gaps", () => {
  test("a daily backfill beside hourly polls is its own line at its own cadence, never joined to the polls", () => {
    const daily = [5, 4, 3, 2].map((d) => ({ at: NOW - d * D, value: d }));
    const hourly = [0, 1, 2].map((h) => ({ at: NOW - D + (h + 1) * H, value: h }));
    const runs = lineRuns([...daily, ...hourly], H);
    expect(runs.map((r) => [r.sparse, r.points.length, r.step])).toEqual([[false, 4, D], [false, 3, H]]);
    expect(segments([...daily, ...hourly], H)).toHaveLength(2);
  });

  test("a reader's own daily series is one line at its own spacing; a lone stray value stands alone", () => {
    const daily = [6, 5, 4, 3, 2, 1].map((d) => ({ at: NOW - d * D, value: d }));
    expect(lineRuns(daily, 10 * 60_000).map((r) => [r.sparse, r.points.length])).toEqual([[false, 6]]);
    const stray = [{ at: NOW - 58 * D, value: 13 }, ...[3, 2, 1, 0].map((h) => ({ at: NOW - h * H, value: 12.9 }))];
    expect(lineRuns(stray, H).map((r) => [r.sparse, r.points.length])).toEqual([[true, 1], [false, 4]]);
  });

  test("a break is a gap far past the step and the spacing before it; a change and a card's fit start after it", () => {
    const stray = [{ at: NOW - 58 * D, value: 10 }, ...[3, 2, 1, 0].map((h) => ({ at: NOW - h * H, value: 13 + h }))];
    expect(breaksIn(stray, H)).toEqual([1]);
    expect(continuousTail(stray, H)).toHaveLength(4);
    expect(fitStart(stray, H)).toBe(NOW - 3 * H);
    expect(windowChange(stray, H)!.first).toBe(16);
    // A daily backfill running into hourly polls is not a break: its own spacing is a day.
    const daily = [5, 4, 3, 2, 1].map((d) => ({ at: NOW - d * D, value: d }));
    const joined = [...daily, ...[0, 1, 2].map((h) => ({ at: NOW - D + (h + 1) * H, value: 9 }))];
    expect(breaksIn(joined, H)).toEqual([]);
    expect(fitStart(joined, H)).toBe(NOW - 5 * D);
  });

  test("missed polls break the line", () => {
    const pts = [0, 1, 2, 12, 13, 14].map((h) => ({ at: NOW + h * H, value: h }));
    expect(segments(pts, H).map((s) => s.length)).toEqual([3, 3]);
  });
});

describe("the alert line", () => {
  const pts = [10, 20, 25, 12, 30].map((v, i) => ({ at: NOW + i * H, value: v }));

  test("crossings follow the server's rule: above alerts when over, never at the line", () => {
    expect(crossings(pts, 20, "above").map((c) => [c.kind, c.value])).toEqual([["crossed", 25], ["recovered", 12], ["crossed", 30]]);
    expect(crossings(pts, 20, "below").map((c) => c.kind)).toEqual(["crossed", "recovered", "crossed", "recovered"]);
    expect(crossings(pts, undefined, "above")).toEqual([]);
  });

  test("bands run from crossing to recovery; an open one runs to the window's end", () => {
    expect(alertBands(pts, 20, "above", NOW + 9 * H)).toEqual([{ from: NOW + 2 * H, to: NOW + 3 * H }, { from: NOW + 4 * H, to: NOW + 9 * H }]);
  });

  test("an alert's start is the start of the trailing run past the line", () => {
    const w = watch({ threshold: 20, points: [{ at: 1, value: 25 }, { at: 2, value: 10 }, { at: 3, value: 22 }, { at: 4, value: 40 }] });
    expect(alertSince(w)).toBe(3);
    expect(alertSince({ ...w, threshold: undefined })).toBeNull();
  });

  test("margin is room left as a share of the line, negative once past it", () => {
    expect(margin(watch({ threshold: 20, last_value: 15 }))).toBeCloseTo(0.25);
    expect(margin(watch({ threshold: 20, last_value: 30 }))).toBeCloseTo(-0.5);
    expect(margin(watch({ threshold: 20, direction: "below", last_value: 30 }))).toBeCloseTo(0.5);
  });
});

describe("comparison", () => {
  test("the previous period moves forward onto the window", () => {
    const pts = [{ at: NOW - 30 * H, value: 7 }, { at: NOW - 2 * H, value: 9 }];
    expect(previousPeriod(pts, { from: NOW - D, to: NOW })).toEqual([{ at: NOW - 6 * H, value: 7 }]);
  });

  test("a delta needs a value about a span earlier", () => {
    const pts = [{ at: NOW - D, value: 100 }, { at: NOW - H, value: 120 }, { at: NOW, value: 150 }];
    expect(priorDelta(pts, D)).toEqual({ prior: 100, change: 50, pct: 0.5 });
    expect(priorDelta(pts, 7 * D)).toBeNull();
  });
});

describe("health and order", () => {
  test("one word per watch: paused, then a failing read, then no value, then series, then the alert state", () => {
    expect(watchHealth(watch({ status: "paused", state: "alert", threshold: 1 }))).toBe("paused");
    expect(watchHealth(watch({ last_error: "403", threshold: 1 }))).toBe("error");
    expect(watchHealth(watch({ points: [], last_value: null, threshold: 1 }))).toBe("nodata");
    expect(watchHealth(watch({}))).toBe("series");
    expect(watchHealth(watch({ threshold: 1, state: "alert" }))).toBe("alert");
    expect(watchHealth(watch({ threshold: 100 }))).toBe("ok");
  });

  test("state order puts alerts first (longest first), then oks closest to their line", () => {
    const ws = [
      watch({ _id: "a", name: "Calm", threshold: 100, last_value: 5 }),
      watch({ _id: "b", name: "Series" }),
      watch({ _id: "c", name: "New alert", threshold: 1, state: "alert", points: [{ at: NOW, value: 5 }] }),
      watch({ _id: "d", name: "Old alert", threshold: 1, state: "alert", points: [{ at: NOW - D, value: 5 }, { at: NOW, value: 5 }] }),
      watch({ _id: "e", name: "Close", threshold: 6, last_value: 5 }),
      watch({ _id: "f", name: "Paused", status: "paused", threshold: 1 }),
    ];
    expect(sortWatches(ws, "state").map((w) => w._id)).toEqual(["d", "c", "e", "a", "b", "f"]);
    expect(healthCounts(ws)).toEqual({ alert: 2, error: 0, warn: 0, nodata: 0, ok: 2, series: 1, paused: 1 });
  });

  test("filter by state and words; group by source or by kind", () => {
    const ws = [watch({ _id: "a", name: "Exceptions", threshold: 1, state: "alert" }), watch({ _id: "b", name: "Signups", source_name: "app" })];
    expect(filterWatches(ws, { health: "alert", search: "" }).map((w) => w._id)).toEqual(["a"]);
    expect(filterWatches(ws, { health: null, search: "sign" }).map((w) => w._id)).toEqual(["b"]);
    expect(groupWatches(ws, "source").map((g) => [g.label, g.rows.length])).toEqual([["app", 1], ["union-posthog", 1]]);
    expect(groupWatches(ws, "kind").map((g) => g.label)).toEqual(["Alerting on a line", "No line"]);
  });
});

describe("axes and inputs", () => {
  test("a small wobble on a large value is drawn as a ripple: the axis spans at least a tenth of the value", () => {
    const [lo, hi] = yDomain([[{ at: 0, value: 12.9 }, { at: 1, value: 13 }]]);
    expect(hi - lo).toBeGreaterThanOrEqual(1.3);
    expect(lo).toBeLessThan(12.9);
    expect(hi).toBeGreaterThan(13);
  });

  test("ticks are round, the domain holds the line and pads", () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    const [lo, hi] = yDomain([[{ at: 0, value: 10 }, { at: 1, value: 20 }]], 50);
    expect(lo).toBeCloseTo(6.8);
    expect(yDomain([[{ at: 0, value: 1 }, { at: 1, value: 100 }]])[0]).toBe(0);
    expect(hi).toBeGreaterThan(50);
  });

  test("a threshold field reads a number, empty as no line, anything else as invalid", () => {
    expect(parseThreshold("1,500")).toBe(1500);
    expect(parseThreshold(" ")).toBeUndefined();
    expect(parseThreshold("lots")).toBeNull();
  });

  test("a HogQL answer's value is its first cell", () => {
    expect(hogqlFirstCell({ results: [[42, "x"]] })).toBe(42);
    expect(hogqlFirstCell({ results: [["3.5"]] })).toBe(3.5);
    expect(hogqlFirstCell({ results: [] })).toBeNull();
  });
});

describe("monitor health", () => {
  test("warn is the latest value past the warning level while not alerting; alert outranks a read error", () => {
    expect(watchHealth(watch({ threshold: 10, warn: 5, points: [{ at: NOW, value: 7 }] }))).toBe("warn");
    expect(watchHealth(watch({ threshold: 10, warn: 5, points: [{ at: NOW, value: 3 }] }))).toBe("ok");
    expect(watchHealth(watch({ threshold: 10, state: "alert", last_error: "no value", points: [{ at: NOW, value: 12 }] }))).toBe("alert");
    expect(watchHealth(watch({ threshold: 10, last_error: "500", points: [{ at: NOW, value: 3 }] }))).toBe("error");
  });

  test("one failed read does not flip a watch to erroring; two in a row, or no value ever, do", () => {
    expect(watchHealth(watch({ threshold: 10, last_error: "no answer in 15s", missed: 1, points: [{ at: NOW, value: 3 }] }))).toBe("ok");
    expect(watchHealth(watch({ threshold: 10, last_error: "no answer in 15s", missed: 2, points: [{ at: NOW, value: 3 }] }))).toBe("error");
    expect(watchHealth(watch({ threshold: 10, last_error: "no answer in 15s", missed: 1, points: [], last_value: null }))).toBe("error");
  });

  test("a read error names the reader it came from, once", () => {
    expect(watchErrorText(watch({ query_kind: "reader", query: 'metrics.read {"key":"x"}', last_error: "no answer in 15s" }))).toBe("metrics.read: no answer in 15s");
    expect(watchErrorText(watch({ query_kind: "hogql", last_error: "PostHog answered 403" }))).toBe("HogQL: PostHog answered 403");
    expect(watchErrorText(watch({ query_kind: "reader", query: "metrics.read", last_error: "metrics.read: answered 502" }))).toBe("metrics.read: answered 502");
    expect(watchErrorText(watch({}))).toBeNull();
  });

  test("watches on one source failing the same way roll up; one alone does not", () => {
    const fail = (id: string, err = "no answer in 15s", source_id = "s") => watch({ _id: id, short_id: id, source_id, last_error: err } as Partial<OpsWatch>);
    const r = errorRollups([fail("a"), fail("b"), fail("c"), fail("d", "answered 502"), fail("e", "no answer in 15s", "t"), watch({ short_id: "ok" })]);
    expect(r).toHaveLength(1);
    expect(r[0].watches.map((w) => w.short_id)).toEqual(["a", "b", "c"]);
  });
});

describe("alert episodes", () => {
  const T = (at: number, kind: "crossed" | "recovered", inferred?: boolean) => ({ at, kind, value: null, ...(inferred ? { inferred } : {}) });

  test("episodes come from announced transitions: crossed to recovered, the running one open", () => {
    const rows = [T(NOW - 20 * D, "crossed"), T(NOW - 19 * D, "recovered"), T(NOW - 10 * D, "crossed"), T(NOW - 9 * D, "crossed"), T(NOW - 4 * D, "recovered"), T(NOW - 2 * D, "crossed")];
    const eps = alertEpisodes(rows, NOW - 2 * D);
    expect(eps).toEqual([{ from: NOW - 20 * D, to: NOW - 19 * D }, { from: NOW - 10 * D, to: NOW - 4 * D }, { from: NOW - 2 * D, to: null }]);
    const all = episodeSummary(eps, { from: NOW - 30 * D, to: NOW }, NOW);
    expect(all).toEqual({ count: 3, total: 9 * D, current: NOW - 2 * D });
    // A window counts only the time inside it.
    expect(episodeSummary(eps, { from: NOW - 5 * D, to: NOW }, NOW)).toEqual({ count: 2, total: 3 * D, current: NOW - 2 * D });
  });

  test("inferred crossings never count; an alert this device holds no announcement for is still one episode", () => {
    expect(alertEpisodes([T(NOW - 5 * D, "crossed", true), T(NOW - 4 * D, "recovered", true)], null)).toEqual([]);
    expect(alertEpisodes([], NOW - H)).toEqual([{ from: NOW - H, to: null }]);
  });

  test("the running episode starts at the group's announced alert, else at the alerting values", () => {
    const w = watch({ threshold: 10, state: "alert", points: [{ at: NOW - 2 * H, value: 5 }, { at: NOW - H, value: 12 }, { at: NOW, value: 14 }] });
    expect(currentEpisodeSince(w, { last_transition: "metric_alert", last_transition_at: NOW - 5 * H })).toBe(NOW - 5 * H);
    expect(currentEpisodeSince(w, { last_transition: "metric_recovered", last_transition_at: NOW - 9 * H })).toBe(NOW - H);
    expect(currentEpisodeSince({ ...w, state: "ok" }, null)).toBeNull();
  });

  test("the table keeps announced transitions and marks crossings no announcement sits near as inferred", () => {
    const rows = transitionRows(
      [T(NOW - 10 * H, "crossed")],
      [{ at: NOW - 10 * H - 30 * 60_000, value: 12, kind: "crossed" }, { at: NOW - 30 * D, value: 11, kind: "crossed" }],
      2 * H,
    );
    expect(rows.map((r) => [r.at, !!r.inferred])).toEqual([[NOW - 30 * D, true], [NOW - 10 * H, false]]);
  });

  test("a candidate line says how often it would have crossed", () => {
    const pts = [5, 12, 4, 15, 3, 11].map((value, i) => ({ at: NOW + i * H, value }));
    expect(wouldCross(pts, 10, "above")).toBe(3);
    expect(wouldCross(pts, 13, "above")).toBe(1);
    expect(wouldCross(pts, 4, "below")).toBe(1);
  });
});

describe("time axis", () => {
  const local = (y: number, m: number, d: number, h = 0) => new Date(y, m, d, h).getTime();

  test("a three day window labels midnights by date and the rest by time, never repeating a date", () => {
    const win = { from: local(2026, 10, 1, 5), to: local(2026, 10, 4, 3) };
    const ticks = timeTicks(win, 6);
    const labels = tickLabels(ticks, win);
    const dates = labels.filter((l) => /[A-Za-z]{3} \d/.test(l));
    expect(new Set(dates).size).toBe(dates.length);
    expect(ticks.every((t) => new Date(t).getMinutes() === 0)).toBe(true);
    expect(labels.some((l) => !/[A-Za-z]{3} \d/.test(l))).toBe(true);
  });

  test("a month steps by whole days at local midnight", () => {
    const win = { from: local(2026, 9, 3, 13), to: local(2026, 10, 2, 9) };
    const ticks = timeTicks(win, 6);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.every((t) => new Date(t).getHours() === 0)).toBe(true);
    expect(tickStep(win, 6)).toBeGreaterThanOrEqual(D);
  });

  test("a window across a new year names the year", () => {
    const win = { from: local(2026, 11, 20), to: local(2027, 0, 10) };
    const labels = tickLabels(timeTicks(win, 6), win);
    expect(labels.some((l) => l.includes("2027"))).toBe(true);
  });
});

describe("server series", () => {
  test("keys separate a range, the period before it and a zoom", () => {
    expect(seriesKey("w", { kind: "range", range: "7d" }, 300)).toBe("w|7d|300");
    expect(seriesKey("w", { kind: "prev", range: "7d" }, 300)).toBe("w|p7d|300");
    expect(seriesKey("w", { kind: "zoom", win: { from: 1, to: 2 } }, 300)).toBe("w|z1-2|300");
  });

  test("args: a span, the same span offset back, an exact zoom; nothing before All", () => {
    expect(seriesArgs({ kind: "range", range: "24h" }, 300)).toEqual({ span_ms: D, buckets: 300 });
    expect(seriesArgs({ kind: "prev", range: "24h" }, 300)).toEqual({ span_ms: D, offset_ms: D, buckets: 300 });
    // All has no period before it: the change reads the last 7 days against the 7 before.
    expect(seriesArgs({ kind: "prev", range: "all" }, 300)).toEqual({ span_ms: 7 * D, offset_ms: 7 * D, buckets: 300 });
    expect(seriesArgs({ kind: "range", range: "all" }, 300)).toEqual({ buckets: 300 });
    expect(seriesArgs({ kind: "zoom", win: { from: 10.4, to: 20.6 } }, 50)).toEqual({ from: 10, to: 21, buckets: 50 });
  });

  test("a chart draws the answer plus newer row values, or the row alone", () => {
    const answer = { points: [{ at: 1, value: 1 }, { at: 2, value: 2 }] };
    expect(chartPoints(answer, [{ at: 2, value: 9 }, { at: 3, value: 3 }]).map((p) => p.at)).toEqual([1, 2, 3]);
    expect(chartPoints(undefined, [{ at: 3, value: 3 }, { at: 1, value: 1 }]).map((p) => p.at)).toEqual([1, 3]);
  });

  test("a card fits a watch holding less than the window to what it holds", () => {
    const win = { from: NOW - 7 * D, to: NOW };
    expect(cardWindow(win, NOW - 8 * D)).toEqual({ win, fitted: null });
    const fit = cardWindow(win, NOW - 12 * H);
    expect(fit.fitted).toBe(12 * H);
    expect(fit.win.to).toBe(NOW);
    expect(fit.win.from).toBeGreaterThan(NOW - 13 * H);
    expect(fit.win.from).toBeLessThanOrEqual(NOW - 12 * H);
  });

  test("window change is first to last; too few values say nothing", () => {
    expect(windowChange([{ at: 2, value: 15 }, { at: 1, value: 10 }])).toEqual({ first: 10, last: 15, change: 5, pct: 0.5, since: 1 });
    expect(windowChange([{ at: 1, value: 1 }])).toBeNull();
    expect(changeTone({ threshold: 10, direction: "above" }, 5)).toBe("bad");
    expect(changeTone({ threshold: 10, direction: "below" }, 5)).toBe("good");
    expect(changeTone({ threshold: undefined, direction: "above" }, 5)).toBe("flat");
  });
});

describe("chart markers", () => {
  test("transitions, the task, the fix, its commit and the resolve, oldest first, each linking where it leads", () => {
    const marks = watchMarks({
      transitions: [{ at: 10, kind: "crossed", value: 16 }, { at: 50, kind: "recovered", value: 9 }],
      group: { short_id: "eg-1", status: "resolved", resolved_at: 60, resolved_in: "v2", fix_started_at: 30, fix_conversation_id: "c1" },
      task: { _id: "t1", short_id: "ct-9", status: "done", created_at: 20, closed_at: 55, landed: { sha: "abcdef123456", at: 40, url: "https://x/c" } },
      issueHref: "/ops/issues/eg-1",
    });
    expect(marks.map((m) => m.kind)).toEqual(["crossed", "task", "fix", "ship", "recovered", "task", "resolved"]);
    expect(marks[0]).toMatchObject({ href: "/ops/issues/eg-1", sub: "eg-1" });
    expect(marks.find((m) => m.kind === "fix")?.href).toBe("/conversation/c1");
    expect(marks.find((m) => m.kind === "ship")).toMatchObject({ label: "Landed abcdef1", external: true });
  });

  test("a transition row zooms to a window around its moment, never past now", () => {
    expect(windowAround(100 * H, 6 * D, 100 * H + 2 * H)).toEqual({ from: 100 * H - D, to: 102 * H });
  });
});

describe("the overview's address", () => {
  test("parses what it knows, drops the rest, and writes only what differs from the default", () => {
    const q = parseMetricsQuery((k) => ({ state: "alert", sort: "name", range: "bogus", view: "table", q: "err" } as Record<string, string>)[k] ?? null);
    expect(q).toEqual({ health: "alert", q: "err", sort: "name", group: "none", range: "7d", layout: "table" });
    expect(metricsQueryParams(q)).toEqual({ state: "alert", q: "err", sort: "name", group: null, range: null, view: "table" });
    expect(Object.values(metricsQueryParams(METRICS_QUERY_DEFAULT)).every((v) => v === null)).toBe(true);
  });
});

describe("reader arguments", () => {
  const fields = argFields({ properties: { days: { type: "integer", default: 7 }, team: { type: "string" }, kind: { enum: ["a", "b"] } }, required: ["team"] });

  test("fields come typed from the schema, required first", () => {
    expect(fields.map((f) => [f.key, f.type, f.required])).toEqual([["team", "text", true], ["days", "number", false], ["kind", "enum", false]]);
    expect(fields.find((f) => f.key === "days")?.dflt).toBe("7");
  });

  test("the query is the reader and its typed args; a missing required field or a bad number is named", () => {
    expect(readerQueryText("intros", fields, { team: "x", days: "14" })).toEqual({ query: 'intros {"team":"x","days":14}' });
    expect(readerQueryText("intros", fields, { days: "1" })).toEqual({ error: "team is required" });
    expect(readerQueryText("intros", fields, { team: "x", days: "many" })).toEqual({ error: "days is not a number" });
    expect(readerQueryValues('intros {"team":"x","days":14}')).toEqual({ reader: "intros", values: { team: "x", days: "14" } });
  });
});

describe("the watch page's All", () => {
  test("reaches back to the first announced alert when values start later, and names the stretch with none", () => {
    const r = allWindow({ heldFrom: NOW - 3 * D, firstAnnounced: NOW - 28 * D, firstSeen: NOW - 27 * D, points: [], now: NOW });
    expect(r.win).toEqual({ from: NOW - 28 * D, to: NOW });
    expect(r.gap).toEqual({ from: NOW - 28 * D, to: NOW - 3 * D });
  });
  test("with values reaching furthest there is no gap", () => {
    const r = allWindow({ heldFrom: NOW - 30 * D, firstAnnounced: NOW - 10 * D, firstSeen: null, points: [], now: NOW });
    expect(r.win.from).toBe(NOW - 30 * D);
    expect(r.gap).toBeNull();
  });
  test("with nothing known it is the last day", () => {
    expect(allWindow({ heldFrom: null, firstAnnounced: null, firstSeen: null, points: [], now: NOW }).win).toEqual({ from: NOW - D, to: NOW });
  });
  test("the episode count over All matches the issue's", () => {
    const eps = alertEpisodes([
      { at: NOW - 28 * D, kind: "crossed", value: 0 }, { at: NOW - 27 * D, kind: "recovered", value: 2 },
      { at: NOW - 2 * D, kind: "crossed", value: 0 }, { at: NOW - D, kind: "recovered", value: 2 },
    ], null);
    const win = allWindow({ heldFrom: NOW - 3 * D, firstAnnounced: NOW - 28 * D, firstSeen: null, points: [], now: NOW }).win;
    expect(episodeSummary(eps, win, NOW).count).toBe(episodeSummary(eps, { from: 0, to: NOW }, NOW).count);
  });
  test("a change from zero names its start", () => {
    expect(changeFromZero(11)).toBe("+11 from 0");
    expect(changeFromZero(-3)).toBe("-3 from 0");
  });
  test("the band under a moment", () => {
    expect(bandAt([{ from: 10, to: 20 }], 15)).toEqual({ from: 10, to: 20 });
    expect(bandAt([{ from: 10, to: 20 }], 25)).toBeNull();
  });
});

describe("readers in the new watch sheet", () => {
  test("a hint's top-level fields", () => {
    expect(hintFields("{ key, name, value, unit, points: [{ at, value }] }")).toEqual(["key", "name", "value", "unit", "points"]);
    expect(hintFields("{ summary, results: [{ id, name, ok, value }] }")).toEqual(["summary", "results"]);
    expect(hintFields(undefined)).toEqual([]);
  });
  test("only readers whose answer is a number or a series", () => {
    expect(readerAnswersNumber({ output_hint: "{ key, name, value, unit, points: [{ at, value }] }" })).toBe(true);
    expect(readerAnswersNumber({ output_hint: "{ metrics: [{ key, name, value }] }" })).toBe(false);
    expect(readerAnswersNumber({ output_hint: "{ text }" })).toBe(false);
    expect(readerAnswersNumber({})).toBeNull();
  });
  test("an argument that names its list reader", () => {
    const readers = [{ name: "metrics.list" }, { name: "metrics.read" }, { name: "invariants.list" }];
    expect(argSourceReader("The key from metrics.list", readers, "metrics.read")).toBe("metrics.list");
    expect(argSourceReader("How far back", readers, "metrics.read")).toBeNull();
  });
  test("choices from the list reader's rows", () => {
    const body = { metrics: [{ key: "dollars_per_intro", name: "Dollars per intro", value: 41.5, unit: "$" }, { key: "intros_week", name: "Intros a week", value: 12 }, { nope: 1 }] };
    expect(argOptions(body, "key")).toEqual([
      { value: "dollars_per_intro", label: "Dollars per intro", current: 41.5, unit: "$" },
      { value: "intros_week", label: "Intros a week", current: 12, unit: null },
    ]);
    expect(argOptions({ results: [{ id: "inv-1", name: "Inv" }] }, "invariantId")).toEqual([{ value: "inv-1", label: "Inv", current: null, unit: null }]);
    expect(argOptions({ text: "x" }, "key")).toEqual([]);
  });
});

describe("round 5: sparse ticks, change against the prior period, ships, duplicates, HogQL picks", () => {
  const H = 3600_000;
  const D = 24 * H;

  test("a lone value is a tick that stops short of its neighbours", () => {
    const daily = [0, 1, 2, 3].map((i) => ({ at: i * D, value: i }));
    const ticks = ticksOf(daily, 1000);
    expect(ticks[1]).toEqual({ pt: daily[1], from: D - 0.3 * D, to: D + 0.3 * D });
    // A lone value keeps the minimum width.
    expect(ticksOf([{ at: 5, value: 1 }], 1000)[0]).toMatchObject({ from: -995, to: 1005 });
    // Neighbours are every drawn value: an hourly run beside a daily value narrows its tick.
    const hourly = [{ at: 2 * D + H, value: 9 }];
    expect(ticksOf([daily[2]], 10, [...daily, ...hourly])[0].to).toBe(2 * D + 0.3 * H);
  });

  test("the change compares the window's mean with the previous period's, and drops the percent for a tiny baseline", () => {
    const now = [10, 20].map((value, i) => ({ at: 10 * D + i * D, value }));
    const prior = [10, 10].map((value, i) => ({ at: i * D, value }));
    expect(windowDelta(now, H, prior)).toMatchObject({ vs: "prior", change: 5, pct: 0.5, base: 10, now: 15 });
    // Without a prior period: the first value of the stretch, but 2 against a spread of 140 is about zero.
    const quiet = [2, 0, 140, 135].map((value, i) => ({ at: i * H, value }));
    expect(windowDelta(quiet, H)).toMatchObject({ vs: "first", base: 2, change: 133, pct: null });
    expect(changeAmount(126, 9)).toBe("+126 from 9");
    expect(tinyBaseline(100, [99, 101, 100])).toBe(false);
    expect(tinyBaseline(0, [1, 2])).toBe(true);
    // A prior mean of 9 against values up to 147 is small but not zero: the change stays a percent, as the overview shows it.
    const was = [9, 9].map((value, i) => ({ at: i * D, value }));
    const is = [60, 147].map((value, i) => ({ at: 10 * D + i * D, value }));
    expect(windowDelta(is, H, was)?.pct).toBeCloseTo((103.5 - 9) / 9);
  });

  test("the transitions list follows the window and counts the rest", () => {
    const rows = [{ at: 1 }, { at: 5 }, { at: 9 }];
    expect(transitionsIn(rows, { from: 4, to: 10 })).toEqual({ inside: [{ at: 5 }, { at: 9 }], outside: 1 });
  });

  test("ships in a window: one marker per commit, the watch's own fix left out", () => {
    const win = { from: 0, to: 10 * D };
    const marks = shipMarks({
      win,
      deploys: [{ at: D, title: "Deployed v2 to production", sha: "abcdef1234" }, { at: 2 * D, title: "Deployed v3", sha: "9999999aaa" }, { at: 20 * D, title: "later" }],
      tasks: [{ _id: "t1", short_id: "ct-1", title: "Fix the intro email", landed: { sha: "abcdef1999", at: D - H, url: "https://x/commit/abcdef1" } }],
      skip: ["9999999"],
    });
    expect(marks.map((m) => [m.label, m.sub])).toEqual([["Fix the intro email", "abcdef1 · ct-1"]]);
    expect(marks[0]).toMatchObject({ kind: "deploy", href: "https://x/commit/abcdef1", also: { href: "/tasks/ct-1" } });
  });

  test("a query already watched on the source is found, whatever its spacing or argument order", () => {
    const ws = [{ source_id: "s1", query_kind: "reader", query: 'metrics.read {"key":"email_to_intro_rate","days":7}', short_id: "mw-12" }] as any[];
    expect(duplicateWatch(ws, "s1", "reader", 'metrics.read  {"days":7,"key":"email_to_intro_rate"}')?.short_id).toBe("mw-12");
    expect(duplicateWatch(ws, "s2", "reader", 'metrics.read {"key":"email_to_intro_rate","days":7}')).toBeNull();
    expect(queryIdentity("hogql", "SELECT  count()\nFROM events")).toBe(queryIdentity("hogql", "select count() from events"));
  });

  test("a HogQL pick writes one quoted query and a name", () => {
    expect(hogqlOfPick({ event: "$exception", agg: "count", window: "1h" })).toBe("SELECT count() FROM events WHERE event = '$exception' AND timestamp > now() - INTERVAL 1 HOUR");
    expect(hogqlOfPick({ event: "it's", agg: "people", window: "24h" })).toBe("SELECT count(DISTINCT person_id) FROM events WHERE event = 'it\\'s' AND timestamp > now() - INTERVAL 1 DAY");
    expect(nameOfPick({ event: "$pageview", agg: "people", window: "24h" })).toBe("People with $pageview per day");
    expect(eventRows({ results: [["a", 2], ["b", "9"], [null, 1]] })).toEqual([{ event: "b", count: 9 }, { event: "a", count: 2 }]);
  });
});

test("a source's counted series: events, issues and its busiest named events, a CI source's named as runs and failures", () => {
  const H = 3600_000;
  const now = Date.UTC(2026, 10, 4, 15, 20);
  const h = Math.floor(now / H) * H - H;
  const source = { provider: "github" as const, hours: [{ hour: h, events: 12 }], event_names: [{ name: "deploy", buckets: [{ hour: h, count: 2 }] }, { name: "quiet", buckets: [] }], groups_open: 4 };
  const groups = [{ first_seen: now - H, status: "open" }, { first_seen: now - H, status: "open", kind: "metric" }];
  const opts = volumeOptions(source, groups, now);
  // A CI source with kept runs leads with their failed share and run time; with none it offers neither.
  const timed = volumeOptions({ ...source, ci_runs: [{ at: now - H, ok: false, duration_ms: 120_000 }, { at: now - 2 * H, ok: true, duration_ms: 60_000 }] }, groups, now);
  expect(timed.slice(0, 3).map((o) => [o.query, o.value, o.unit])).toEqual([["ci_failure_rate", 50, "%"], ["ci_duration_p50", 1, "min"], ["ci_duration_p95", 2, "min"]]);
  expect(opts.map((o) => [o.query, o.label, o.value])).toEqual([
    ["events", "Runs per hour", 12],
    ["new_issues", "New failures, 24h", 1],
    ["open_issues", "Failing checks", 1],
    ["events:deploy", "deploy per hour", 2],
  ]);
  expect(volumePreview("open_issues", source, [], now)).toEqual({ value: 0, points: [], unit: null });
  expect(volumePreview("ci_duration_p95", { ...source, ci_runs: [{ at: now - H, ok: true, duration_ms: 9 * 60_000 }] }, [], now)).toMatchObject({ value: 9, unit: "min" });
  expect(volumePreview("nope", source, [], now)).toBeNull();
});

describe("round 6: cadence, scoped ships, one change, suggested lines", () => {
  const H = 3600_000;
  const D = 24 * H;

  test("a weekly series is one line through its weeks; a gap far past its cadence breaks it", () => {
    const weekly = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ at: i * 7 * D, value: 500 + i * 100 }));
    expect(lineRuns(weekly, H).map((r) => [r.sparse, r.points.length, r.step])).toEqual([[false, 9, 7 * D]]);
    const holed = [...weekly.slice(0, 5), ...weekly.slice(5).map((p) => ({ ...p, at: p.at + 60 * D }))];
    expect(lineRuns(holed, H).map((r) => r.points.length)).toEqual([5, 4]);
    // Two values alone are a line.
    expect(lineRuns([{ at: 0, value: 1 }, { at: 9 * D, value: 2 }], H).map((r) => r.points.length)).toEqual([2]);
  });

  test("ships are scoped to the watch's source and what is tied to it", () => {
    const sources = [
      { _id: "s-ph", name: "union-posthog" },
      { _id: "s-err", name: "union-errors" },
      { _id: "s-ci", name: "github-ci", project_id: "p-web" },
      { _id: "s-other", name: "acme-sentry" },
    ];
    const deploys = [
      { at: 1, title: "union release", source_id: "s-err" },
      { at: 2, title: "acme release", source_id: "s-other" },
      { at: 3, title: "by name", source: "union-posthog" },
    ];
    const landed = (repository: string, project_id?: string) => ({ _id: repository, landed: { sha: "abcdef0", at: 5, url: "u", repository }, project_id });
    const tasks = [landed("ashot/union"), landed("ashot/outreach"), landed("ashot/codecast", "p-web")];
    const r = relatedShips({ source: sources[0], sources, deploys, tasks });
    expect(r.deploys.map((d) => d.title)).toEqual(["union release", "by name"]);
    expect(r.tasks.map((t) => t._id)).toEqual(["ashot/union"]);
    // A project ties tasks and sources by id.
    const ci = relatedShips({ source: sources[2], sources, deploys, tasks });
    expect(ci.tasks.map((t) => t._id)).toEqual(["ashot/codecast"]);
    expect(relatedShips({ source: undefined, sources, deploys, tasks })).toEqual({ deploys: [], tasks: [] });
  });

  test("ships within a few pixels share one marker", () => {
    const mark = (at: number) => ({ at, kind: "deploy" as const, label: `s${at}` });
    const win = { from: 0, to: 1000 };
    const c = clusterShips([mark(10), mark(14), mark(17), mark(100), mark(2000)], win, 1000, 8);
    expect(c.map((x) => x.marks.length)).toEqual([3, 1]);
    expect(c[0].at).toBe(13.5);
  });

  test("the change is the newest span's mean against the span before, and nothing without both", () => {
    const end = 20 * D;
    const cur = [10, 20].map((value, i) => ({ at: end - i * D, value }));
    const prev = [10, 10].map((value, i) => ({ at: end - 8 * D - i * D, value }));
    const d = periodChange(cur, prev, 7 * D, end)!;
    expect([d.now, d.base, d.change, d.pct]).toEqual([15, 10, 5, 0.5]);
    expect(periodChange(cur, [], 7 * D, end)).toBeNull();
    expect(periodChange(cur, null, 7 * D, end)).toBeNull();
    // Values outside the two spans count for nothing.
    expect(periodChange([...cur, { at: end - 30 * D, value: 999 }], prev, 7 * D, end)!.now).toBe(15);
  });

  test("the overview sorts by the same change, watches without one last", () => {
    const ws = [watch({ _id: "a", name: "A" }), watch({ _id: "b", name: "B" }), watch({ _id: "c", name: "C" })];
    const by: Record<string, { pct: number | null; change: number; base: number } | null> = { a: { pct: 0.1, change: 1, base: 10 }, b: null, c: { pct: -0.5, change: -5, base: 10 } };
    expect(sortWatches(ws, "change", (w) => by[w._id] as never).map((w) => w._id)).toEqual(["c", "a", "b"]);
  });

  test("counts read at count precision", () => {
    expect(isIntegral([{ at: 0, value: 3 }, { at: 1, value: 4 }])).toBe(true);
    expect(formatMeasure(118.9583, null, true)).toBe("119");
    expect(formatMeasure(70.843, null, true)).toBe("70.8");
    expect(formatMeasure(0.4567, null, false)).toBe("0.46");
  });

  test("a series suggests lines from its history, each counted against it", () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ at: i * H, value: i % 10 === 0 ? 50 : 10 + (i % 5) }));
    const d = distribution(pts)!;
    expect(d.n).toBe(100);
    expect(d.bins.reduce((s, c) => s + c, 0)).toBe(100);
    const above = lineSuggestions(pts, "above");
    expect(above.map((s) => s.key)).toContain("p95");
    for (const s of above) expect(s.crossings).toBe(wouldCross(pts, s.value, "above"));
    expect(lineSuggestions(pts, "below").every((s) => s.value <= 14)).toBe(true);
    expect(lineSuggestions(pts.map((p) => ({ ...p, value: 3 })), "above")).toEqual([]);
    expect(distribution(pts.slice(0, 2))).toBeNull();
  });

  test("a line past every held value that never fired is not suggested, and the side follows the tail", () => {
    // A cost that sits near its floor and spikes up: nothing below would ever fire.
    const cost = Array.from({ length: 60 }, (_, i) => ({ at: i * H, value: i % 12 === 0 ? 2400 : 514 + (i % 7) * 30 }));
    expect(suggestDirection(cost)).toBe("above");
    for (const s of lineSuggestions(cost, "below")) expect(s.crossings > 0 || s.value >= 514).toBe(true);
    expect(lineSuggestions(cost, "below").some((s) => s.key === "3sd")).toBe(false);
    expect(lineSuggestions(cost, "above").length).toBeGreaterThan(0);
    const drops = cost.map((p) => ({ ...p, value: 3000 - p.value }));
    expect(suggestDirection(drops)).toBe("below");
  });

  test("test and probe events are never offered as series", () => {
    expect(["codecast.test", "smoke_run", "synthetic-check", "$pageview", "signup_completed", "contest_entered"].filter((n) => !isTestEventName(n))).toEqual(["$pageview", "signup_completed", "contest_entered"]);
  });
});

describe("window names and card joins", () => {
  const D = 86_400_000;
  test("a range names its length, All where it starts", () => {
    const win = { from: Date.UTC(2026, 9, 5, 12), to: Date.UTC(2026, 10, 4, 12) };
    expect(windowName(win, false)).toEqual({ short: "30d", within: "in 30d" });
    expect(windowName(win, true).short).toMatch(/^since Oct 5$/);
  });
  test("a card joins over a gap the full chart breaks at", () => {
    const pts = [0, 1, 2, 3, 7, 8, 9].map((d) => ({ at: d * D, value: d }));
    expect(lineRuns(pts, D).length).toBe(2);
    expect(lineRuns(pts, D, 6).length).toBe(1);
  });
});

describe("metrics round 4", () => {
  test("All reads its change off the 7d range's own series, so the label is one number at All, at 7d and on the card", () => {
    expect(changeRange("all")).toBe("7d");
    expect(changeRange("30d")).toBe("30d");
    expect(seriesKey("w", { kind: "range", range: changeRange("all") }, 300)).toBe(seriesKey("w", { kind: "range", range: "7d" }, 300));
    expect(seriesKey("w", { kind: "prev", range: changeRange("all") }, 80)).toBe(seriesKey("w", { kind: "prev", range: "7d" }, 80));
    // The same values give the same change whichever range asked for them.
    const end = 40 * D;
    const cur = Array.from({ length: 7 * 24 }, (_, i) => ({ at: end - i * H, value: 100 + (i % 9) }));
    const prev = Array.from({ length: 7 * 24 }, (_, i) => ({ at: end - 7 * D - i * H, value: 150 + (i % 5) }));
    const at7d = periodChange(cur, prev, changeSpan("7d"), end)!;
    const atAll = periodChange(cur, prev, changeSpan("all"), end)!;
    expect(atAll).toEqual(at7d);
  });

  test("a mean over mixed cadence weighs each value by how long it stood", () => {
    // Three weekly values, then a day of 10-minute polls of one value.
    const weekly = [1000, 1600, 1200].map((value, i) => ({ at: i * 7 * D, value }));
    const polls = Array.from({ length: 144 }, (_, i) => ({ at: 21 * D + i * 10 * 60_000, value: 900 }));
    const st = stats([...weekly, ...polls])!;
    expect(st.uneven).toBe(true);
    // The plain mean is pulled to ~911 by the polls; time-weighted, three weeks against a day.
    expect(st.avg).toBeGreaterThan(1200);
    expect(st.avg).toBeLessThan(1300);
    const d = distribution([...weekly, ...polls])!;
    expect(d.uneven).toBe(true);
    expect(d.p50).toBeGreaterThan(1000);
    expect(d.bins.reduce((a, b) => a + b, 0)).toBeCloseTo(d.n, 6);
    // Evenly spaced values weigh the same: the plain mean and the usual percentiles.
    const even = [3, 1, 4, 1, 5, 9, 2, 6].map((value, i) => ({ at: i * H, value }));
    expect(stats(even)!.avg).toBeCloseTo(31 / 8, 9);
    expect(stats(even)!.uneven).toBe(false);
    expect(distribution(even)!.p50).toBeCloseTo(3.5, 9);
    expect(timeWeights(even).w.every((w) => w === H)).toBe(true);
  });

  test("a window that opens mid-alert infers no crossing at its edge", () => {
    const pts = [130, 125, 140, 10, 140].map((value, i) => ({ at: i * H, value }));
    expect(crossings(pts, 15, "above").map((c) => [c.kind, c.at])).toEqual([["crossed", 0], ["recovered", 3 * H], ["crossed", 4 * H]]);
    expect(crossings(pts, 15, "above", true).map((c) => [c.kind, c.at])).toEqual([["recovered", 3 * H], ["crossed", 4 * H]]);
  });

  test("open issues have a past read off first sightings and resolves, and the count names the open ones", () => {
    const now = 30 * D + 5 * H;
    const groups = [
      { first_seen: 2 * D, status: "open", short_id: "eg-1", last_seen: now - H },
      { first_seen: 10 * D, status: "resolved", resolved_at: 20 * D, short_id: "eg-2" },
      { first_seen: 5 * D, status: "open", kind: "metric", short_id: "eg-3" },
    ];
    const h = openHistory(groups, now, 30);
    expect(h).toHaveLength(30);
    expect(h[h.length - 1]).toEqual({ at: now, value: 1 });
    expect(h.find((p) => p.at === 15 * D)!.value).toBe(2);
    const ci = volumeOptions({ provider: "github", ci_runs: [{ at: now - H, ok: false, duration_ms: 60_000 }] } as never, groups, now);
    const failing = ci.find((o) => o.query === "open_issues")!;
    expect(failing.label).toBe("Failing checks");
    expect(failing.open).toEqual(["eg-1"]);
    expect(failing.points.length).toBeGreaterThan(1);
    expect(failing.value).toBe(1);
  });
});

test("a line rounded to a fractional scale reads clean", () => {
  expect(String(roundToScale(99.60000000000001, 50))).toBe("99.6");
  expect(roundToScale(1234.5, 5000)).toBe(1230);
});

describe("round 5: one change, honest loading, bands that end at the recovery", () => {
  const end = 20 * D;
  const series = (pts: { at: number; value: number }[], to = end) => ({ points: pts, to, held_from: pts[0]?.at ?? null });
  const cardCur = series([0, 1, 2, 3, 4, 5, 6].map((i) => ({ at: end - i * D - H, value: 90 + i })));
  const cardPrev = series([0, 1, 2, 3, 4, 5, 6].map((i) => ({ at: end - 7 * D - i * D - H, value: 95 + i })), end - 7 * D);

  test("the page and the overview read the change through one function off the same card series, whatever arrived first", () => {
    // The overview card's call and the page's call, in either order: the same inputs give the same WindowDelta.
    const card = rangeChange(cardCur, cardPrev, [], "7d", end);
    const page = rangeChange(cardCur, cardPrev, [], "7d", end);
    expect(page).toEqual(card);
    // All reads the 7d change off the same series.
    expect(rangeChange(cardCur, cardPrev, [], "all", end)).toEqual(card);
    // Nothing yet from the card series: no number, never a number from another input.
    expect(rangeChange(undefined, cardPrev, [{ at: end - H, value: 1 }], "7d", end)).toBeNull();
  });

  test("the change ends at the newest value held, so a card's coarse clock and the page's finer one read the same number", () => {
    const cardClock = rangeChange(cardCur, cardPrev, [], "7d", end - 50_000);
    const pageClock = rangeChange(cardCur, cardPrev, [], "7d", end + 20 * 60_000);
    expect(cardClock).not.toBeNull();
    expect(pageClock).toEqual(cardClock);
  });

  test("an elapsed duration floors and names two units, so 2.5 days stays 2d 12h", () => {
    expect(durationShort(2.5 * D)).toBe("2d 12h");
    expect(durationShort(2 * D + 59 * 60_000)).toBe("2d");
    expect(durationShort(4 * H + 30 * 60_000)).toBe("4h 30m");
    expect(durationShort(59 * 60_000 + 59_000)).toBe("59m");
    expect(durationShort(12_000)).toBe("12s");
  });

  test("a run cut at the window: no point outside it, the edge interpolated from the neighbour", () => {
    const win = { from: 10, to: 20 };
    expect(clipRunToWindow([{ at: 0, value: 0 }, { at: 15, value: 15 }, { at: 30, value: 30 }], win)).toEqual([
      { at: 10, value: 10 }, { at: 15, value: 15 }, { at: 20, value: 20 },
    ]);
    // Two neighbours straddling the whole window: the segment across it.
    expect(clipRunToWindow([{ at: 0, value: 0 }, { at: 40, value: 40 }], win)).toEqual([{ at: 10, value: 10 }, { at: 20, value: 20 }]);
    // All outside on one side: nothing.
    expect(clipRunToWindow([{ at: 0, value: 0 }, { at: 5, value: 5 }], win)).toEqual([]);
  });

  test("a change still on its way is reading, and absence is said only after the answer", () => {
    expect(changeState(null, false)).toBe("reading");
    expect(changeState(null, true)).toBe("none");
    expect(changeState(rangeChange(cardCur, cardPrev, [], "7d", end), false)).toBe("value");
  });

  test("while the live answer is on its way the page paints the held answer reaching furthest back", () => {
    const shortDetail = series([{ at: end - D, value: 1 }]);
    const card = series([{ at: end - 5 * D, value: 1 }, { at: end - D, value: 2 }], end - H);
    expect(fullestHeld(shortDetail, card)).toBe(card);
    expect(fullestHeld(undefined, shortDetail)).toBe(shortDetail);
    const newer = series([{ at: end - D, value: 1 }], end + H);
    expect(fullestHeld(shortDetail, newer)).toBe(newer);
    expect(fullestHeld(undefined, undefined)).toBeUndefined();
  });

  test("bands follow the transitions list: a crossing to its recovery, an open one to the end", () => {
    const rows = [
      { at: 10, kind: "crossed" as const },
      { at: 20, kind: "recovered" as const },
      { at: 30, kind: "crossed" as const },
    ];
    expect(bandsFromTransitions(rows, 50)).toEqual([{ from: 10, to: 20 }, { from: 30, to: 50 }]);
    // A second crossing before the recovery keeps the first start.
    expect(bandsFromTransitions([{ at: 5, kind: "crossed" }, ...rows], 50)[0]).toEqual({ from: 5, to: 20 });
    // A value equal to the line is not past it, so the recovery the list names ends the band, never a later value.
    const pts = [{ at: 1, value: 20 }, { at: 2, value: 15 }, { at: 3, value: 16 }];
    const listed = transitionRows([{ at: 1, kind: "crossed", value: 20 }, { at: 2, kind: "recovered", value: 15 }], crossings(pts, 15, "above", true), 0);
    expect(bandsFromTransitions(listed.filter((r) => !r.inferred), 9)).toEqual([{ from: 1, to: 2 }]);
  });

  test("the running alert's crossing is pinned whatever the range", () => {
    const rows = [{ at: 10, kind: "crossed" as const, value: 19 }, { at: 20, kind: "recovered" as const, value: 3 }, { at: 30, kind: "crossed" as const, value: 21 }];
    expect(runningCrossing(rows, 30)).toBe(rows[2]);
    expect(runningCrossing(rows, null)).toBeNull();
    // No announcement on this device: the episode's start stands in.
    expect(runningCrossing(rows.slice(0, 2), 40)).toEqual({ at: 40, kind: "crossed", value: null });
  });

  test("the share of time past the line is time-weighted, a value on the line not past it", () => {
    const pts = [{ at: 0, value: 10 }, { at: 3 * H, value: 20 }, { at: 4 * H, value: 15 }];
    // 10 stood 3h, 20 stood 1h, 15 (on the line) 1h: 1 of 5 hours past.
    expect(sharePast(pts, 15, "above")).toBe(20);
    expect(sharePast(pts, 15, "below")).toBe(60);
    expect(sharePast([], 15, "above")).toBe(0);
  });
});

describe("missing data and a count's precision", () => {
  const H = 3_600_000;
  test("a gap several times the poll is a hole, with the polls it missed; a steady weekly series has none", () => {
    const hourly = [0, 1, 2, 3, 54, 55, 56].map((h) => ({ at: h * H, value: 1 }));
    expect(dataHoles(hourly, H)).toEqual([{ from: 3 * H, to: 54 * H, missed: 50 }]);
    const weekly = [0, 1, 2, 3].map((w) => ({ at: w * 168 * H, value: 1 }));
    expect(dataHoles(weekly, H)).toEqual([]);
    // A daily backfill running into hourly polls is a change of cadence, not a hole.
    const mixed = [...[0, 1, 2].map((d) => ({ at: d * 24 * H, value: 1 })), ...[0, 1, 2, 3].map((h) => ({ at: 3 * 24 * H + h * H, value: 1 }))];
    expect(dataHoles(mixed, H)).toEqual([]);
  });
  test("an alert band is cut where a hole runs through it", () => {
    expect(cutHoles([{ from: 0, to: 10 }], [{ from: 3, to: 6 }])).toEqual([{ from: 0, to: 3 }, { from: 6, to: 10 }]);
    expect(cutHoles([{ from: 0, to: 10 }], [{ from: 12, to: 16 }])).toEqual([{ from: 0, to: 10 }]);
  });
  test("a count is judged on the values the watch read, never on a range's folded means", () => {
    expect(measuresCount([{ at: 0, value: 3 }], [{ at: 0, value: 55.12 }])).toBe(true);
    expect(measuresCount([], [{ at: 0, value: 55.12 }])).toBe(false);
  });
});
