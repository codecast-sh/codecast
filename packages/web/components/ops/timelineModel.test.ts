import { describe, expect, test } from "bun:test";
import { admits, admitsSample, clusterByPixels, fillEstimates, clusterSpan, counterBins, dayRange, facetCounts, fitPreset, formatRange, histogram, markUnloaded, niceMax, occurrencePoints, parseRange, parseTimelineQuery, sampleFacetCounts, sampleFacets, seriesLabel, splitLevel, stackKeys, toggleFacet, unknownUntil, overlayBins, UNMATCHED, vendorStreamUrl, nearestReplay, rangeTicks, tickBudget, streamAxis, foldRepeats, foldedIds } from "./timelineModel";
import { requestLine } from "./sourceViewModel";
import type { OpsEvent } from "./opsTypes";

const NOW = Date.UTC(2026, 10, 3, 12);
const H = 3600_000;
const ev = (o: Partial<OpsEvent> & { at: number; source?: string; transition?: any; level?: string; group_kind?: any }): OpsEvent => ({
  _id: `e${o.at}${o.title ?? ""}`, workspace: "team:t", source: o.source ?? "web", kind: o.kind ?? o.transition ?? "new", title: o.title ?? "Boom",
  data: { source_name: o.source ?? "web", transition: o.transition, level: o.level, group_kind: o.group_kind, group_short_id: "eg-1" }, created_at: o.at,
} as OpsEvent);

describe("the query", () => {
  test("facet tokens and free text round-trip", () => {
    const f = parseTimelineQuery('source:web,"my app" kind:error checkout failed');
    expect([...f.facets.source]).toEqual(["web", "my app"]);
    expect([...f.facets.kind]).toEqual(["error"]);
    expect(f.text).toBe("checkout failed");
    expect(toggleFacet('source:web checkout', "source", "api")).toBe("source:web,api checkout");
    expect(toggleFacet("source:web", "source", "web")).toBe("");
    expect(toggleFacet("source:web,api", "source", "api", true)).toBe("source:api");
  });

  test("a facet's counts ignore its own pick, and other facets narrow them", () => {
    const events = [ev({ at: NOW - H, source: "web", group_kind: "error" }), ev({ at: NOW - H, source: "api", group_kind: "error" }), ev({ at: NOW - H, source: "api", group_kind: "job" })];
    const f = parseTimelineQuery("source:web kind:error");
    const c = facetCounts(events, f);
    expect(c.source).toEqual([{ value: "api", n: 1 }, { value: "web", n: 1 }]);
    expect(c.kind).toEqual([{ value: "error", n: 1 }]);
    expect(events.filter((e) => admits(e, f)).length).toBe(1);
    expect(events.filter((e) => admits(e, parseTimelineQuery("boom eg-1"))).length).toBe(3);
  });
});

describe("the range", () => {
  test("a preset moves with now; a span is fixed and survives the URL", () => {
    expect(parseRange("6h", NOW)).toEqual({ from: NOW - 6 * H, to: NOW, preset: "6h" });
    const span = { from: NOW - 5 * H, to: NOW - 2 * H, preset: null };
    expect(parseRange(formatRange(span), NOW)).toEqual(span);
    expect(parseRange("junk", NOW).preset).toBe("24h");
    expect(dayRange("2026-11-01", NOW)!.to - dayRange("2026-11-01", NOW)!.from).toBe(24 * H);
    expect(dayRange("2027-01-01", NOW)).toBeNull();
  });

  test("it opens on the smallest preset holding the month's events", () => {
    expect(fitPreset([{ created_at: NOW - 3 * H }], NOW)).toBe("6h");
    expect(fitPreset([{ created_at: NOW - 18 * 24 * H }], NOW)).toBe("30d");
    expect(fitPreset([], NOW)).toBe("24h");
  });
});

describe("the histogram", () => {
  test("points stack by key into bins across the range", () => {
    const pts = occurrencePoints([{ source_id: "s", kind: "error", level: "error", buckets: [{ hour: NOW - 2 * H, count: 5 }] }, { source_id: "s", kind: "job", buckets: [{ hour: NOW - 2 * H, count: 2 }] }]);
    const bins = histogram(pts, (p) => p.at, (p) => p.key, (p) => p.n, { from: NOW - 6 * H, to: NOW }, H);
    expect(bins.reduce((n, b) => n + b.total, 0)).toBe(7);
    expect(stackKeys(bins)).toEqual(["error", "job"]);
  });
});

