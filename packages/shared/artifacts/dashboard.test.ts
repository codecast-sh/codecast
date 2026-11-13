import { describe, expect, test } from "bun:test";
import { artifactView, type ArtifactElement } from "./index";
import {
  chartPointRows,
  DASHBOARD_TEMPLATES,
  alertLine,
  blockQuery,
  alertState,
  checkBlock,
  readSchedule,
  directionWords,
  filterDimensions,
  filterRows,
  scopeFromParams,
  scopeMissing,
  kpiPartText,
  kpiResolver,
  storyProblems,
  textProblems,
  whereClauses,
  whereFrom,
  whereProblem,
  compareRerun,
  dashboardQueries,
  dashboardSpec,
  evaluateChart,
  evaluateKpi,
  evaluateTable,
  formatValue,
  moveBlockOps,
  orderAfter,
  orderedBlocks,
  packSpans,
  parseFlags,
  parseText,
  queryKey,
  storySteps,
  typedNumbers,
  type DataResult,
} from "./dashboard";

const NOW = Date.UTC(2026, 10, 10, 12);

function result(columns: string[], rows: unknown[][], extra: Partial<DataResult> = {}): DataResult {
  return { qkey: "q", columns, rows, refreshed_at: NOW - 10_000, refresh_ms: 300_000, query_text: "", source: "usage", args: {}, workspace: "team:t", ...extra };
}

const spend = result(
  ["day", "person", "tokens", "spend"],
  [
    ["2026-11-07", "ada", 100, 1.5],
    ["2026-11-07", "bo", 50, 0.5],
    ["2026-11-08", "ada", 200, 3],
    ["2026-11-08", "bo", 20, 0.25],
    ["2026-11-09", "ada", 300, 4],
    ["2026-11-10", "bo", 10, 0.1],
  ],
);
const q = { source: "usage", args: { days: 4, group_by: "person" } };

function el(key: string, kind: string, fields: Record<string, unknown> = {}): ArtifactElement {
  return { key, kind, rev: 1, ...fields } as ArtifactElement;
}

describe("queries", () => {
  test("the same source and args share one key whatever the arg order", () => {
    expect(queryKey({ source: "usage", args: { days: 30, group_by: "person" } })).toBe(queryKey({ source: "usage", args: { group_by: "person", days: 30 } }));
    expect(queryKey({ source: "usage", args: { days: 30 } })).not.toBe(queryKey({ source: "usage", args: { days: 31 } }));
  });
  test("a dashboard's distinct queries skip unbound and unknown sources", () => {
    const qs = dashboardQueries([{ query: q }, { query: { ...q } }, { query: { source: "nope" } }, {}]);
    expect(qs.size).toBe(1);
  });
});

describe("formats", () => {
  test("numbers, money, percent, compact", () => {
    expect(formatValue(58500)).toBe("58,500");
    expect(formatValue(1234.5, "usd")).toBe("$1,235");
    expect(formatValue(12.345, "usd")).toBe("$12.35");
    expect(formatValue(48210, "usd")).toBe("$48.2K");
    expect(formatValue(0.17, "percent")).toBe("17%");
    expect(formatValue(0.045, "percent")).toBe("4.5%");
    expect(formatValue(2_400_000, "compact")).toBe("2.4M");
    expect(formatValue(null)).toBe("–");
  });
});

describe("KPI", () => {
  test("sums a column across rows and names the rows it used", () => {
    const ev = evaluateKpi({ query: q, field: "spend", agg: "sum", format: "usd" }, spend);
    expect(ev.state).toBe("ok");
    if (ev.state !== "ok") return;
    expect(ev.value).toBe(9.35);
    expect(ev.display).toBe("$9.35");
    expect(ev.used).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ev.how).toBe("sum of spend over 6 rows");
  });
  test("a where filter narrows the rows", () => {
    const ev = evaluateKpi({ query: q, field: "tokens", where: { person: "ada" } }, spend);
    expect(ev.state === "ok" && ev.value).toBe(600);
  });
  test("top names the label with the largest total, not the largest single row", () => {
    const ev = evaluateKpi({ query: q, field: "tokens", agg: "top", label: "person" }, spend);
    expect(ev.state === "ok" && [ev.display, ev.used]).toEqual(["ada", [0, 2, 4]]);
    // bo has the biggest day (90) but ada the bigger total (70 + 60).
    const days = result(["day", "person", "n"], [["a", "ada", 70], ["a", "bo", 90], ["b", "ada", 60], ["b", "bo", 5]]);
    expect(evaluateKpi({ query: q, field: "n", agg: "top", label: "person" }, days)).toMatchObject({ state: "ok", display: "ada" });
  });
  test("compare halves: the later half against the earlier", () => {
    const daily = result(["day", "n"], [["a", 10], ["b", 10], ["c", 15], ["d", 15]]);
    const ev = evaluateKpi({ query: q, field: "n", agg: "sum", compare: "halves", good: "up" }, daily);
    expect(ev.state === "ok" && ev.delta).toMatchObject({ display: "+50%", dir: "up", good: true });
  });
  test("compare against another column, with spend up being bad news", () => {
    const yoy = result(["week", "this_year", "last_year"], [["w1", 50], ["w2", 58.5]].map(([w, v]) => [w, v, 50]));
    const ev = evaluateKpi({ query: q, field: "this_year", agg: "last", compare: "last_year", good: "down" }, yoy);
    expect(ev.state === "ok" && ev.delta).toMatchObject({ display: "+17%", caption: "+8.5 vs last year", good: false });
  });
  test("a missing column is a problem naming the columns that exist", () => {
    const ev = evaluateKpi({ query: q, field: "cost" }, spend);
    expect(ev).toEqual({ state: "problem", problem: 'the source has no column "cost" (it has day, person, tokens, spend)' });
  });
  test("a typed value is unbound, and no result yet is loading", () => {
    expect(evaluateKpi({ value: 42 }, undefined)).toEqual({ state: "unbound", display: "42" });
    expect(evaluateKpi({ query: q, field: "spend" }, undefined)).toEqual({ state: "loading" });
  });
});

