// The metric model's later rounds: sparse ticks, prior-period change, ships,
// duplicates, HogQL picks, cadence, suggested lines, card joins, loading and
// missing data.
import { describe, expect, test } from "bun:test";
import { windowName, crossings, sortWatches, lineRuns, formatMeasure, isIntegral, stats, timeWeights, clipRunToWindow, durationShort, ticksOf, dataHoles, cutHoles, measuresCount } from "./metricModel";
import { seriesKey, periodChange, changeRange, changeSpan, changeState, fullestHeld, rangeChange, changeAmount, tinyBaseline, windowDelta } from "./metricSeries";
import { transitionRows, wouldCross, clusterShips, distribution, lineSuggestions, suggestDirection, relatedShips, bandsFromTransitions, runningCrossing, sharePast, shipMarks, transitionsIn } from "./metricEvents";
import { isTestEventName, openHistory, roundToScale, volumeOptions, duplicateWatch, volumeOptions, volumePreview, eventRows, hogqlOfPick, nameOfPick, queryIdentity } from "./metricEditing";
import { D, H, watch } from "./metricTestFixtures";

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
    const mixed = [...[0, 1, 2, 3, 4, 5].map((d) => ({ at: d * 24 * H, value: 1 })), ...[0, 1, 2, 3].map((h) => ({ at: 6 * 24 * H + h * H, value: 1 }))];
    expect(dataHoles(mixed, H)).toEqual([]);
  });
  test("lone values and pairs inside an outage do not hide it", () => {
    // Hourly polls, then a pair a day apart and a lone value, then hourly again.
    const pts = [0, 1, 2, 3, 20, 50, 62, 90, 91, 92, 93].map((h) => ({ at: h * H, value: 1 }));
    const holes = dataHoles(pts, H);
    expect(holes.length).toBeGreaterThan(0);
    expect(holes[holes.length - 1].to).toBe(90 * H);
  });
  test("daily values running into hourly polls are not holes; the stretch after the last one is", () => {
    // Daily at 11:30, a lone value 36h later, then hourly 12h after it.
    const daily = [0, 24, 48, 72].map((h) => ({ at: h * H, value: 120 }));
    const pts = [...daily, { at: 108 * H, value: 57 }, ...[120, 121, 122, 123].map((h) => ({ at: h * H, value: 20 }))];
    expect(dataHoles(pts, H, H)).toEqual([{ from: 108 * H, to: 120 * H, missed: 11 }]);
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