describe("lanes in pixels", () => {
  test("marks closer than a pill merge, and a narrow track merges more", () => {
    const marks = [{ x: 0.1 }, { x: 0.12 }, { x: 0.5 }];
    expect(clusterByPixels(marks, 1000, 18).map((c) => c.marks.length)).toEqual([1, 1, 1]);
    expect(clusterByPixels(marks, 300, 18).map((c) => c.marks.length)).toEqual([2, 1]);
    expect(clusterSpan([{ event: { created_at: NOW } }])).toEqual({ from: NOW - 60_000, to: NOW + 60_000 });
  });
});

describe("the stream's chart reads the server's series", () => {
  const DAYMS = 86_400_000;
  const T = Date.UTC(2026, 10, 3, 12);
  const day = (o: number) => new Date(T - o * DAYMS).toISOString().slice(0, 10);
  test("counterBins sums the sources' day counters and leaves days before any counter unknown", () => {
    const a = { days: [{ day: day(2), events: 5, dropped: 0 }, { day: day(0), events: 1, dropped: 0 }] };
    const b = { days: [{ day: day(0), events: 2, dropped: 0 }] };
    const bins = counterBins([a, b], { from: T - 4 * DAYMS, to: T });
    expect(bins.map((x) => (x.unknown ? null : x.total))).toEqual([null, null, 5, 0, 3]);
  });

  test("markUnloaded shades empty bins older than the rows held while more exist", () => {
    const bins = [{ from: 0, to: 10, parts: {}, total: 0 }, { from: 10, to: 20, parts: { new: 1 }, total: 1 }, { from: 20, to: 30, parts: {}, total: 0 }];
    expect(markUnloaded(bins, 15, true).map((x) => !!x.unknown)).toEqual([true, false, false]);
    expect(markUnloaded(bins, 15, false).some((x) => x.unknown)).toBe(false);
    expect(unknownUntil(markUnloaded(bins, 15, true))).toBe(10);
  });

  test("niceMax rounds an axis to the next fine step of a power of ten", () => {
    expect([niceMax(0), niceMax(7), niceMax(13), niceMax(217), niceMax(260), niceMax(5000)]).toEqual([1, 8, 15, 250, 300, 5000]);
  });

  test("series read as words", () => {
    expect(seriesLabel("rage_click")).toBe("rage clicks");
    expect(seriesLabel("metric_recovered")).toBe("metrics recovered");
    expect(seriesLabel("some_new_thing")).toBe("some new thing");
  });
});

describe("occurrences go through the same facets", () => {
  const sources = new Map([["s1", { name: "union-errors" }]]);
  const groups = new Map([["g1", { kind: "error" as const, level: "error" }]]);
  test("source, kind and level apply; status does not; words search message, url and user", () => {
    const x = { source_id: "s1", group_id: "g1", message: "TypeError: x is undefined", url: "https://app.test/checkout", user: { email: "ada@x.org" } };
    const v = sampleFacets(x, sources, groups);
    expect(v).toEqual({ source: "union-errors", kind: "error", type: null, level: "error", status: null });
    expect(admitsSample(v, x, parseTimelineQuery("level:error checkout"))).toBe(true);
    expect(admitsSample(v, x, parseTimelineQuery("status:new ada@x.org"))).toBe(true);
    expect(admitsSample(v, x, parseTimelineQuery("source:web"))).toBe(false);
    const counts = sampleFacetCounts([x], (s) => sampleFacets(s, sources, groups), parseTimelineQuery(""));
    expect(counts.level).toEqual([{ value: "error", n: 1 }]);
    expect(counts.status).toEqual([]);
  });
});