describe("charts", () => {
  test("series per value of a column, zero-filled", () => {
    const ev = evaluateChart({ query: q, x: "day", y: "spend", series: "person", chart: "stacked" }, spend);
    expect(ev.state).toBe("ok");
    if (ev.state !== "ok") return;
    expect(ev.x).toEqual(["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"]);
    expect(ev.series).toEqual([
      { name: "ada", values: [1.5, 3, 4, 0] },
      { name: "bo", values: [0.5, 0.25, 0, 0.1] },
    ]);
  });
  test("cumulative running totals and several y columns", () => {
    const ev = evaluateChart({ query: q, x: "day", y: "tokens", cumulative: true }, spend);
    expect(ev.state === "ok" && ev.series[0].values).toEqual([150, 370, 670, 680]);
  });
  test("hbar ranks categories largest first", () => {
    const flavors = result(["flavor", "n"], [["apple", 2900], ["huckleberry", 4100], ["cherry", 890]]);
    const ev = evaluateChart({ query: q, x: "flavor", y: "n", chart: "hbar", limit: 2 }, flavors);
    expect(ev.state === "ok" && ev.x).toEqual(["huckleberry", "apple"]);
  });
});

describe("tables", () => {
  test("picks, sorts and limits", () => {
    const ev = evaluateTable({ query: q, columns: "person,tokens", sort: "-tokens", limit: 2 }, spend);
    expect(ev.state === "ok" && ev.rows).toEqual([["ada", 300], ["ada", 200]]);
    expect(ev.state === "ok" && ev.how).toBe("2 columns, 2 of 6 rows, sorted by tokens descending");
  });
});

describe("text", () => {
  test("references split out of the text", () => {
    expect(parseText("Spend is {b_spend}, {b_spend.delta} on last week.")).toEqual([
      { text: "Spend is " },
      { ref: "b_spend", part: "value" },
      { text: ", " },
      { ref: "b_spend", part: "delta" },
      { text: " on last week." },
    ]);
  });
  test("typed numbers are found outside references, small counts ignored", () => {
    expect(typedNumbers("We sold 58,500 pies, up 17% in 2 weeks; {b_x} live")).toEqual(["58,500", "17%"]);
    expect(typedNumbers("Spend is {b_spend}.")).toEqual([]);
    // The forms the tiles print are typed numbers too; windows, ranks and list places are not.
    expect(typedNumbers("Spend hit 4.5K, 1.2k tokens, 9 PRs, 2.5 million rows, 3x more")).toEqual(["4.5K", "1.2k", "9", "2.5 million", "3x"]);
    expect(typedNumbers("The top 10 over the last 30 days, step 2 of 3, Q4 2026")).toEqual([]);
  });
});

describe("checks", () => {
  const kpi = { query: q, field: "spend", agg: "sum", format: "usd" };
  test("verified when fresh, broken when the source cannot produce it", () => {
    expect(checkBlock("kpi", kpi, spend, NOW)?.state).toBe("verified");
    expect(checkBlock("kpi", { ...kpi, field: "gone" }, spend, NOW)?.state).toBe("broken");
    expect(checkBlock("kpi", kpi, result([], [], { refreshed_at: 0, error: "no metric watch mw-3 in this workspace" }), NOW)).toMatchObject({ state: "broken", detail: "no metric watch mw-3 in this workspace" });
  });
  test("a failed refresh over good rows is stale, an old read is stale, truncation is partial", () => {
    expect(checkBlock("kpi", kpi, { ...spend, error: "timeout" }, NOW)?.state).toBe("stale");
    expect(checkBlock("kpi", kpi, { ...spend, refreshed_at: NOW - 3_600_000 }, NOW)?.state).toBe("stale");
    expect(checkBlock("kpi", kpi, { ...spend, truncated: true }, NOW)?.state).toBe("partial");
  });
  test("typed values and typed numbers in text say so; plain text and sections carry no check", () => {
    expect(checkBlock("kpi", { value: 5 }, undefined, NOW)?.state).toBe("typed");
    expect(checkBlock("text", { text: "We sold 58,500" }, undefined, NOW)?.state).toBe("typed");
    expect(checkBlock("text", { text: "Spend is {b_x}" }, undefined, NOW)).toBeNull();
    expect(checkBlock("section", { title: "x" }, undefined, NOW)).toBeNull();
  });
  test("a re-run reproduces the number or says what changed", () => {
    expect(compareRerun("kpi", kpi, spend, spend).same).toBe(true);
    const moved = { ...spend, rows: [...spend.rows, ["2026-11-10", "ada", 1, 1]] };
    expect(compareRerun("kpi", kpi, spend, moved)).toMatchObject({ same: false, before: "$9.35", after: "$10.35" });
    expect(compareRerun("kpi", kpi, spend, { ...spend, columns: ["day"], rows: [] })).toMatchObject({ same: false, problem: expect.stringContaining('no column "spend"') });
  });
});

describe("layout", () => {
  const blocks = [el("b_a", "kpi", { order: 1 }), el("b_b", "kpi", { order: 2 }), el("b_c", "chart", { order: 3 }), el("layout", "layout", { format: "scrolly" })];
  test("reading order skips the layout element", () => {
    expect(orderedBlocks(blocks).map((b) => b.key)).toEqual(["b_a", "b_b", "b_c"]);
  });
  test("orderAfter lands between neighbors, first, or last", () => {
    const ordered = orderedBlocks(blocks);
    expect(orderAfter(ordered, "b_a")).toBe(1.5);
    expect(orderAfter(ordered, null)).toBe(0);
    expect(orderAfter(ordered, undefined)).toBe(4);
  });
  test("moving a block writes one order", () => {
    expect(moveBlockOps(blocks, "b_c", 0)).toEqual([{ k: "b_c", set: { order: 0 } }]);
    expect(moveBlockOps(blocks, "b_a", 2)).toEqual([{ k: "b_a", set: { order: 4 } }]);
    expect(moveBlockOps(blocks, "b_a", 0)).toEqual([]);
  });
});

