// The metric chart, mounted: points sit at their times, time past the line is
// drawn as bands, hovering reads time, value and distance to the line, and
// dragging the line hands back a round number on release. The state pill says
// what a watch is doing and nothing for a plain series.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/ops/metrics/mw-1" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { MetricChart, HealthPill } = await import("../MetricChart");
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
  await act(async () => { root.render(node); });
  const plot = container.querySelector(".mx-plot") as HTMLElement | null;
  if (plot) plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 200, right: 600, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const fire = (el: Element, type: string, init: Record<string, number>) => act(async () => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, ...init }) as any;
    e.pointerId = 1;
    el.dispatchEvent(e);
  });
  return { container, plot, fire, done: () => { root.unmount(); container.remove(); } };
}

const chart = (over: Partial<ChartProps> = {}) => <MetricChart points={POINTS} win={WIN} interval_ms={H} threshold={20} direction="above" height={200} full {...over} />;

test("time past the line is a band from crossing to recovery, and a strip on the time axis", async () => {
  const { container, done } = await mount(chart());
  const bands = [...container.querySelectorAll("rect.mx-band")];
  expect(bands).toHaveLength(1);
  // Crossed at the third read (2h of 6h), back at the fifth (4h): a third of the width, starting a third in.
  expect(Number(bands[0].getAttribute("x"))).toBeCloseTo(333.3, 0);
  expect(Number(bands[0].getAttribute("width"))).toBeCloseTo(333.3, 0);
  expect(container.querySelectorAll(".mx-band-strip")).toHaveLength(1);
  expect(container.querySelector(".mx-threshold")).not.toBeNull();
  done();
});

test("a hole in the polls breaks the line instead of drawing a slope across it", async () => {
  const gappy = [...POINTS.slice(0, 3), ...POINTS.slice(3).map((p) => ({ ...p, at: p.at + 20 * H }))];
  const { container, done } = await mount(chart({ points: gappy, win: { from: T0, to: T0 + 26 * H } }));
  expect(container.querySelectorAll("g:not([data-past]) > path.mx-line:not([data-point-marker])")).toHaveLength(2);
  done();
});

test("hovering reads the nearest value with its distance to the line", async () => {
  const { plot, fire, container, done } = await mount(chart());
  await fire(plot!, "pointermove", { clientX: 300, clientY: 50 });
  const tip = container.querySelector(".mx-tip")!;
  expect(tip.querySelector("b")!.textContent).toBe("30");
  expect(tip.querySelector("[data-past]")!.textContent).toBe("+10 vs line");
  done();
});

test("dragging the line hands back a round value on release", async () => {
  const moved: number[] = [];
  const { container, fire, done } = await mount(chart({ onThreshold: (v) => moved.push(v) }));
  const handle = container.querySelector(".mx-handle")!;
  expect(handle.textContent).toBe("20");
  await fire(handle, "pointerdown", { clientX: 590, clientY: 100, button: 0 });
  await fire(handle, "pointermove", { clientX: 590, clientY: 30 });
  await fire(handle, "pointerup", { clientX: 590, clientY: 30 });
  expect(moved).toHaveLength(1);
  expect(moved[0]).toBeGreaterThan(20);
  expect(Number.isInteger(moved[0] * 10)).toBe(true);
  done();
});

