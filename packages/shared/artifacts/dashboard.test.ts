import { describe, expect, test } from "bun:test";
import { artifactView, type ArtifactElement } from "./index";
import {
  checkBlock,
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
  test("top names the label of the largest row", () => {
    const ev = evaluateKpi({ query: q, field: "tokens", agg: "top", label: "person" }, spend);
    expect(ev.state === "ok" && ev.display).toBe("ada");
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
    expect(dashboardSpec.verbs!.story.run(view, ["scrolly", "--headline", "Up 17%"]).ops).toEqual([{ k: "layout", put: { kind: "layout", format: "scrolly", headline: "Up 17%" } }]);
    expect(dashboardSpec.verbs!.say.run(view, ["b_b", "Doubled", "Mostly", "Ada"]).ops).toEqual([{ k: "b_b", set: { say_title: "Doubled", say: "Mostly Ada" } }]);
  });
  test("describe names each block's binding", () => {
    expect(dashboardSpec.describe(view)).toBe(
      ['dashboard "Spend" as dashboard: 2 blocks in reading order', 'b_a kpi span=3 "Spend"  = sum(spend) of usage{"days":4,"group_by":"person"}', "b_b chart span=6  line of unbound x=? y=?"].join("\n"),
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
    expect(suggestFields("kpi", cols, row)).toEqual({ field: "tokens", agg: "sum", compare: "halves" });
    expect(suggestFields("chart", cols, row)).toEqual({ chart: "stacked", x: "day", y: "tokens", series: "person" });
    expect(suggestFields("chart", ["status", "tasks"], ["open", 4])).toEqual({ chart: "hbar", x: "status", y: "tasks" });
    expect(suggestFields("table", ["status", "tasks"], ["open", 4])).toEqual({ sort: "-tasks", limit: 20 });
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
    expect(ev.state === "ok" && ev.delta).toMatchObject({ value: 4, caption: "last 2d vs prior 2d: +4" });
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
    expect(ev.state === "ok" && ev.delta?.caption).toBe("last 2d vs prior 2d: −4.0B");
  });
});