describe("stories", () => {
  test("hero, adjacent KPIs gathered into one step, sections as chapters, hidden blocks left out", () => {
    const els = [
      el("b_1", "kpi", { order: 1 }),
      el("b_2", "kpi", { order: 2 }),
      el("b_3", "section", { order: 3, title: "Trend" }),
      el("b_4", "chart", { order: 4, title: "Spend", say_title: "Spend doubled", say: "Mostly Ada" }),
      el("b_5", "table", { order: 5, in_story: false }),
    ];
    const steps = storySteps("Agent spend", { format: "scrolly", summary: "One line" }, els);
    expect(steps.map((s) => s.kind)).toEqual(["hero", "numbers", "chapter", "block"]);
    expect(steps[0]).toMatchObject({ headline: "Agent spend", summary: "One line" });
    expect(steps[1].keys).toEqual(["b_1", "b_2"]);
    expect(steps[3]).toMatchObject({ title: "Spend doubled", say: "Mostly Ada" });
  });
});

describe("verbs", () => {
  const view = artifactView("dashboard", "Spend", [el("b_a", "kpi", { order: 1, title: "Spend", query: q, field: "spend" }), el("b_b", "chart", { order: 2 })]);
  test("flags parse values, = forms and booleans", () => {
    expect(parseFlags(["x", "--title", "A b", "--span=6", "--cumulative", "--y", "spend"], ["cumulative"])).toEqual({ pos: ["x"], flags: { title: "A b", span: "6", cumulative: true, y: "spend" } });
  });
  test("kpi creates a bound block at the end", () => {
    const r = dashboardSpec.verbs!.kpi.run(view, ["--source", "usage", "--args", '{"days":30}', "--field", "spend", "--agg", "sum", "--format", "usd", "--title", "Spend"]);
    const op = r.ops[0] as any;
    expect(op.put).toMatchObject({ kind: "kpi", order: 3, field: "spend", agg: "sum", format: "usd", title: "Spend", query: { source: "usage", args: { days: 30 } } });
    expect(r.position).toEqual({ block: op.k });
  });
  test("kpi --key updates only the given fields; --args keeps the source", () => {
    const r = dashboardSpec.verbs!.kpi.run(view, ["--key", "b_a", "--args", '{"days":7}', "--compare", "halves"]);
    expect(r.ops).toEqual([{ k: "b_a", set: { compare: "halves", query: { source: "usage", args: { days: 7 } } } }]);
  });
  test("bad input throws a usable message", () => {
    expect(() => dashboardSpec.verbs!.kpi.run(view, ["--source", "nope"])).toThrow(/unknown source "nope"/);
    expect(() => dashboardSpec.verbs!.chart.run(view, ["--key", "b_a", "--x", "day"])).toThrow(/is a kpi, not a chart/);
    expect(() => dashboardSpec.verbs!.kpi.run(view, ["--span", "5"])).toThrow(/--span/);
  });
  test("chart, move, story and say", () => {
    const c = dashboardSpec.verbs!.chart.run(view, ["--after", "b_a", "--type", "area", "--source", "usage", "--x", "day", "--y", "spend", "--cumulative"]);
    expect((c.ops[0] as any).put).toMatchObject({ kind: "chart", chart: "area", order: 1.5, cumulative: true });
    expect(dashboardSpec.verbs!.move.run(view, ["b_b", "--first"]).ops).toEqual([{ k: "b_b", set: { order: 0 } }]);
    expect(dashboardSpec.verbs!.story.run(view, ["scrolly", "--headline", "Spend is {b_a.trend}"]).ops).toEqual([{ k: "layout", put: { kind: "layout", format: "scrolly", headline: "Spend is {b_a.trend}" } }]);
    expect(dashboardSpec.verbs!.say.run(view, ["b_b", "Where it went", "Mostly", "Ada"]).ops).toEqual([{ k: "b_b", set: { say_title: "Where it went", say: "Mostly Ada" } }]);
  });
  test("describe names each block's binding", () => {
    expect(dashboardSpec.describe(view)).toBe(
      ['dashboard "Spend" as dashboard reads while open: 2 blocks in reading order', 'b_a kpi span=3 "Spend"  = sum(spend) of usage{"days":4,"group_by":"person"}', "b_b chart span=6  line of unbound x=? y=?"].join("\n"),
    );
  });
});

describe("visual short", () => {
  test("beats run end to end, charts hold longest, the beat at a time", async () => {
    const { shortTimeline, beatAt } = await import("./dashboard");
    const steps = storySteps("T", { format: "short" }, [el("b_1", "kpi", { order: 1 }), el("b_2", "kpi", { order: 2 }), el("b_3", "chart", { order: 3, title: "Trend" })]);
    const { beats, duration } = shortTimeline(steps);
    expect(beats.map((b) => [b.step.kind, b.start, b.duration])).toEqual([["hero", 0, 3200], ["numbers", 3200, 3600], ["block", 6800, 5200]]);
    expect(duration).toBe(12000);
    expect(beatAt(beats, 0)).toBe(0);
    expect(beatAt(beats, 3200)).toBe(1);
    expect(beatAt(beats, 11999)).toBe(2);
    expect(beats[2].title).toBe("Trend");
  });
});

describe("suggested fields", () => {
  test("time series: sum with a comparison, stacked by the text column", async () => {
    const { suggestFields } = await import("./dashboard");
    const cols = ["day", "person", "tokens", "spend"];
    const row = ["2026-11-01", "ada", 10, 1.2];
    expect(suggestFields("kpi", cols, row)).toEqual({ field: "spend", agg: "sum", format: "usd", compare: "halves" });
    expect(suggestFields("chart", cols, row)).toEqual({ chart: "stacked", x: "day", y: "spend", series: "person", format: "usd" });
    expect(suggestFields("chart", ["status", "tasks"], ["open", 4])).toEqual({ chart: "hbar", x: "status", y: "tasks" });
    expect(suggestFields("table", ["status", "tasks"], ["open", 4])).toEqual({ sort: "-tasks", limit: 20 });
    // One row per status: the KPI is the total, never one row's count.
    expect(suggestFields("kpi", ["status", "tasks"], ["open", 4])).toEqual({ field: "tasks", agg: "sum" });
    // A gauge read over time shows its latest reading.
    expect(suggestFields("kpi", ["at", "value"], [1, 0.5])).toEqual({ field: "value", agg: "last" });
  });
});

