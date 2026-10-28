import { describe, expect, test } from "bun:test";
import { formatSeriesValue, parseReaderQuery, readMetricAnswer } from "./ingest";
import { metricLine, metricReading, metricReadings, metricSpec, metricTrends, paceWords, parseMetricSpec, type MetricSeries } from "./initiative";
import { experimentDue, parsePlaybook } from "./rolePlaybook";
import { METRIC_CLIMB_GUIDANCE } from "./metricClimb";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 12);

describe("a metric reader's answer", () => {
  test("names the reader and its JSON args", () => {
    expect(parseReaderQuery('metrics.read {"key":"dollars_per_intro"}')).toEqual({ reader: "metrics.read", args: { key: "dollars_per_intro" } });
    expect(parseReaderQuery("metrics.list")).toEqual({ reader: "metrics.list", args: {} });
    expect(parseReaderQuery("metrics.read [1]")).toEqual({ error: "A reader watch's args are a JSON object" });
  });
  test("reads the number, the unit and the dated points, oldest first, dropping what is not a number", () => {
    expect(readMetricAnswer({ value: 382, unit: "$", points: [{ at: "2026-10-20T00:00:00Z", value: 395 }, { at: 1, value: 1 }, { at: "nope", value: 3 }, { at: 2, value: null }] }))
      .toEqual({ value: 382, unit: "$", points: [{ at: 1, value: 1 }, { at: Date.parse("2026-10-20T00:00:00Z"), value: 395 }] });
    expect(readMetricAnswer(12)).toEqual({ value: 12, unit: null, points: [] });
    expect(readMetricAnswer({ value: "12" })).toEqual({ value: null, unit: null, points: [] });
  });
  test("writes a value in its unit the way a person does", () => {
    expect(formatSeriesValue(382.4, "$")).toBe("$382");
    expect(formatSeriesValue(0.1234, "%")).toBe("0.12%");
    expect(formatSeriesValue(4231.6, "/day")).toBe("4,232/day");
    expect(formatSeriesValue(12.34, "deals")).toBe("12.3 deals");
    expect(formatSeriesValue(-5, "$")).toBe("-$5");
  });
});

describe("a goal's number read from its live series", () => {
  const series: MetricSeries = { short_id: "mw-12", name: "Dollars per intro", unit: "$", points: [{ at: NOW - 6 * DAY, value: 410 }, { at: NOW - 2 * DAY, value: 395 }, { at: NOW - 3600_000, value: 382 }] };
  const metric = { key: "dollars_per_intro", name: "Dollars per intro", target: "under $250", series: "mw-12" };

  test("the latest point is the value, live, and the week of points is the trend", () => {
    const r = metricReading(metric, { value: "999", observed_at: 1, source: "old report" }, series);
    expect(r).toMatchObject({ value: "$382", standing: "behind", live: true, observed_at: NOW - 3600_000, source: "mw-12 Dollars per intro", unit: "$" });
    const t = metricTrends({ metrics: [metric] }, () => series)[metric.key];
    expect(t).toMatchObject({ direction: "down", toward: true });
    expect(metricLine(r, NOW, t)).toBe("Dollars per intro: $382, target under $250, behind; down from $410, toward the target (live mw-12, today)");
  });
  test("a series with no point yet, or a missing one, falls back to the last report", () => {
    expect(metricReadings({ metrics: [metric], scoreboard: { dollars_per_intro: { value: "$400", observed_at: 5, source: "x" } } }, () => undefined)[0]).toMatchObject({ value: "$400", live: false });
    expect(metricLine(metricReading(metric, null, { ...series, points: [] }), NOW)).toBe("Dollars per intro: no reading yet from its live series, target under $250");
  });
  test("a goal behind its date says the pace it needs against the pace it moves at", () => {
    const r = metricReading({ key: "cold", name: "Cold emails a day", target: "10,000", series: "mw-1" }, null, { short_id: "mw-1", name: "Cold", unit: "/day", points: [{ at: NOW - 7 * DAY, value: 300 }, { at: NOW, value: 1000 }] });
    const t = metricTrends({ metrics: [{ key: "cold", name: "c", target: "10,000", series: "mw-1" }] }, () => ({ short_id: "mw-1", name: "Cold", unit: "/day", points: [{ at: NOW - 7 * DAY, value: 300 }, { at: NOW, value: 1000 }] })).cold;
    expect(paceWords(r, t, NOW + 9 * 7 * DAY, NOW)).toBe("needs +1,000/day a week to reach 10,000 by 29 Dec; moving +700/day a week");
    expect(paceWords({ ...r, standing: "met" }, t, NOW + DAY, NOW)).toBe("");
    expect(paceWords(r, t, null, NOW)).toBe("");
  });
});

describe("a metric as typed", () => {
  test("name=target, @mw-N for a live series, guardrail to mark one, and back", () => {
    expect(parseMetricSpec("Dollars per intro=under $250 @mw-12")).toEqual({ name: "Dollars per intro", target: "under $250", series: "mw-12" });
    expect(parseMetricSpec("Bounce rate=under 3% @MW-14 guardrail")).toEqual({ name: "Bounce rate", target: "under 3%", series: "mw-14", guardrail: true });
    expect(parseMetricSpec("Weekly active teams=1000")).toEqual({ name: "Weekly active teams", target: "1000" });
    expect(parseMetricSpec("=1000")).toBeNull();
    expect(parseMetricSpec("Teams=@mw-3")).toBeNull();
    expect(metricSpec({ name: "Bounce rate", target: "under 3%", series: "mw-14", guardrail: true })).toBe("Bounce rate=under 3% @mw-14 guardrail");
  });
});

describe("the experiment log", () => {
  test("reads each try's read day and outcome, and which are due", () => {
    const p = parsePlaybook([
      "## Experiments",
      "- 2026-10-20: Shorter first email for intro rate, because long ones read as templates; expect 0.12% to 0.16%, read 2026-10-27. Result: kept, 0.15%.",
      "- 2026-10-22: Drop the second follow up for dollars per intro; expect $382 to $350, read 2026-10-29.",
    ].join("\n"));
    expect(p.experiments.map((x) => [x.written_on, x.read_on, x.outcome])).toEqual([["2026-10-20", "2026-10-27", "kept"], ["2026-10-22", "2026-10-29", null]]);
    expect(p.experiments.map((x) => experimentDue(x, Date.UTC(2026, 9, 30)))).toEqual([false, true]);
  });
  test("the climbing guidance names the log it asks for", () => {
    expect(METRIC_CLIMB_GUIDANCE.join(" ")).toContain("## Experiments");
    expect(METRIC_CLIMB_GUIDANCE.join(" ")).toContain("guardrail");
  });
});
