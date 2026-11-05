// The volume chart, mounted: ECharts draws the bars on a canvas (a no-op
// context here), so these read what the chart was handed and the HTML laid
// over it: stacked bars per bin, a drag picks a range, deploys close
// together merge into one mark, a span with no data is shaded and named.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { installFakeCanvas } from "../../../test-helpers/fakeCanvas";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/ops/timeline" });
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
const { MemoryRouter } = await import("react-router");
const { VolumeChart } = await import("../VolumeChart");
const { histogram } = await import("../timelineModel");
const { echarts } = await import("../chart/echarts");

type Opt = { series: { id: string; data: [number, number | null][] }[]; tooltip: { formatter: (ps: { axisValue: number }[]) => string }[] };
function chartOf(container: HTMLElement) {
  const chart = echarts.getInstanceByDom(container.querySelector("[_echarts_instance_]") as HTMLElement)!;
  const opt = () => chart.getOption() as unknown as Opt;
  const tip = (at: number) => { const d = document.createElement("div"); d.innerHTML = opt().tooltip[0].formatter([{ axisValue: at }]); return d.textContent ?? ""; };
  return { chart, opt, tip };
}

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const H = 3600_000;
const NOW = Date.UTC(2026, 10, 3, 12);

test("bars stack by key, a drag picks a range, and near deploys merge", async () => {
  const range = { from: NOW - 6 * H, to: NOW };
  const bins = histogram([{ at: NOW - 2 * H, k: "error", n: 4 }, { at: NOW - 2 * H, k: "warning", n: 1 }, { at: NOW - 5 * H, k: "error", n: 2 }], (p) => p.at, (p) => p.k, (p) => p.n, range, H);
  const brushed: Array<[number, number]> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <VolumeChart bins={bins} range={range} onBrush={(a, b) => brushed.push([a, b])} marks={[{ at: NOW - 3 * H, label: "dp-1" }, { at: NOW - 3 * H + 60_000, label: "dp-2" }]} />
      </MemoryRouter>,
    );
  });
  const { chart, opt } = chartOf(container);
  const bars = opt().series.filter((x) => x.id !== "bins");
  expect(bars.map((x) => x.id)).toEqual(["error", "warning"]);
  expect(bars[0].data.length).toBe(bins.length);
  expect(bars[0].data.filter((d) => d[1]).map((d) => d[1])).toEqual([2, 4]);
  expect([...container.querySelectorAll(".ovc-legend span")].map((s) => s.textContent)).toEqual(["errors", "warnings"]);
  // Without a measured width the marks cluster as one.
  expect([...container.querySelectorAll(".ovc-mark-label")].map((m) => m.textContent)).toEqual(["2 deploys"]);

  // A sliver is a click, not a pick; a drag past the edges is held to the range.
  await act(async () => { chart.trigger("brushend", { areas: [{ coordRange: [NOW - 3 * H, NOW - 3 * H + 1000] }] }); });
  await act(async () => { chart.trigger("brushend", { areas: [{ coordRange: [range.to + H, range.from - H] }] }); });
  expect(brushed).toEqual([[range.from, range.to]]);
  await act(async () => root.unmount());
});

test("a span with no data is shaded and named, the axis has a top, and a hover names its series", async () => {
  const D = 24 * H;
  const range = { from: NOW - 4 * D, to: NOW };
  const bins = [0, 1, 2, 3].map((i) => ({ from: range.from + i * D, to: range.from + (i + 1) * D, parts: i < 2 ? {} : { rage_click: 7 }, total: i < 2 ? 0 : 7, ...(i < 2 ? { unknown: true } : {}) }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><VolumeChart bins={bins} range={range} /></MemoryRouter>);
  });
  expect(container.querySelector("[data-ops-nodata]")?.textContent).toContain("No data before");
  expect(container.querySelector(".ovc-y")?.textContent).toBe("8");
  expect(container.querySelectorAll(".ovc-tick").length).toBeGreaterThan(0);
  const { tip } = chartOf(container);
  expect(tip(range.from + 3.5 * D)).toContain("rage clicks7");
  expect(tip(range.from + 0.5 * D)).toContain("No data recorded");
  await act(async () => root.unmount());
});

test("a source known to be silent draws its silence from the last event to now, named, apart from missing data", async () => {
  const D = 24 * H;
  const range = { from: NOW - 30 * D, to: NOW };
  const bins = histogram([{ at: NOW - 18 * D, k: "events", n: 1 }], (p) => p.at, (p) => p.k, (p) => p.n, range, D);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><VolumeChart bins={bins} range={range} silence={{ from: NOW - 18 * D, label: "Silent 18d" }} /></MemoryRouter>);
  });
  const band = container.querySelector<HTMLElement>("[data-ops-silence]")!;
  expect(band.textContent).toBe("Silent 18d");
  expect(parseFloat(band.style.left)).toBeCloseTo(40, 0);
  await act(async () => root.unmount());
  container.remove();
});