describe("review regressions", () => {
  test("a re-run that reorders chart values is not 'reproduced'", () => {
    const a = result(["x", "n"], [["a", 10], ["b", 20]]);
    const b = result(["x", "n"], [["a", 20], ["b", 10]]);
    const out = compareRerun("chart", { query: q, x: "x", y: "n" }, a, b);
    expect(out.same).toBe(false);
    expect(out.after).toContain("values differ");
  });
  test("a formula error or text in a folded column breaks the number instead of being skipped", () => {
    const r = result(["x", "n"], [["a", 10], ["b", "#DIV/0!"]]);
    const ev = evaluateKpi({ query: q, field: "n", agg: "sum" }, r);
    expect(ev).toEqual({ state: "problem", problem: '1 row holds no number in n ("#DIV/0!" in row 2)' });
    expect(checkBlock("kpi", { query: q, field: "n" }, r, NOW)?.state).toBe("broken");
    expect(evaluateChart({ query: q, x: "x", y: "n" }, r).state).toBe("problem");
    // Blanks are not errors.
    expect(evaluateKpi({ query: q, field: "n" }, result(["x", "n"], [["a", 10], ["b", null], ["c", ""]]))).toMatchObject({ state: "ok", value: 10 });
  });
  test("a comparison column that is gone breaks the KPI", () => {
    expect(evaluateKpi({ query: q, field: "spend", compare: "missing" }, spend)).toMatchObject({ state: "problem" });
  });
  test("percent text reads as a fraction", () => {
    expect(evaluateKpi({ query: q, field: "p", agg: "last", format: "percent" }, result(["p"], [["17%"]]))).toMatchObject({ display: "17%" });
  });
  test("halves split grouped rows by date, not by row count", () => {
    // 4 days × 2 people: the early half is days 1-2, the late half days 3-4.
    const rows = ["d1", "d2", "d3", "d4"].flatMap((d, i) => [[d, "ada", i + 1], [d, "bo", 10]]);
    const ev = evaluateKpi({ query: q, field: "n", agg: "sum", compare: "halves" }, result(["day", "person", "n"], rows));
    expect(ev.state === "ok" && ev.delta).toMatchObject({ value: 4, caption: "last 2d: +4 vs prior 2d", against: "the prior 2 days" });
  });
  test("ranked bars with a split or no numbers are a problem, not an empty chart", () => {
    expect(evaluateChart({ query: q, chart: "hbar", x: "day", y: "spend", series: "person" }, spend).state).toBe("problem");
    expect(evaluateChart({ query: q, x: "a", y: "b" }, result(["a", "b"], [["x", null]]))).toMatchObject({ state: "problem", problem: "no numbers in b" });
  });
  test("sheet headers stay unique even when a generated name is already taken", async () => {
    const { sheetTable } = await import("./dashboard");
    expect(sheetTable([["a", "a", "a_2"], [1, 2, 3]], true).columns).toEqual(["a", "a_2", "a_2_2"]);
  });
  test("a KPI with its own story line is its own step", () => {
    const steps = storySteps("T", { format: "scrolly" }, [el("b_1", "kpi", { order: 1 }), el("b_2", "kpi", { order: 2, say: "Its line" })]);
    expect(steps.map((s) => s.kind)).toEqual(["hero", "numbers", "numbers"]);
  });
});

describe("review round two", () => {
  test("a changed comparison ratio is not reproduced; a truncated re-run never is", () => {
    const a = result(["k", "n", "base"], [["x", 60, 20]]);
    const b = result(["k", "n", "base"], [["x", 60, 25.7]]);
    const block = { query: q, field: "n", agg: "last", compare: "base" };
    expect(compareRerun("kpi", block, a, b).same).toBe(false);
    expect(compareRerun("kpi", block, a, { ...a, truncated: true })).toMatchObject({ same: false, problem: expect.stringContaining("more rows") });
  });
  test("count with a missing comparison column is broken, not ±0%", () => {
    expect(evaluateKpi({ query: q, agg: "count", compare: "missing" }, spend).state).toBe("problem");
  });
  test("a split takes one value column", () => {
    expect(evaluateChart({ query: q, x: "day", y: "tokens,spend", series: "person" }, spend)).toMatchObject({ state: "problem" });
  });
  test("halves need four dates", () => {
    const two = result(["day", "n"], [["d1", 1], ["d2", 2], ["d3", 3]]);
    const ev = evaluateKpi({ query: q, field: "n", compare: "halves" }, two);
    expect(ev.state === "ok" && ev.delta).toBeUndefined();
  });
  test("shared queries keep the fastest refresh any block asks for", () => {
    const qs = dashboardQueries([{ query: { ...q, refresh: "1h" } }, { query: { ...q, refresh: "1m" } }]);
    expect([...qs.values()][0].refresh).toBe("1m");
  });
});

describe("compact deltas", () => {
  test("a compact number under 10 of its unit keeps its decimal, so -4.0B never reads as -48", () => {
    expect(formatValue(3_960_000_000, "compact")).toBe("4.0B");
    expect(formatValue(3_700_000_000, "compact")).toBe("3.7B");
    expect(formatValue(48_300_000_000, "compact")).toBe("48.3B");
    expect(formatValue(48_000_000_000, "compact")).toBe("48B");
    expect(formatValue(12_000, "compact")).toBe("12K");
    expect(formatValue(4_000, "usd")).toBe("$4,000");
    expect(formatValue(40_000, "usd")).toBe("$40K");
  });
  test("a tile's delta caption uses the tile's own compact format", () => {
    const tokens = result(["day", "tokens"], [["d1", 26_000_000_000], ["d2", 0], ["d3", 22_040_000_000], ["d4", 0]]);
    const ev = evaluateKpi({ query: q, field: "tokens", agg: "sum", format: "compact", compare: "halves" }, tokens);
    expect(ev.state === "ok" && ev.display).toBe("48B");
    expect(ev.state === "ok" && ev.delta?.caption).toBe("last 2d: −4.0B vs prior 2d");
  });
});