test("dragging across the plot zooms to that span", async () => {
  const zooms: { from: number; to: number }[] = [];
  const { plot, fire, done } = await mount(chart({ onZoom: (w) => zooms.push(w) }));
  await fire(plot!, "pointerdown", { clientX: 100, clientY: 100, button: 0 });
  await fire(plot!, "pointermove", { clientX: 400, clientY: 100 });
  await fire(plot!, "pointerup", { clientX: 400, clientY: 100 });
  expect(zooms).toEqual([{ from: T0 + H, to: T0 + 4 * H }]);
  done();
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

test("markers sit at their moments and link where they lead; a warn line and a min to max band draw beside the line", async () => {
  const folded = POINTS.map((p) => ({ ...p, min: p.value - 2, max: p.value + 2 }));
  const marks = [
    { at: T0 + 2 * H, kind: "crossed" as const, label: "Crossed the line at 25", sub: "eg-1", href: "/ops/issues/eg-1" },
    { at: T0 + 3 * H, kind: "ship" as const, label: "Landed abcdef1", href: "https://github.com/x/commit/abc", external: true },
    { at: T0 - H, kind: "fix" as const, label: "Outside the window" },
  ];
  const m = await mount(<MemoryRouter><MetricChart points={folded} win={WIN} interval_ms={H} threshold={20} warn={16} direction="above" unit="/day" marks={marks} height={200} full /></MemoryRouter>);
  const shown = [...m.container.querySelectorAll("[data-metric-mark]")] as HTMLElement[];
  expect(shown.map((e) => e.dataset.metricMark)).toEqual(["crossed", "ship"]);
  expect(shown[0].style.left).toBe(`${(2 / 6) * 100}%`);
  expect(shown[0].querySelector("a")?.getAttribute("href")).toBe("/ops/issues/eg-1");
  expect(shown[1].querySelector("a")?.getAttribute("target")).toBe("_blank");
  expect(shown[0].textContent).toContain("Crossed the line at 25");
  expect(m.container.querySelector(".mx-warn")).not.toBeNull();
  expect(m.container.querySelector(".mx-range")?.getAttribute("d")).toMatch(/^M/);
  // The gutter is as wide as the widest label, so "/day" never spills past the card.
  const gutter = (m.container.querySelector(".mx-y") as HTMLElement).style.width;
  expect(parseFloat(gutter)).toBeGreaterThan(3);
  m.done();
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

test("the line keeps its ink and turns red only past the line: a copy clipped to the alerting side", async () => {
  const { container, done } = await mount(chart());
  const base = container.querySelector("g:not([data-past]) > path.mx-line") as SVGPathElement;
  const past = container.querySelector("g[data-past] > path.mx-line") as SVGPathElement;
  expect(base.style.stroke).toBe("var(--sol-cyan)");
  expect(past.style.stroke).toBe("var(--sol-red)");
  const clip = container.querySelector("clipPath rect")!;
  // Above the line at 20 is the top of the plot down to the line.
  expect(Number(clip.getAttribute("y"))).toBeLessThan(0);
  expect(container.querySelector("g[data-past]")!.getAttribute("clip-path")).toMatch(/^url\(#mxclip/);
  done();
});

test("a daily backfill is a line at its own cadence with a marker per value, broken where the hourly polls begin, and the tip names the cadence", async () => {
  const D = 24 * H;
  const daily = [5, 4, 3, 2].map((d, i) => ({ at: T0 - d * D, value: 10 + i }));
  const hourly = [0, 1, 2, 3].map((h) => ({ at: T0 + h * H, value: 12 }));
  const { container, plot, fire, done } = await mount(chart({ points: [...daily, ...hourly], win: { from: T0 - 5 * D, to: T0 + 4 * H }, threshold: undefined }));
  const lines = [...container.querySelectorAll("g:not([data-past]) > path.mx-line:not([data-point-marker])")].map((p) => p.getAttribute("d") ?? "");
  // Two runs: the four daily values joined, then the hourly polls; never one stroke from the last day into the polls.
  expect(lines).toHaveLength(2);
  expect(lines[0].match(/L/g)).toHaveLength(3);
  expect(container.querySelector("path[data-sparse-tick]")).toBeNull();
  // Each daily value carries a marker; the hourly polls, packed tight on screen, do not.
  expect(container.querySelector("path[data-point-marker]")?.getAttribute("d")?.match(/M/g)).toHaveLength(4);
  const frac = (3 * D) / (5 * D + 4 * H);
  await fire(plot!, "pointermove", { clientX: frac * 600, clientY: 50 });
  expect(container.querySelector("[data-tip-sparse]")?.textContent).toBe("one value per 1d here");
  done();
});

test("a daily series and its previous period are lines through their days; a lone value is a tick", async () => {
  const D = 24 * H;
  const days = [135, 0, 15, 140].map((value, i) => ({ at: T0 + i * D, value }));
  const prior = [20, 30, 25, 10].map((value, i) => ({ at: T0 + i * D, value }));
  const { container, done } = await mount(chart({ points: days, compare: prior, interval_ms: D, win: { from: T0 - D / 2, to: T0 + 3.5 * D }, threshold: 100 }));
  expect(container.querySelector("g:not([data-past]) > path.mx-line:not([data-point-marker])")?.getAttribute("d")?.match(/L/g)).toHaveLength(3);
  expect(container.querySelector("path.mx-prev")?.getAttribute("d")?.match(/L/g)).toHaveLength(3);
  done();
  const lone = await mount(chart({ points: [{ at: T0 + 3 * H, value: 12 }], threshold: undefined }));
  expect(lone.container.querySelector("path[data-sparse-tick]")).not.toBeNull();
  lone.done();
});

test("ships are ticks on the time axis, clustered when close, and the one nearest the pointer stands full height", async () => {
  const ship = (at: number, label: string) => ({ at, kind: "deploy" as const, label, href: `https://github.com/x/commit/${label}`, external: true });
  // Three ships within a minute of each other and one apart: two markers at a 1000px plot.
  const ships = [ship(T0 + H, "a"), ship(T0 + H + 30_000, "b"), ship(T0 + H + 60_000, "c"), ship(T0 + 4 * H, "d")];
  const m = await mount(<MemoryRouter>{chart({ ships })}</MemoryRouter>);
  const markers = [...m.container.querySelectorAll("[data-metric-ship]")] as HTMLElement[];
  expect(markers.map((e) => e.dataset.metricShip)).toEqual(["3", "1"]);
  expect(markers[0].querySelector(".mx-ship-head")?.textContent).toBe("3");
  expect(markers[0].querySelectorAll(".mx-ship-list li")).toHaveLength(3);
  expect(m.container.querySelector("[data-ship-line]")).toBeNull();
  await m.fire(m.plot!, "pointermove", { clientX: (4 / 6) * 600, clientY: 50 });
  expect(m.container.querySelector("[data-ship-line]")).not.toBeNull();
  expect(m.container.querySelector("[data-metric-ship='1']")?.hasAttribute("data-hot")).toBe(true);
  m.done();
});

test("while the window's values load, a bar shows and nothing is drawn as the answer", async () => {
  const { container, done } = await mount(chart({ loading: true }));
  expect(container.querySelector("[data-metric-loading]")).not.toBeNull();
  expect(container.querySelectorAll("path.mx-line")).toHaveLength(0);
  expect(container.querySelector(".mx-empty")).toBeNull();
  expect(container.querySelectorAll(".mx-x span")).toHaveLength(0);
  done();
});

test("a line being typed is drawn where it would sit, and a card names where its window starts", async () => {
  const g = await mount(chart({ ghostLine: 12 }));
  expect(g.container.querySelector("[data-ghost-line]")).not.toBeNull();
  g.done();
  const spark = await mount(<MetricChart points={POINTS} win={WIN} interval_ms={H} direction="above" axisStart />);
  expect(spark.container.querySelector("[data-axis-start]")?.textContent).toBeTruthy();
  spark.done();
});

test("before the first value held the window is a named gap, with the announced episodes on it and their stretch on hover", async () => {
  // Values only for the last 2 of 12 hours; an episode the monitor announced at hours 2 to 4.
  const win = { from: T0 - 6 * H, to: T0 + 6 * H };
  const { container, plot, fire, done } = await mount(
    <MemoryRouter>
      <MetricChart points={POINTS.slice(4)} win={win} interval_ms={H} threshold={20} direction="above" height={200} full
        gap={{ from: win.from, to: T0 + 4 * H }} episodes={[{ from: T0 - 4 * H, to: T0 - 2 * H }]} gapAction={<button data-backfill>Read older values</button>} />
    </MemoryRouter>,
  );
  expect(container.querySelector("[data-metric-gap]")).not.toBeNull();
  expect(container.querySelector("[data-metric-gap-label]")?.textContent).toContain("no values held");
  expect(container.querySelector("[data-backfill]")).not.toBeNull();
  expect(container.querySelector(".mx-empty")).toBeNull();
  expect(container.querySelectorAll("rect.mx-band")).toHaveLength(1);
  expect(container.querySelectorAll(".mx-band-strip")).toHaveLength(1);
  // Hover a quarter in (hour -3): inside the announced episode.
  await fire(plot!, "pointermove", { clientX: 150, clientY: 100 });
  expect(container.querySelector("[data-tip-band]")?.textContent).toContain("alerting");
  done();
});

test("a card's line stays inside its plot: a value held from before the window only carries the line to the edge", async () => {
  // A card-size series reaching back past the window, as the overview's fullest held answer does.
  const before = [{ at: T0 - 2 * H, value: 40 }, ...POINTS, { at: T0 + 8 * H, value: 5 }];
  for (const full of [false, true]) {
    const { container, done } = await mount(chart({ points: before, full, height: full ? 200 : 72 }));
    const paths = [...container.querySelectorAll("path.mx-line, path.mx-area, path.mx-range")];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const xs = [...(p.getAttribute("d") ?? "").matchAll(/[ML](-?[\d.]+),/g)].map((m) => Number(m[1]));
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1000);
      }
    }
    // The newest dot is the newest value inside the window, never the one after it.
    const dot = container.querySelector(".mx-dot:not([data-hover])") as HTMLElement;
    expect(parseFloat(dot.style.left)).toBeLessThanOrEqual(100);
    done();
  }
});

test("a stretch with no values is a hatched strip naming its span and missed polls, and the alert band stops at it", async () => {
  // Hourly, past the line on both sides of a 30h hole.
  const holed = [10, 25, 26].map((value, i) => ({ at: T0 + i * H, value })).concat([27, 28, 12].map((value, i) => ({ at: T0 + (32 + i) * H, value })));
  const win = { from: T0, to: T0 + 36 * H };
  const { container, plot, fire, done } = await mount(chart({ points: holed, win, poll_ms: H }));
  const hole = container.querySelector("[data-metric-hole]") as HTMLElement;
  expect(hole).not.toBeNull();
  expect(hole.getAttribute("data-metric-hole")).toBe("29");
  // Two bands: before the hole and after it, none across it.
  const bands = [...container.querySelectorAll("rect.mx-band")].map((b) => [Number(b.getAttribute("x")), Number(b.getAttribute("width"))]);
  expect(bands).toHaveLength(2);
  for (const [x, w] of bands) expect(x + w <= (2 / 36) * 1000 + 1 || x >= (32 / 36) * 1000 - 1).toBe(true);
  // Hovering the middle of the hole names it.
  await fire(plot!, "pointermove", { clientX: 300, clientY: 100 });
  const tip = container.querySelector("[data-tip-hole]")?.textContent ?? "";
  expect(tip).toContain("no values");
  expect(tip).toContain("29 polls missed");
  done();
});

test("a value read now sits past the series as the newest dot, joined dashed", async () => {
  const daily = [5, 6, 7].map((value, i) => ({ at: T0 + i * 24 * H, value }));
  const live = { at: T0 + 2 * 24 * H + 10 * H, value: 9 };
  const { container, done } = await mount(chart({ points: daily, win: { from: T0, to: live.at }, interval_ms: 24 * H, threshold: undefined, live }));
  expect(container.querySelector("[data-live-join]")).not.toBeNull();
  const dot = container.querySelector("[data-live-dot]") as HTMLElement;
  expect(parseFloat(dot.style.left)).toBeCloseTo(100, 0);
  done();
});
