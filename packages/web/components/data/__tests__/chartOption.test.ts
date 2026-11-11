import { describe, expect, test } from "bun:test";
import { dashboard } from "@codecast/shared/artifacts";
import { axisLabel, chartOption } from "../chartOption";
import type { ChartTheme } from "../../ops/chart/chartTheme";

const t = { dark: false, bg: "rgb(1,1,1)", card: "rgb(2,2,2)", text: "rgb(3,3,3)", text2: "rgb(4,4,4)", muted: "rgb(5,5,5)", dim: "rgb(6,6,6)", line: "rgba(0,0,0,.4)", grid: "rgba(0,0,0,.2)", hover: "rgba(0,0,0,.05)", blue: "rgb(0,0,255)", cyan: "rgb(0,255,255)", green: "rgb(0,255,0)", yellow: "rgb(255,255,0)", orange: "rgb(255,128,0)", red: "rgb(255,0,0)", magenta: "rgb(255,0,255)", violet: "rgb(128,0,255)", mono: "mono", ui: "ui" } as ChartTheme;

const res = (columns: string[], rows: unknown[][]) => ({ qkey: "q", columns, rows, refreshed_at: 1, refresh_ms: 1, query_text: "", source: "usage", args: {}, workspace: "" });
const ok = (b: dashboard.ChartBlock, r: ReturnType<typeof res>) => {
  const ev = dashboard.evaluateChart({ query: { source: "usage" }, ...b }, r);
  if (ev.state !== "ok") throw new Error(ev.state);
  return ev;
};

describe("chart options", () => {
  test("more than three lines get a legend instead of end labels; column names read as words", () => {
    const rows = ["a", "b", "c", "d"].map((p) => ["2026-11-01", p, 1]);
    const o: any = chartOption(ok({ chart: "line", x: "day", y: "n", series: "p" }, res(["day", "p", "n"], rows)), t, { compact: true });
    expect(o.legend).toBeTruthy();
    expect(o.series[0].endLabel).toBeUndefined();
    const two: any = chartOption(ok({ chart: "line", x: "w", y: "this_year,last_year" }, res(["w", "this_year", "last_year"], [["w1", 1, 2]])), t, { compact: true });
    expect(two.series.map((s: any) => s.name)).toEqual(["This year", "Last year"]);
    expect(two.legend).toEqual({ show: false });
  });
  test("axis labels read as dates and hours", () => {
    expect(axisLabel("2026-11-07")).toBe("Nov 7");
    expect(axisLabel("2026-11-07T14:00Z")).toBe("14:00");
    expect(axisLabel("Huckleberry")).toBe("Huckleberry");
  });
  test("a stacked chart stacks one bar series per group", () => {
    const o: any = chartOption(ok({ chart: "stacked", x: "day", y: "spend", series: "person" }, res(["day", "person", "spend"], [["2026-11-01", "a", 1], ["2026-11-01", "b", 2]])), t, { compact: true });
    expect(o.series.map((s: any) => [s.type, s.stack, s.name])).toEqual([["bar", "total", "a"], ["bar", "total", "b"]]);
    expect(o.legend).toBeTruthy();
  });
  test("an area chart fills under its line; a story chart labels the line's end", () => {
    const ev = ok({ chart: "area", x: "day", y: "n" }, res(["day", "n"], [["2026-11-01", 1], ["2026-11-02", 3]]));
    const tile: any = chartOption(ev, t, { compact: true });
    const story: any = chartOption(ev, t, { compact: false, revealMs: 1200 });
    expect(tile.series[0].areaStyle).toBeTruthy();
    expect(tile.series[0].endLabel.show).toBe(true);
    expect(tile.legend).toEqual({ show: false });
    expect(story.series[0].endLabel.show).toBe(true);
    expect(story.animationDuration).toBe(1200);
    expect(tile.animation).toBe(false);
  });
  test("ranked bars put the leader in the accent and the rest muted", () => {
    const o: any = chartOption(ok({ chart: "hbar", x: "f", y: "n" }, res(["f", "n"], [["apple", 2], ["huck", 4]])), t);
    expect(o.yAxis.data).toEqual(["huck", "apple"]);
    expect(o.series[0].data[0].itemStyle.color).toBe(t.blue);
    expect(o.series[0].data[1].itemStyle.color).not.toBe(t.blue);
  });
});

test("a redraw that drops the legend hides it, since ECharts merges into the last option", () => {
  const o: any = chartOption(ok({ chart: "stacked", x: "day", y: "spend", series: "person" }, res(["day", "person", "spend"], [["2026-11-01", "a", 1]])), t, { compact: true });
  expect(o.legend).toEqual({ show: false });
});

test("a series keeps the dashboard's color slot for its name; ranked bars carry no tooltip", () => {
  const o: any = chartOption(ok({ chart: "stacked", x: "day", y: "spend", series: "person" }, res(["day", "person", "spend"], [["2026-11-01", "ada", 1], ["2026-11-01", "bo", 2]])), t, { compact: true, slotOf: (n) => (n === "ada" ? 2 : n === "bo" ? 0 : undefined) });
  expect(o.series.map((s: any) => s.itemStyle.color)).toEqual([t.green, t.blue]);
  const h: any = chartOption(ok({ chart: "hbar", x: "person", y: "spend" }, res(["person", "spend"], [["ada", 1], ["bo", 2]])), t, { compact: true });
  expect(h.tooltip).toEqual({ show: false });
});

test("two series get a gap row in the tooltip", () => {
  const o: any = chartOption(ok({ chart: "line", x: "day", y: "a,b" }, res(["day", "a", "b"], [["2026-11-01", 5, 3]])), t, { compact: true });
  const html = o.tooltip.formatter([{ axisValue: "2026-11-01", value: 5, seriesName: "a", color: "red" }, { axisValue: "2026-11-01", value: 3, seriesName: "b", color: "blue" }]);
  expect(html).toContain("Gap");
});