describe("filters", () => {
  const rows = (where: any, scope?: any) => {
    const r = filterRows(spend, where, scope);
    return "rows" in r ? r.rows : r.problem;
  };
  test("plain equality keeps working; conditions compare numbers as numbers and dates as text", () => {
    expect(rows({ person: "ada" })).toEqual([0, 2, 4]);
    expect(rows({ tokens: { gte: 100 } })).toEqual([0, 2, 4]);
    expect(rows({ tokens: { gt: "50", lt: 250 } })).toEqual([0, 2]);
    expect(rows({ day: { gte: "2026-11-08", lte: "2026-11-09" } })).toEqual([2, 3, 4]);
    expect(rows({ person: { in: ["bo"] }, day: { ne: "2026-11-07" } })).toEqual([3, 5]);
    expect(rows({ person: { contains: "A" } })).toEqual([0, 2, 4]);
  });
  test("a block's own filter on a missing column is a problem; the dashboard's filter skips sources without it", () => {
    expect(rows({ repo: "x" })).toMatch(/no column "repo"/);
    expect(rows(undefined, { repo: "x", person: "bo" })).toEqual([1, 3, 5]);
    expect(rows({ tokens: { between: 1 } })).toMatch(/not a filter operator/);
  });
  test("clauses round-trip to the short stored form", () => {
    const w = { person: "ada", day: { gte: "2026-11-01", lt: "2026-12-01" }, agent: ["a", "b"] };
    const c = whereClauses(w);
    expect(c).toEqual([
      { column: "person", op: "eq", value: "ada" },
      { column: "day", op: "gte", value: "2026-11-01" },
      { column: "day", op: "lt", value: "2026-12-01" },
      { column: "agent", op: "in", value: ["a", "b"] },
    ]);
    expect(whereFrom(c)).toEqual({ person: "ada", day: { gte: "2026-11-01", lt: "2026-12-01" }, agent: { in: ["a", "b"] } });
    expect(whereFrom([])).toBeUndefined();
    expect(whereProblem({ person: { in: "ada" } })).toMatch(/takes a list/);
  });
  test("a dashboard filter narrows a KPI and its check", () => {
    const ev = evaluateKpi({ query: q, field: "tokens" }, spend, { person: "bo" });
    expect(ev.state === "ok" && ev.value).toBe(80);
    expect(checkBlock("kpi", { query: q, field: "tokens" }, spend, NOW, { scope: { person: "bo" } })?.state).toBe("verified");
  });
  test("the rows behind one chart point, per series", () => {
    const chart = { query: q, x: "day", y: "tokens", series: "person" };
    expect(chartPointRows(chart, spend, "2026-11-08")).toEqual([2, 3]);
    expect(chartPointRows(chart, spend, "2026-11-08", "bo")).toEqual([3]);
    expect(chartPointRows(chart, spend, "2026-11-08", "bo", { person: "ada" })).toEqual([]);
  });
});

describe("words against the data", () => {
  const daily = result(["day", "n"], [["a", 10], ["b", 10], ["c", 5], ["d", 5]]);
  const els = new Map<string, any>([["b_n", { key: "b_n", kind: "kpi", title: "Throughput", query: q, field: "n", compare: "halves" }]]);
  const kpi = kpiResolver((k) => els.get(k), () => daily);
  test("direction words, but not phrasal 'set up' or 'follow up on'", () => {
    expect(directionWords("Throughput rose. It is up 12% and down from May.").map((d) => d.dir)).toEqual(["up", "up", "down"]);
    expect(directionWords("Set up the board and follow up with the team.")).toEqual([]);
  });
  test("a clause that says the opposite of its KPI contradicts it; a matching or token-only one passes", () => {
    expect(textProblems("Throughput {b_n} rose this week", kpi)).toEqual([{ kind: "contradicts", detail: 'says "rose" but Throughput is down 50%' }]);
    expect(textProblems("Throughput fell to {b_n}", kpi)).toEqual([]);
    expect(textProblems("Throughput is {b_n.trend}, but reviews grew", kpi)).toEqual([{ kind: "typed", detail: '"grew" states a direction no live number backs' }]);
    expect(checkBlock("text", { text: "Throughput {b_n} rose" }, undefined, NOW, { kpi })).toMatchObject({ state: "broken", label: "Contradicts the data" });
  });
  test("tokens read as value, signed change and direction", () => {
    const ev = kpi("b_n")!.ev;
    expect([kpiPartText(ev, "value"), kpiPartText(ev, "delta"), kpiPartText(ev, "trend")]).toEqual(["30", "−50%", "down 50%"]);
  });
  test("story words are checked with the blocks", () => {
    const p = storyProblems({ headline: "Throughput {b_n} doubled" }, [{ key: "b_n", say: "58,500 so far" }], kpi);
    expect(p.map((x) => [x.key, x.field, x.kind])).toEqual([["layout", "headline", "contradicts"], ["b_n", "say", "typed"]]);
  });
  test("the verbs refuse typed numbers and worded directions, and allow windows and ranks", () => {
    const view = artifactView("dashboard", "T", [el("b_n", "kpi", { order: 1 })]);
    expect(() => dashboardSpec.verbs!.text.run(view, ["Spend rose this week"])).toThrow(/\{b_key\.trend\}/);
    expect(() => dashboardSpec.verbs!.story.run(view, ["scrolly", "--headline", "Pre-orders hit 58,500"])).toThrow(/typed number/);
    expect(() => dashboardSpec.verbs!.say.run(view, ["b_n", "Throughput", "up from May"])).toThrow(/direction/);
    expect(dashboardSpec.verbs!.text.run(view, ["Top 10 repos over the last 30 days: {b_n}, {b_n.trend}. Set up in 2026."]).ops).toHaveLength(1);
    expect(() => dashboardSpec.verbs!.table.run(view, ["--where", '{"person":{"in":"ada"}}'])).toThrow(/takes a list/);
  });
});

describe("dashboard filters", () => {
  test("a date range from the shared day column, categories with more than one value, most common first", () => {
    const tasks = result(["assignee", "count"], [["ada", 3], ["bo", 1]]);
    const solo = result(["day", "agent", "n"], [["2026-11-07", "claude", 1]]);
    expect(filterDimensions([spend, tasks, solo, undefined])).toEqual([
      { column: "day", kind: "time", values: [], first: "2026-11-07", last: "2026-11-10", days: 4 },
      { column: "person", kind: "category", values: ["ada", "bo"] },
      { column: "assignee", kind: "category", values: ["ada", "bo"] },
    ]);
  });
  test("URL params become the scope: relative and absolute dates, lists of values", () => {
    expect(scopeFromParams([["f.day", "7d"], ["f.person", "ada"], ["f.person", "Benn, Jason"], ["tab", "x"]], "2026-11-10")).toEqual({ day: { gte: "2026-11-04", lte: "2026-11-10" }, person: { in: ["ada", "Benn, Jason"] } });
    expect(scopeFromParams([["f.day", "2026-11-08.."]], "2026-11-10")).toEqual({ day: { gte: "2026-11-08" } });
    expect(scopeFromParams([["f.day", "soon"]], "2026-11-10")).toBeUndefined();
  });
});

