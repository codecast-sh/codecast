// The metric chart, mounted: ECharts draws the plot on a canvas (a no-op
// context here), so these read what the chart was handed and the HTML laid
// over it. The tip reads the value, its distance to the line, the cadence,
// a hole and a band; dragging across the plot zooms; the line's tab hands
// back a round number on release; markers, ships, the gap and the loading bar
// sit over the plot. The drawing rules themselves are metricPlotModel's tests.
// The state pill says what a watch is doing and nothing for a plain series.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { installFakeCanvas } from "../../../test-helpers/fakeCanvas";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/ops/metrics/mw-1" });
installFakeCanvas(dom.window as never);
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { MetricChart, HealthPill } = await import("../MetricChart");
const { echarts } = await import("../chart/echarts");
const { MemoryRouter } = await import("react-router");
type ChartProps = Parameters<typeof MetricChart>[0];

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const H = 3600_000;
const T0 = 1_800_000_000_000;
// An hour apart, past 20 at the third and fourth reads.
const POINTS = [10, 15, 25, 30, 12, 14].map((value, i) => ({ at: T0 + i * H, value }));
const WIN = { from: T0, to: T0 + 6 * H };

async function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter>{node}</MemoryRouter>); });
  const host = container.querySelector("[_echarts_instance_]") as HTMLElement | null;
  const chart = host ? echarts.getInstanceByDom(host)! : null;
  type Opt = { series: { id: string; data: unknown[] }[]; tooltip: { formatter: (ps: { axisValue: number }[]) => string }[]; graphic?: { elements?: { id?: string }[] }[] };
  const opt = () => chart!.getOption() as unknown as Opt;
  const tip = (at: number) => { const d = dom.window.document.createElement("div"); d.innerHTML = opt().tooltip[0].formatter([{ axisValue: at }]); return d.textContent ?? ""; };
  const series = (id: string) => opt().series.find((x) => x.id === id)!.data;
  return { container, chart, opt, tip, series, done: () => { act(() => root.unmount()); container.remove(); } };
}

const chart = (over: Partial<ChartProps> = {}) => <MetricChart points={POINTS} win={WIN} interval_ms={H} threshold={20} direction="above" height={200} full {...over} />;

test("the line turns red only past the line: the past series holds the crossing stretch, split exactly at 20", async () => {
  const m = await mount(chart());
  const past = (m.series("past") as [number, number | null][]).filter((p) => p[1] !== null);
  expect(past[0]).toEqual([T0 + 1.5 * H, 20]);
  // Back under 20 between 30 (3h) and 12 (4h): 10/18 of the way.
  expect(past.at(-1)![0]).toBeCloseTo(T0 + (3 + 10 / 18) * H, -1);
  expect(past.at(-1)![1]).toBe(20);
  m.done();
});

test("hovering reads the nearest value with its distance to the line", async () => {
  const m = await mount(chart());
  const t = m.tip(T0 + 3 * H);
  expect(t).toContain("30");
  expect(t).toContain("+10");
  m.done();
});

test("the tip names a daily cadence, a hole with its missed polls, and an alerting stretch", async () => {
  const D = 24 * H;
  const daily = [5, 4, 3, 2].map((d, i) => ({ at: T0 - d * D, value: 10 + i }));
  const a = await mount(chart({ points: daily, win: { from: T0 - 5 * D, to: T0 }, threshold: undefined }));
  expect(a.tip(T0 - 3 * D)).toContain("one value per 1d here");
  a.done();
  const holed = [10, 25, 26].map((value, i) => ({ at: T0 + i * H, value })).concat([27, 28, 12].map((value, i) => ({ at: T0 + (32 + i) * H, value })));
  const b = await mount(chart({ points: holed, win: { from: T0, to: T0 + 36 * H }, poll_ms: H }));
  const t = b.tip(T0 + 17 * H);
  expect(t).toContain("no values");
  expect(t).toContain("29 polls missed");
  expect(b.tip(T0 + 1 * H)).toContain("alerting");
  b.done();
});

test("brushing across the plot zooms to that span; a sliver is ignored", async () => {
  const zooms: { from: number; to: number }[] = [];
  const m = await mount(chart({ onZoom: (w) => zooms.push(w) }));
  await act(async () => { m.chart!.trigger("brushend", { areas: [{ coordRange: [T0 + 4 * H, T0 + H] }] }); });
  await act(async () => { m.chart!.trigger("brushend", { areas: [{ coordRange: [T0 + H, T0 + H + 60_000] }] }); });
  expect(zooms).toEqual([{ from: T0 + H, to: T0 + 4 * H }]);
  m.done();
});

test("the line's tab sits in the gutter when the line can be moved, and releasing it hands back a round value", async () => {
  const moved: number[] = [];
  const m = await mount(chart({ onThreshold: (v) => moved.push(v) }));
  const els = (m.opt().graphic?.[0]?.elements ?? []) as { id?: string }[];
  expect(els.some((e) => e.id === "line-handle")).toBe(true);
  const g = m.chart!.getZr().storage.getDisplayList(true).map((d) => d.parent).find((p) => p && (p as { draggable?: unknown }).draggable) as unknown as { y: number; ondragend: (this: { y: number }) => void };
  const y = m.chart!.convertToPixel({ yAxisIndex: 0 }, 23.37) as number;
  await act(async () => { g.ondragend.call({ y }); });
  expect(moved).toHaveLength(1);
  expect(moved[0]).toBeGreaterThan(20);
  expect(Number.isInteger(moved[0] * 10)).toBe(true);
  m.done();
  const plain = await mount(chart());
  expect((plain.opt().graphic?.[0]?.elements ?? []).length).toBe(0);
  plain.done();
});