describe("levels and types are separate facets", () => {
  test("a vendor's event type in the level field is a type", () => {
    expect(splitLevel("Error")).toEqual({ level: "error", type: null });
    expect(splitLevel("rage_click")).toEqual({ level: null, type: "rage_click" });
    expect(splitLevel(undefined)).toEqual({ level: null, type: null });
    expect([...parseTimelineQuery("type:request level:error").facets.type]).toEqual(["request"]);
  });

  test("metric readings stay out of occurrences until the Kind facet names them", () => {
    const v = { source: "s", kind: "metric", type: null, level: null, status: null };
    expect(admitsSample(v, {}, parseTimelineQuery(""))).toBe(false);
    expect(admitsSample(v, {}, parseTimelineQuery("kind:metric"))).toBe(true);
    // The Kind facet still counts them, so they can be turned on.
    const counts = sampleFacetCounts([{}], () => v, parseTimelineQuery(""));
    expect(counts.kind).toEqual([{ value: "metric", n: 1, off: true }]);
    expect(counts.source).toEqual([]);
  });
});

describe("an occurrence's level comes from what happened, its type stays its type", () => {
  const groups = new Map([["g", { kind: "replay_issue" as const, level: "request" }]]);
  const sources = new Map([["s", { name: "union-posthog" }]]);
  test("a request reads warning on a 4xx and error on a 5xx or no answer, typed request", () => {
    const at = (msg: string) => sampleFacets({ source_id: "s", group_id: "g", level: "request", message: msg }, sources, groups);
    expect(at("GET https://admin.union.test/api/desk/retro/marks -> 404 (2026 ms)")).toMatchObject({ level: "warning", type: "request" });
    expect(at("POST https://admin.union.test/api/x -> 502 (31 ms)")).toMatchObject({ level: "error", type: "request" });
    expect(at("GET https://admin.union.test/api/x -> failed (0 ms)")).toMatchObject({ level: "error", type: "request" });
  });
  test("the row reads the path and status, the host dropped", () => {
    expect(requestLine("GET https://admin.union.test/api/desk/retro/marks?x=1 -> 404 (2026 ms)")).toEqual({ method: "GET", path: "/api/desk/retro/marks?x=1", status: "404", code: 404, ms: 2026 });
    expect(requestLine("TypeError: x")).toBeNull();
  });
  test("the kind facet's on values add up to the rows listed; a metric reading is offered, marked off", () => {
    const rows = [{ k: "replay_issue" }, { k: "replay_issue" }, { k: "metric" }];
    const counts = sampleFacetCounts(rows as any[], (r: any) => ({ source: "s", kind: r.k, type: null, level: null, status: null }), parseTimelineQuery(""));
    expect(counts.kind).toEqual([{ value: "replay_issue", n: 2 }, { value: "metric", n: 1, off: true }]);
    expect(counts.kind.filter((r) => !r.off).reduce((n, r) => n + r.n, 0)).toBe(2);
  });
  test("a facet some rows have no value for closes with those rows, so each group adds up to the rows kept", () => {
    const rows = [{ t: "request" }, { t: null }, { t: null }];
    const counts = sampleFacetCounts(rows as any[], (r: any) => ({ source: "s", kind: "replay_issue", type: r.t, level: "error", status: null }), parseTimelineQuery(""));
    expect(counts.type).toEqual([{ value: "request", n: 1 }, { value: "", n: 2, none: true }]);
    expect(counts.level).toEqual([{ value: "error", n: 3 }]);
    // Picking a type lists only that type: no remainder beside it.
    expect(sampleFacetCounts(rows as any[], (r: any) => ({ source: "s", kind: "replay_issue", type: r.t, level: "error", status: null }), parseTimelineQuery("type:request")).type).toEqual([{ value: "request", n: 1 }]);
  });
});