describe("trend tokens", () => {
  test("a key with digits is a reference, not a typed number, in every token form", () => {
    expect(parseText("{b_dsqycf36.trend} and {b_x9.delta}")).toEqual([{ ref: "b_dsqycf36", part: "trend" }, { text: " and " }, { ref: "b_x9", part: "delta" }]);
    const view = artifactView("dashboard", "T", [el("b_dsqycf36", "kpi", { order: 1 })]);
    expect(dashboardSpec.verbs!.story.run(view, ["scrolly", "--headline", "PR merges are {b_dsqycf36.trend}"]).ops).toHaveLength(1);
  });
});

describe("grid packing", () => {
  test("a row's leftover goes to its widest block; widths fold on narrower panes", () => {
    expect(packSpans([3, 6, 12], "wide")).toEqual([3, 9, 12]);
    expect(packSpans([3, 3, 3, 3, 8, 4], "wide")).toEqual([3, 3, 3, 3, 8, 4]);
    expect(packSpans([3, 3, 3, 8], "wide")).toEqual([3, 3, 6, 12]);
    expect(packSpans([3, 3, 3, 6], "medium")).toEqual([4, 4, 4, 12]);
    expect(packSpans([3, 3, 3, 3], "medium")).toEqual([4, 4, 4, 12]);
    expect(packSpans([3, 6], "narrow")).toEqual([12, 12]);
  });
  test("a number never stretches past half a row; a chart in its row takes the leftover instead", () => {
    const kpi = [true, true, true, false];
    expect(packSpans([3, 3, 3, 8], "wide", kpi)).toEqual([4, 4, 4, 12]);
    expect(packSpans([3, 3, 3, 6], "medium", kpi)).toEqual([4, 4, 4, 12]);
    expect(packSpans([3, 3, 3, 3], "medium", [true, true, true, true])).toEqual([4, 4, 4, 6]);
    expect(packSpans([3, 6], "wide", [true, false])).toEqual([3, 9]);
  });
});

describe("refresh states", () => {
  const kpi = { query: q, field: "spend" };
  test("a routine re-read behind a current answer stays verified; one past its interval says refreshing", () => {
    expect(checkBlock("kpi", kpi, { ...spend, refreshing: true }, NOW)?.state).toBe("verified");
    expect(checkBlock("kpi", kpi, { ...spend, refreshing: true, refreshed_at: NOW - 400_000 }, NOW)?.state).toBe("refreshing");
    // The server sends when its read's lease ends; the page's own clock decides whether a read is still running.
    expect(checkBlock("kpi", kpi, { ...spend, lease_until: NOW + 30_000, refreshed_at: NOW - 400_000 }, NOW)?.state).toBe("refreshing");
    expect(checkBlock("kpi", kpi, { ...spend, lease_until: NOW - 1, refreshed_at: NOW - 400_000 }, NOW)?.state).toBe("verified");
  });
});

describe("unfiltered columns", () => {
  test("a block names each dashboard filter column its source lacks", () => {
    const prs = result(["day", "opened", "merged"], [["2026-11-07", 1, 1]]);
    expect(scopeMissing(prs, { day: { gte: "2026-11-01" }, person: { in: ["ada"] } })).toEqual(["person"]);
    expect(scopeMissing(spend, { day: { gte: "2026-11-01" }, person: { in: ["ada"] } })).toEqual([]);
    expect(scopeMissing(undefined, { person: { in: ["ada"] } })).toEqual([]);
  });
});

describe("schedules and alerts", () => {
  const view = artifactView("dashboard", "T", [el("b_s", "kpi", { order: 1, title: "Spend", query: q, field: "spend", format: "usd" })]);
  test("kpi alert flags and the schedule verb write the elements", () => {
    expect(dashboardSpec.verbs!.kpi.run(view, ["--key", "b_s", "--alert-above", "5"]).ops).toEqual([{ k: "b_s", set: { alert: { above: 5 } } }]);
    expect(dashboardSpec.verbs!.kpi.run(view, ["--key", "b_s", "--no-alert"]).ops).toEqual([{ k: "b_s", set: { alert: null } }]);
    expect(dashboardSpec.verbs!.schedule.run(view, ["daily"]).ops).toEqual([{ k: "layout", put: { kind: "layout", refresh: "daily" } }]);
    expect(() => dashboardSpec.verbs!.schedule.run(view, ["weekly"])).toThrow(/hourly\|daily\|off/);
    expect(readSchedule({ refresh: "hourly" })).toBe("hourly");
    expect(readSchedule({ refresh: "weekly" })).toBeNull();
  });
  test("a KPI's value against its lines, and the line it reads as", () => {
    const b = el("b_s", "kpi", { title: "Spend", query: q, field: "spend", format: "usd", alert: { above: 5 } });
    const s = alertState(b, spend)!;
    expect(s.state).toBe("above");
    expect(alertLine(b, s, "Team")).toBe("Spend is $9.35, above $5 on Team");
    expect(alertState({ ...b, alert: { below: 5 } } as any, spend)!.state).toBe("ok");
    expect(alertState({ ...b, alert: {} } as any, spend)).toBeNull();
  });
});

describe("period comparison under a date filter", () => {
  const days = Array.from({ length: 14 }, (_, i) => [`2026-11-${String(i + 1).padStart(2, "0")}`, i + 1]);
  const daily = result(["day", "n"], days);
  const kpi = { query: q, field: "n", agg: "sum" as const, compare: "halves" };
  test("the filtered days against the same number of days just before them", () => {
    const ev = evaluateKpi(kpi, daily, { day: { gte: "2026-11-08", lte: "2026-11-14" } });
    // Nov 8-14 sum 77 vs Nov 1-7 sum 28.
    expect(ev.state === "ok" && [ev.value, ev.delta?.caption, ev.delta?.against]).toEqual([77, "+49 vs prior 7d", "the prior 7 days"]);
  });
  test("when the rows don't reach back a whole period, the change falls back to the window's halves and says so", () => {
    const ev = evaluateKpi(kpi, daily, { day: { gte: "2026-11-03", lte: "2026-11-14" } });
    expect(ev.state === "ok" && ev.delta?.caption).toMatch(/^last 6d: \+\d+ vs prior 6d$/);
  });
  test("the .vs token names what the change compares with", () => {
    const ev = evaluateKpi(kpi, daily, { day: { gte: "2026-11-08", lte: "2026-11-14" } });
    expect(kpiPartText(ev, "vs")).toBe("the prior 7 days");
  });
});