test("markers sit at their moments and link where they lead", async () => {
  const marks = [
    { at: T0 + 2 * H, kind: "crossed" as const, label: "Crossed the line at 25", sub: "eg-1", href: "/ops/issues/eg-1" },
    { at: T0 + 3 * H, kind: "ship" as const, label: "Landed abcdef1", href: "https://github.com/x/commit/abc", external: true },
    { at: T0 - H, kind: "fix" as const, label: "Outside the window" },
  ];
  const m = await mount(chart({ marks, warn: 16, unit: "/day" }));
  const shown = [...m.container.querySelectorAll("[data-metric-mark]")] as HTMLElement[];
  expect(shown.map((e) => e.dataset.metricMark)).toEqual(["crossed", "ship"]);
  expect(shown[0].style.left).toBe(`${(2 / 6) * 100}%`);
  expect(shown[0].querySelector("a")?.getAttribute("href")).toBe("/ops/issues/eg-1");
  expect(shown[1].querySelector("a")?.getAttribute("target")).toBe("_blank");
  expect(shown[0].textContent).toContain("Crossed the line at 25");
  m.done();
});

test("ships close together cluster into one marker listing each", async () => {
  const ship = (at: number, label: string) => ({ at, kind: "deploy" as const, label, href: `https://github.com/x/commit/${label}`, external: true });
  const ships = [ship(T0 + H, "a"), ship(T0 + H + 30_000, "b"), ship(T0 + H + 60_000, "c"), ship(T0 + 4 * H, "d")];
  const m = await mount(chart({ ships }));
  const markers = [...m.container.querySelectorAll("[data-metric-ship]")] as HTMLElement[];
  expect(markers.map((e) => e.dataset.metricShip)).toEqual(["3", "1"]);
  expect(markers[0].querySelector(".mp-ship-head")?.textContent).toBe("3");
  expect(markers[0].querySelectorAll(".mp-ship-list li")).toHaveLength(3);
  m.done();
});

test("while the window's values load, a bar shows and nothing is drawn as the answer", async () => {
  const m = await mount(chart({ loading: true }));
  expect(m.container.querySelector("[data-metric-loading]")).not.toBeNull();
  expect((m.series("value") as unknown[]).length).toBe(0);
  expect(m.container.querySelector(".mp-empty")).toBeNull();
  m.done();
});

test("a card names where its window starts", async () => {
  const spark = await mount(<MetricChart points={POINTS} win={WIN} interval_ms={H} direction="above" axisStart />);
  expect(spark.container.querySelector("[data-axis-start]")?.textContent).toBeTruthy();
  spark.done();
});

test("before the first value held the window is a named gap carrying its action", async () => {
  const win = { from: T0 - 6 * H, to: T0 + 6 * H };
  const m = await mount(chart({ points: POINTS.slice(4), win, gap: { from: win.from, to: T0 + 4 * H }, episodes: [{ from: T0 - 4 * H, to: T0 - 2 * H }], gapAction: <button data-backfill>Read older values</button> }));
  expect(m.container.querySelector("[data-metric-gap-label]")?.textContent).toContain("no values held");
  expect(m.container.querySelector("[data-backfill]")).not.toBeNull();
  expect(m.container.querySelector(".mp-empty")).toBeNull();
  m.done();
});

test("a value read now is the newest dot, joined to the series", async () => {
  const D = 24 * H;
  const daily = [5, 6, 7].map((value, i) => ({ at: T0 + i * D, value }));
  const live = { at: T0 + 2 * D + 10 * H, value: 9 };
  const m = await mount(chart({ points: daily, win: { from: T0, to: live.at }, interval_ms: D, threshold: undefined, live }));
  expect(m.series("live")).toHaveLength(2);
  expect((m.series("now")[0] as { value: number[] }).value).toEqual([live.at, 9]);
  m.done();
});

test("the state pill: alert with its age, a failing read, paused, and nothing for a series", async () => {
  const base = { points: POINTS, direction: "above", status: "active", state: "ok", last_value: 14, threshold: 20 } as any;
  const now = T0 + 6 * H;
  const cases: [any, string | null][] = [
    [{ ...base, state: "alert", last_value: 30, points: POINTS.slice(0, 4) }, "Alert 4h"],
    [{ ...base, last_error: "PostHog answered 403" }, "Erroring"],
    [{ ...base, status: "paused" }, "Paused"],
    [{ ...base }, "OK"],
    [{ ...base, threshold: undefined }, null],
  ];
  for (const [watch, label] of cases) {
    const { container, done } = await mount(<HealthPill watch={watch} now={now} />);
    expect(container.querySelector(".mx-health")?.textContent ?? null).toBe(label);
    done();
  }
});

test("a muted series says so; a muted alert keeps its state and shows the bell", async () => {
  const now = T0 + 6 * H;
  const base = { _id: "w", workspace: "team:t", source_id: "s", short_id: "mw-1", name: "W", query_kind: "hogql", query: "q", direction: "above", interval_ms: H, status: "active", source_name: "s", source_short_id: "src-1", updated_at: now, muted_until: now + H } as any;
  const series = await mount(<HealthPill watch={{ ...base, state: "ok", points: [{ at: now, value: 1 }], last_value: 1, last_at: now }} now={now} />);
  expect(series.container.textContent).toBe("Muted");
  series.done();
  const alert = await mount(<HealthPill watch={{ ...base, threshold: 5, state: "alert", points: [{ at: now, value: 9 }], last_value: 9, last_at: now }} now={now} />);
  expect(alert.container.querySelector("[data-health]")?.getAttribute("data-health")).toBe("alert");
  expect(alert.container.querySelector("[data-muted]")).not.toBeNull();
  alert.done();
});