describe("the chart counts the filter", () => {
  test("matching rows sit under a faint rest of the counter, and the matched total is the rows'", () => {
    const D = 86_400_000;
    const total = [{ from: 0, to: D, parts: { events: 10 }, total: 10 }, { from: D, to: 2 * D, parts: { events: 4 }, total: 4 }];
    const { bins, matched } = overlayBins(total, [{ at: 5, key: "error" }, { at: D + 1, key: "error" }, { at: D + 2, key: "warning" }]);
    expect(matched).toBe(3);
    expect(bins[0].parts).toEqual({ error: 1, [UNMATCHED]: 9 });
    expect(bins[1]).toMatchObject({ parts: { error: 1, warning: 1, [UNMATCHED]: 2 }, total: 4 });
  });

  test("the vendor lists every event in the window", () => {
    const r = { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 2) };
    const ph = vendorStreamUrl({ provider: "posthog", vendor_web_url: "https://us.posthog.com/project/42/" }, r)!;
    expect(ph.startsWith("https://us.posthog.com/project/42/activity/explore#q=")).toBe(true);
    expect(decodeURIComponent(ph.split("#q=")[1])).toContain('"after":"2026-11-01T00:00:00.000Z"');
    const se = vendorStreamUrl({ provider: "sentry", config: { org: "acme" } }, r, parseTimelineQuery("level:error"))!;
    expect(se).toContain("https://sentry.io/organizations/acme/issues/?");
    expect(se).toContain("query=level%3Aerror");
    expect(vendorStreamUrl({ provider: "sdk" }, r)).toBeNull();
  });
});

describe("an event's replay", () => {
  test("the recording running at the moment, else the nearest one that showed the issue", () => {
    const r = (id: string, started_at: number, duration_ms: number, group_ids = ["g"]) => ({ id, started_at, duration_ms, group_ids });
    const list = [r("a", 0, 100), r("b", 1000, 100), r("c", 500, 10, ["other"])];
    expect(nearestReplay(list, "g", 50)?.id).toBe("a");
    expect(nearestReplay(list, "g", 800)?.id).toBe("b");
    expect(nearestReplay(list, "x", 50)).toBeNull();
  });
});

describe("estimated bars fill what the counter has no record of", () => {
  const D = 86_400_000;
  const T0 = Date.UTC(2026, 9, 8);
  const bins = [
    { from: T0, to: T0 + D, parts: {}, total: 0, unknown: true },
    { from: T0 + D, to: T0 + 2 * D, parts: {}, total: 0, unknown: true },
    { from: T0 + 2 * D, to: T0 + 3 * D, parts: { events: 5 }, total: 5 },
    { from: T0 + 3 * D, to: T0 + 4 * D, parts: {}, total: 0 },
  ];
  test("an unknown day with kept rows is drawn from the largest trail and marked; a day with none stays unknown", () => {
    const transitions = [{ at: T0 + 3600_000, n: 1 }, { at: T0 + 7200_000, n: 1 }, { at: T0 + 3 * D + 1, n: 1 }];
    const buckets = [{ at: T0 + 100, n: 1 }];
    const out = fillEstimates(bins, [transitions, buckets]);
    expect(out[0]).toMatchObject({ total: 2, estimated: true, parts: { estimated: 2 } });
    expect(out[0].unknown).toBeUndefined();
    expect(out[1]).toMatchObject({ unknown: true, total: 0 });
    // A counted day keeps its count; a counted zero with something kept that day reads as an estimate, never as nothing.
    expect(out[2]).toBe(bins[2]);
    expect(out[3]).toMatchObject({ total: 1, estimated: true });
    expect(unknownUntil(out)).toBeNull();
  });
});

describe("axis ticks fit the axis they label", () => {
  const DAY = 86_400_000;
  test("a narrow axis gets fewer ticks, never fewer than two; an unmeasured one keeps the default", () => {
    expect(tickBudget(0)).toBe(8);
    expect(tickBudget(260)).toBe(4);
    expect(tickBudget(60)).toBe(2);
    expect(tickBudget(2000)).toBe(8);
  });
  test("7 days on a phone-width axis steps two days instead of one", () => {
    const r = { from: Date.UTC(2026, 9, 28), to: Date.UTC(2026, 10, 4) };
    expect(rangeTicks(r).length).toBeGreaterThanOrEqual(7);
    const narrow = rangeTicks(r, tickBudget(260));
    expect(narrow.length).toBeLessThanOrEqual(4);
    expect(narrow[1].at - narrow[0].at).toBe(2 * DAY);
  });
});