describe("tokens in written words", () => {
  const view = artifactView("dashboard", "T", [el("b_merged", "kpi", { order: 1, title: "PRs merged", alert: { above: 10 } }), el("layout", "layout", { format: "dashboard", refresh: "hourly" })]);
  test("a token must name a KPI on the dashboard, with a part the page draws", () => {
    expect(() => dashboardSpec.verbs!.say.run(view, ["b_merged", "Merged PRs hit {b_mergd}"])).toThrow(/names no KPI on this dashboard \(KPIs: b_merged\)/);
    expect(() => dashboardSpec.verbs!.text.run(view, ["Merged {b_merged.foo}"])).toThrow(/is not a live value/);
    expect(dashboardSpec.verbs!.text.run(view, ["Merged PRs are {b_merged.trend} on {b_merged.vs}"]).ops).toHaveLength(1);
  });
  test("read shows the schedule and each KPI's alert", () => {
    const d = dashboardSpec.describe(view);
    expect(d).toContain("refreshes hourly");
    expect(d).toContain("alert=above 10");
  });
});

describe("badly written blocks", () => {
  test("a field of the wrong shape is coerced, never thrown on", () => {
    const daily = result(["day", "opened", "merged"], [["d1", 1, 2], ["d2", 3, 4]]);
    const ev = evaluateChart({ query: q, x: "day", y: ["opened", "merged"] as any, chart: "bar" }, daily);
    expect(ev.state === "ok" && ev.series.map((s) => s.name)).toEqual(["opened", "merged"]);
    expect(evaluateTable({ query: q, columns: 5 as any, sort: {} as any, limit: "x" as any }, daily).state).toBe("problem");
    expect(evaluateKpi({ query: q, field: ["opened"] as any, where: "bad" as any }, daily)).toMatchObject({ state: "ok", value: 4 });
  });
});

describe("changes on a tiny base", () => {
  test("3 to 19 reads in counts and where it came from, not +533%", () => {
    const daily = result(["day", "n"], [["d1", 1], ["d2", 2], ["d3", 9], ["d4", 10]]);
    const ev = evaluateKpi({ query: q, field: "n", compare: "halves" }, daily);
    expect(ev.state === "ok" && [ev.delta?.display, kpiPartText(ev, "trend")]).toEqual(["+16", "up from 3"]);
  });
});

describe("period-comparing KPIs", () => {
  const days = Array.from({ length: 8 }, (_, i) => [`2026-11-0${i + 1}`, i + 1]);
  const kpi = el("b_n", "kpi", { query: { source: "usage", args: { days: 4 } }, field: "n", compare: "halves" });
  test("the query reads twice the window; the value is the window, and the change is against the window before it", () => {
    expect(blockQuery(kpi)?.args).toEqual({ days: 8 });
    const ev = evaluateKpi(kpi as any, result(["day", "n"], days));
    // Nov 5-8 = 26, Nov 1-4 = 10.
    expect(ev.state === "ok" && [ev.value, ev.delta?.caption, ev.delta?.against]).toEqual([26, "+16 vs prior 4d", "the prior 4 days"]);
  });
  test("a block that doesn't compare periods reads what it asked for", () => {
    expect(blockQuery({ ...kpi, compare: "prev" })?.args).toEqual({ days: 4 });
    expect(blockQuery({ kind: "chart", query: { source: "usage", args: { days: 4 } } })?.args).toEqual({ days: 4 });
  });
});

describe("unknown tokens are caught on read too", () => {
  test("a text naming no KPI, or a part the page can't draw, is broken; the story check lists them", () => {
    const kpi = (k: string) => (k === "b_spend" ? { title: "Spend", ev: { state: "ok", value: 1, display: "1", used: [], how: "" } as any } : undefined);
    expect(checkBlock("text", { text: "Spend is {b_spnd}" }, undefined, NOW, { kpi })).toMatchObject({ state: "broken", label: "Names no value" });
    expect(checkBlock("text", { text: "Spend {b_spend.dleta}" }, undefined, NOW, { kpi })?.detail).toMatch(/is not a live value/);
    expect(storyProblems({ headline: "{b_spend.trnd}", summary: "{b_nope} so far" }, [], kpi).map((p) => p.kind)).toEqual(["unknown", "unknown"]);
  });
});

describe("a period KPI's window", () => {
  const days = Array.from({ length: 9 }, (_, i) => [`2026-11-0${i + 1}`, i + 1]);
  const kpi = el("b_n", "kpi", { query: { source: "usage", args: { days: 4 } }, field: "n", compare: "halves" });
  const daily = result(["day", "n"], days, { refreshed_at: Date.UTC(2026, 10, 9, 15) });
  test("ends on the newest day, today included, so it counts the same days as the charts beside it", () => {
    const ev = evaluateKpi(kpi as any, daily);
    // Nov 6-9 = 30, against Nov 2-5 = 14.
    expect(ev.state === "ok" && [ev.value, ev.delta?.value]).toEqual([30, 16]);
  });
  test("a dashboard date filter longer than the window is clamped to it, never widening what the number counts", () => {
    const wide = evaluateKpi(kpi as any, daily, { day: { gte: "2026-01-01", lte: "2026-11-09" } });
    expect(wide.state === "ok" && wide.value).toBe(30);
    const narrow = evaluateKpi(kpi as any, daily, { day: { gte: "2026-11-08", lte: "2026-11-09" } });
    // Nov 8-9 = 17, against Nov 6-7 = 13.
    expect(narrow.state === "ok" && [narrow.value, narrow.delta?.value]).toEqual([17, 4]);
  });
});


