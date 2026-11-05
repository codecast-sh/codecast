import { describe, expect, test } from "bun:test";
import { alertBands, alertSince, crossings, filterWatches, groupWatches, healthCounts, inWindow, margin, niceTicks, previousPeriod, priorDelta, rangeWindow, segments, sortWatches, watchHealth, yDomain, METRICS_QUERY_DEFAULT, metricsQueryParams, parseMetricsQuery, tickLabels, tickStep, timeTicks, breaksIn, continuousTail, fitStart, lineRuns } from "./metricModel";
import { cardWindow, changeTone, chartPoints, seriesArgs, seriesKey, windowChange } from "./metricSeries";
import { watchMarks, windowAround, alertEpisodes, currentEpisodeSince, episodeSummary, errorRollups, transitionRows, watchErrorText, wouldCross } from "./metricEvents";
import { hogqlFirstCell, parseThreshold, argFields, readerQueryText, readerQueryValues, allWindow, argOptions, argSourceReader, bandAt, changeFromZero, hintFields, readerAnswersNumber } from "./metricEditing";
import { D, H, NOW, watch } from "./metricTestFixtures";

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