describe("every kept occurrence lands in a Kind and a Level", () => {
  const sources = new Map([["s", { name: "github-ci" }]]);
  test("a CI failure reads error, and an issue this device does not hold counts as other", () => {
    const groups = new Map([["g", { kind: "check" as const, level: undefined as string | undefined }]]);
    expect(sampleFacets({ source_id: "s", group_id: "g", level: undefined }, sources, groups as any)).toMatchObject({ kind: "check", level: "error" });
    const v = sampleFacets({ source_id: "s", group_id: "gone", level: undefined }, sources, groups as any);
    expect(v.kind).toBe("other");
    const counts = sampleFacetCounts([{ g: "g" }, { g: "gone" }] as any[], (r: any) => sampleFacets({ source_id: "s", group_id: r.g }, sources, groups as any), parseTimelineQuery(""));
    expect(counts.kind.reduce((n, r) => n + r.n, 0)).toBe(2);
  });
});

describe("streamAxis: one span for the chart's bars and the lanes under them", () => {
  const H = 3600_000;
  const D = 24 * H;
  const to = Date.UTC(2026, 10, 4, 14, 37);
  test("30 days count per day, on whole UTC days", () => {
    const a = streamAxis({ from: to - 30 * D, to }, "volume");
    expect([a.volume, a.daily, a.width]).toEqual([true, true, D]);
    expect(a.from % D).toBe(0);
    expect(a.to % D).toBe(0);
    expect(a.from <= to - 30 * D && a.to >= to).toBe(true);
    // The same days counterBins draws.
    const bins = counterBins([], { from: to - 30 * D, to });
    expect([bins[0].from, bins.at(-1)!.to]).toEqual([a.from, a.to]);
  });
  test("24 hours count per hour; under 6 hours the bars count transitions", () => {
    const day = streamAxis({ from: to - D, to }, "volume");
    expect([day.daily, day.width, day.from % H, day.to % H]).toEqual([false, H, 0, 0]);
    const short = streamAxis({ from: to - H, to }, "volume");
    expect(short.volume).toBe(false);
    expect(short.from).toBe(histogram([], () => 0, () => "", () => 1, { from: to - H, to })[0].from);
  });
});

describe("folding repeats", () => {
  const s = (id: string, group_id: string, at: number) => ({ _id: id, group_id, at });
  const words = (items: ReturnType<typeof foldRepeats>) => items.map((it) => (it.kind === "run" ? `${it.key}×${it.samples.length} ${it.from}-${it.to}` : it.sample._id));
  test("an issue seen three or more times in a burst folds into one line with its count and span; fewer stay rows", () => {
    const rows = [s("a", "g1", 10), s("b", "g1", 9), s("c", "g1", 7), s("d", "g2", 6), s("e", "g2", 5), s("f", "g1", 4)];
    expect(words(foldRepeats(rows))).toEqual(["run:a×4 4-10", "d", "e"]);
  });
  test("two issues interleaving through a burst fold into two lines, newest first", () => {
    const M = 60_000;
    const rows = Array.from({ length: 20 }, (_, i) => s(`x${i}`, i % 2 ? "g2" : "g1", 40 * M - i * M));
    expect(words(foldRepeats(rows))).toEqual([`run:x0×10 ${22 * M}-${40 * M}`, `run:x1×10 ${21 * M}-${39 * M}`]);
  });
  test("a gap past FOLD_GAP or a span past FOLD_SPAN starts a new burst", () => {
    const M = 60_000;
    const gap = [s("a", "g1", 100 * M), s("b", "g1", 99 * M), s("c", "g1", 98 * M), s("d", "g1", 60 * M), s("e", "g1", 59 * M), s("f", "g1", 58 * M)];
    expect(words(foldRepeats(gap))).toEqual([`run:a×3 ${98 * M}-${100 * M}`, `run:d×3 ${58 * M}-${60 * M}`]);
    const long = Array.from({ length: 20 }, (_, i) => s(`y${i}`, "g1", 200 * M - i * 5 * M));
    expect(foldRepeats(long).filter((it) => it.kind === "run").length).toBe(2);
  });
  test("the keys walk a folded run as its newest row, an opened one row by row", () => {
    const items = foldRepeats([s("a", "g1", 3), s("b", "g1", 2), s("c", "g1", 1), s("d", "g2", 0)]);
    expect(foldedIds(items, new Set())).toEqual(["a", "d"]);
    expect(foldedIds(items, new Set(["run:a"]))).toEqual(["a", "b", "c", "d"]);
  });
});