describe("chart limits", () => {
  test("a split chart over its limit keeps the largest series and gathers the rest as Other", () => {
    const ev = evaluateChart({ query: q, x: "day", y: "spend", series: "person", limit: 1 }, spend);
    expect(ev.state === "ok" && ev.series.map((s) => [s.name, s.values.reduce<number>((a, v) => a + (v ?? 0), 0)])).toEqual([["ada", 8.5], ["Other", 0.85]]);
  });
});

describe("grouped tables", () => {
  test("one row per person, numbers summed; the check points at every source row", () => {
    const ev = evaluateTable({ query: q, group: "person", sort: "-spend" }, spend);
    // Every person has three days, so the count column carries nothing and is left out.
    expect(ev.state === "ok" && [ev.columns, ev.rows, ev.used.length]).toEqual([["person", "tokens", "spend"], [["ada", 600, 8.5], ["bo", 80, 0.85]], 6]);
    // Daily rows: a group's count is its days, never shown, even for one group or uneven ones.
    const uneven = { ...spend, rows: spend.rows.slice(0, -1) };
    expect(evaluateTable({ query: q, group: "person", sort: "-spend" }, uneven)).toMatchObject({ state: "ok", columns: ["person", "tokens", "spend"] });
    // Rows that are things (tasks), not days: the count is the number of things in each group.
    const tasks = result(["status", "owner", "points"], [["open", "ada", 3], ["open", "bo", 2], ["done", "ada", 5]]);
    expect(evaluateTable({ query: q, group: "status" }, tasks)).toMatchObject({ state: "ok", columns: ["status", "points", "rows"], rows: [["open", 5, 2], ["done", 5, 1]] });
    expect(evaluateTable({ query: q, group: "team" }, spend)).toMatchObject({ state: "problem" });
  });
});

describe("direction words in context", () => {
  test("higher and lower count only beside a measurement", () => {
    expect(directionWords("Higher priority work and a lower bound, then double-check.")).toEqual([]);
    expect(directionWords("Spend is higher than last week, and sessions are lower by 3.").map((d) => d.dir)).toEqual(["up", "down"]);
  });
});

describe("starter dashboards", () => {
  test("each template builds blocks whose words pass the same checks an agent's writes do", () => {
    for (const t of DASHBOARD_TEMPLATES) {
      const ops = t.ops();
      expect(ops.length).toBeGreaterThan(3);
      const view = artifactView("dashboard", t.label, ops.map((o: any) => el(o.k, o.put.kind, o.put)));
      for (const o of ops as any[]) {
        if (o.put.kind === "text") expect(() => dashboardSpec.verbs!.text.run(view, [o.put.text])).not.toThrow();
        if (o.put.query) expect(blockQuery(o.put)).not.toBeNull();
      }
      // Fresh keys each time: two dashboards from one template share nothing.
      expect(t.ops()[0].k).not.toBe(ops[0].k);
    }
  });
});

describe("grouped tables under a filter that leaves nothing", () => {
  test("keep their columns and read empty, not as an error", () => {
    const ev = evaluateTable({ query: q, group: "person", sort: "-spend" }, spend, { person: { in: ["nobody"] } });
    expect(ev.state === "ok" && [ev.columns, ev.rows]).toEqual([["person", "tokens", "spend"], []]);
  });
});

describe("verbs refuse a column the source never returns", () => {
  const empty = artifactView("dashboard", "t", []);
  const run = (verb: string, args: string[]) => () => dashboardSpec.verbs![verb].run(empty, args);
  test("a misspelled field names the columns the source has", () => {
    expect(run("kpi", ["--source", "usage", "--args", '{"days":30}', "--field", "spendz"])).toThrow(/usage has no column "spendz" \(it has day, person, tokens, spend\)/);
    expect(run("kpi", ["--source", "usage", "--args", '{"days":30}', "--field", "spend", "--agg", "sum"])).not.toThrow();
  });
  test("a grouped source's group column and a table's row count are known; open-ended sources are not judged", () => {
    expect(run("chart", ["--source", "sessions", "--args", '{"group_by":"agent"}', "--x", "day", "--y", "sessions", "--series", "agent"])).not.toThrow();
    expect(run("table", ["--source", "usage", "--group", "person", "--sort", "-rows"])).not.toThrow();
    expect(run("table", ["--source", "tasks", "--args", '{"view":"status"}', "--sort", "-anything"])).not.toThrow();
  });
});


describe("verbs refuse args the reader would refuse, and flags they don't take", () => {
  const empty = artifactView("dashboard", "t", []);
  const run = (verb: string, args: string[]) => () => dashboardSpec.verbs![verb].run(empty, args);
  test("a window out of range, an unknown arg and an off-list value", () => {
    expect(run("kpi", ["--source", "usage", "--args", '{"days":-3}', "--field", "spend"])).toThrow(/"days" must be a whole number from 1 to 90/);
    expect(run("kpi", ["--source", "usage", "--args", '{"group":"person"}', "--field", "spend"])).toThrow(/usage takes no "group"/);
    expect(run("kpi", ["--source", "tasks", "--args", '{"view":"owner"}'])).toThrow(/"view" must be one of/);
  });
  test("a misspelled flag is named with the one it was likely meant to be", () => {
    expect(run("kpi", ["--source", "usage", "--feild", "spend"])).toThrow(/kpi takes no --feild \(did you mean --field\?\)/);
  });
});

describe("a grouped table's filter on a summed column judges the groups", () => {
  test("people whose total spend is over 2, not the days over 2 summed", () => {
    // ada's days: 1.5, 3, 4 (total 8.5); bo's: 0.5, 0.25, 0.1 (total 0.85).
    const ev = evaluateTable({ query: q, group: "person", where: { spend: { gt: 2 } } }, spend);
    expect(ev.state === "ok" && ev.rows).toEqual([["ada", 600, 8.5]]);
    const both = evaluateTable({ query: q, group: "person", where: { spend: { gt: 0.5 } }, sort: "-spend" }, spend);
    expect(both.state === "ok" && both.rows.map((r) => r[0])).toEqual(["ada", "bo"]);
    // A condition on a label still picks the source rows.
    const one = evaluateTable({ query: q, group: "person", where: { day: { gte: "2026-11-08" } }, sort: "-spend" }, spend);
    expect(one.state === "ok" && one.rows).toEqual([["ada", 500, 7], ["bo", 30, 0.35]]);
  });
});

