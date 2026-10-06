// The surface page (U8): the seismograph draws every rep with its median,
// pass mark, epoch bands and footing glyphs; the ledger sorts by flips and
// notches them; a click pins, a shift-click compares and a drag zooms; two
// pins open the compare drawer with ExamplePair and PromptDiff; an epoch label
// opens its sheet; the keys step, attribute and open the epoch; and the
// connected page reads all of it through the fixture transport.

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/evals/s/settle", pretendToBeVisual: true });
// The epoch sheet is a Radix dialog: its focus scope and dismiss layer walk
// the DOM through the element, event and NodeFilter globals, so expose the
// whole DOM surface (the MobileDrawer mount test's set).
const DOM_GLOBAL = /^(navigator|getComputedStyle|requestAnimationFrame|cancelAnimationFrame|Node|NodeFilter|Element|Text|Range|Selection|Document\w*|MutationObserver|DOMRect\w*|HTML\w*Element|SVG\w*Element|\w*Event)$/;
const restoreGlobals = replaceGlobals({
  ...Object.fromEntries(Object.getOwnPropertyNames(dom.window).filter((k) => DOM_GLOBAL.test(k)).map((k) => [k, (dom.window as unknown as Record<string, unknown>)[k]])),
  window: dom.window,
  document: dom.window.document,
  // jsdom has no layout and no ResizeObserver.
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// jsdom has no layout: give the chart a real width so columns spread out.
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 300, width: 960, height: 300, toJSON() {} } as DOMRect;
};

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
// Session pills resolve through Convex; the marketing stub answers every query with nothing.
const { heroConvexStub } = await import("../../../app/(marketing)/heroFly/convexStub");
const { useEvalsStore } = await import("../../../store/evalsStore");
const { CodecastEvalsProvider } = await import("../host");
const { fixtureTransport } = await import("../../../lib/evals/fixtureTransport");
const { surfaceFixture } = await import("../__fixtures__/surface");
const { SurfaceView } = await import("@platform/evals/react");
const { DEFAULT_SURFACE_FILTERS, nextPins, orderedPair, surfaceColumns, ledgerOrder, niceCeil, axisUsd, separationTitle } = await import("@platform/evals/client");
const { SurfacePage } = await import("@platform/evals/react");
type SurfaceViewProps = import("@platform/evals/react").SurfaceViewProps;

// A loaded machine renders a DiffView in seconds, not milliseconds.
setDefaultTimeout(60_000);

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const settle = await surfaceFixture();

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const wrap = (n: React.ReactNode) => (
    <ConvexProvider client={heroConvexStub}>
      <MemoryRouter initialEntries={["/evals/s/settle"]}><CodecastEvalsProvider>{n}</CodecastEvalsProvider></MemoryRouter>
    </ConvexProvider>
  );
  await act(async () => root.render(wrap(node)));
  return {
    container,
    rerender: (next: React.ReactNode) => act(async () => root.render(wrap(next))),
    unmount: () => act(async () => root.unmount()),
  };
}

function props(over: Partial<SurfaceViewProps> = {}, fx = settle) {
  const calls = { pins: [] as Array<[string | null, string | null]>, nav: [] as string[], epoch: [] as Array<number | null>, filters: [] as unknown[] };
  const p: SurfaceViewProps = {
    data: fx.data,
    models: [...new Set(fx.data.runs.map((r) => r.model!).filter(Boolean))],
    filters: DEFAULT_SURFACE_FILTERS,
    onFilters: (f) => calls.filters.push(f),
    pinned: null,
    compare: null,
    onPins: (a, b) => calls.pins.push([a, b]),
    batches: { res: null, loading: false, error: null },
    epoch: { n: null, res: null, loading: false, error: null },
    onEpoch: (n) => calls.epoch.push(n),
    onNavigate: (href) => calls.nav.push(href),
    keysActive: true,
    ...over,
  };
  return { p, calls };
}

const mouse = (el: Element, type: string, clientX: number, extra: MouseEventInit = {}) =>
  act(async () => void el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX, clientY: 80, button: 0, ...extra })));
const key = (k: string) => act(async () => void dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true })));

describe("the pure pieces", () => {
  it("lays columns out by time or evenly, and orders a pair by when each began", () => {
    const time = surfaceColumns(settle.data.batches, "time", 960);
    const ord = surfaceColumns(settle.data.batches, "ordinal", 960);
    expect(time.list.length).toBe(settle.data.batches.length);
    expect(time.list.every((c, i) => i === 0 || c.x >= time.list[i - 1].x)).toBe(true);
    const gaps = ord.list.slice(1).map((c, i) => Math.round((c.x - ord.list[i].x) * 100));
    expect(new Set(gaps).size).toBe(1);
    expect(orderedPair(time.byBatch, settle.pair[1], settle.pair[0])).toEqual(settle.pair);
  });

  it("pins on click, pins a second on shift-click, and unpins the only pin", () => {
    expect(nextPins(null, null, "a", false)).toEqual(["a", null]);
    expect(nextPins("a", null, "a", false)).toEqual([null, null]);
    expect(nextPins("a", null, "b", true)).toEqual(["a", "b"]);
    expect(nextPins("a", "b", "c", false)).toEqual(["c", null]);
    expect(nextPins(null, null, "b", true)).toEqual(["b", null]);
  });

  it("sorts the ledger by most flips", () => {
    const flips = ledgerOrder(settle.data.ledger).map((r) => r.flips);
    expect(flips).toEqual([...flips].sort((a, b) => b - a));
  });

  it("puts the freezes that flipped between the pinned pair first, broke before fixed", () => {
    const quiet = [...settle.data.ledger].sort((a, b) => a.flips - b.flips)[0];
    const order = ledgerOrder(settle.data.ledger, new Map([[quiet.freezeId, "broke" as const]]));
    expect(order[0].freezeId).toBe(quiet.freezeId);
  });

  it("tops the cost track at a round number whose label fits the gutter", () => {
    for (const v of [0.0004, 0.0042, 0.085, 0.13, 0.6, 1.3, 7, 12, 99, 480]) {
      const top = niceCeil(v);
      expect(top).toBeGreaterThanOrEqual(v);
      expect(top).toBeLessThanOrEqual(v * 5);
      expect(axisUsd(top).length).toBeLessThanOrEqual(5);
    }
    expect(axisUsd(niceCeil(0.085))).toBe("$0.1");
  });

  it("names the test behind a p as the engine ran it: night by night for a pooled cadence baseline, Mann-Whitney otherwise", () => {
    const v = settle.data.latest!;
    expect(v.baseline!.kind).toBe("pooled");
    expect(separationTitle(v)).toMatch(/^Night by night per freeze/);
    expect(separationTitle({ ...v, baseline: { ...v.baseline!, kind: "previous" } })).toMatch(/^One-sided Mann-Whitney/);
    expect(separationTitle({ ...v, separation: { kind: "too-few" } })).not.toMatch(/Mann-Whitney|Night/);
  });
});

describe("what brought the investigator here", () => {
  it("says the latest verdict and its baseline in the header, and pins that comparison on one click", async () => {
    const v = settle.data.latest!;
    expect(v.batch).toBe(settle.pair[1]);
    const { p, calls } = props();
    const { container, unmount } = await mount(<SurfaceView {...p} />);
    const line = container.querySelector("[data-ev-latest-verdict]")!;
    expect(line.getAttribute("data-ev-latest-verdict")).toBe(v.separation.kind);
    expect(line.textContent).toContain(`${v.baseline!.batches.length} nightly batches, night by night per freeze`);
    expect(line.textContent).not.toContain("pooled");
    // The verdict and its baseline are two lines, so neither wraps through the other.
    expect(line.querySelector(".ev-sf-verdictline-base")?.textContent).toMatch(/^weighed against \d+ nightly batches/);
    // The baseline's nights are marked under the seismograph's axis, so "vs 3 nights" can be seen on the chart.
    expect(container.querySelector("[data-ev-baseline]")?.getAttribute("data-ev-baseline")).toBe(String(v.baseline!.batches.length));
    await act(async () => void (container.querySelector("[data-ev-compare-baseline]") as HTMLElement).click());
    expect(calls.pins.at(-1)?.[0]).toBe(v.batch);
    expect(v.baseline!.batches).toContain(calls.pins.at(-1)?.[1] ?? "");
    await unmount();
  });

  it("ticks each commit that touched the declared sources on the axis, and a click opens it", async () => {
    const { p, calls } = props();
    const { container, unmount } = await mount(<SurfaceView {...p} />);
    const ticks = [...container.querySelectorAll("[data-ev-commit-tick]")];
    expect(ticks.length).toBeGreaterThan(0);
    await act(async () => void ticks[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    expect(calls.nav.at(-1)).toBe(`/evals/c/${ticks[0].getAttribute("data-ev-commit-tick")}?surface=settle`);
    await unmount();
  });
});

describe("the seismograph", () => {
  it("draws every rep, the median, the pass mark, epoch bands with perforations, gate ticks and dirty hatches", async () => {
    const { p } = props();
    const { container, unmount } = await mount(<SurfaceView {...p} />);
    const seis = container.querySelector("[data-ev-seismograph]")!;
    expect(seis.querySelectorAll("[data-ev-dot]").length).toBe(settle.data.runs.length);
    expect(seis.querySelector("[data-ev-median]")?.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+H/);
    expect(seis.querySelector("[data-ev-passmark]")).not.toBeNull();
    expect([...seis.querySelectorAll("[data-ev-epoch-label]")].map((e) => e.getAttribute("data-ev-epoch-label"))).toEqual(["1", "2", "3"]);
    expect(seis.querySelectorAll(".ev-sf-perf").length).toBe(2);
    expect(seis.querySelectorAll("[data-ev-gate-tick]").length).toBe(settle.data.runs.filter((r) => r.status === "fail" && r.gatesFailed.length).length);
    expect(seis.querySelectorAll("[data-ev-dirty]").length).toBe(settle.data.runs.filter((r) => r.dirty).length);
    expect(container.querySelectorAll("[data-ev-cost-bar]").length).toBe(settle.data.batches.length);
    await unmount();
  });

  it("puts a diamond on the axis where the model moved and a violet slash where the ruler moved, and facets by model", async () => {
    const insight = await surfaceFixture({ surface: "insight" });
    const title = await surfaceFixture({ surface: "title" });
    const a = await mount(<SurfaceView {...props({}, insight).p} />);
    expect(a.container.querySelectorAll('[data-ev-seismograph] [data-ev-footing="model"]').length).toBe(1);
    const facet = [...a.container.querySelectorAll(".ev-sf-toggle")].find((b) => b.textContent?.includes("facet"))!;
    await act(async () => void (facet as HTMLButtonElement).click());
    expect(a.container.querySelector("[data-ev-seismograph]")?.getAttribute("data-ev-lanes")).toBe("2");
    expect(a.container.querySelectorAll("[data-ev-lane-label]").length).toBe(2);
    await a.unmount();
    const b = await mount(<SurfaceView {...props({}, title).p} />);
    expect(b.container.querySelectorAll('[data-ev-seismograph] [data-ev-footing="judge"]').length).toBe(1);
    await b.unmount();
  });

  it("pins on a click, compares on a shift-click, opens a run from a dot and zooms on a drag", async () => {
    const { p, calls } = props({ pinned: settle.pair[0] });
    const { container, unmount } = await mount(<SurfaceView {...p} />);
    const hit = container.querySelector("[data-ev-seis-hit]")!;
    const cols = surfaceColumns(settle.data.batches, "time", 960);
    const last = cols.list[cols.list.length - 1];
    await mouse(hit, "mousedown", last.x);
    await mouse(hit, "mouseup", last.x);
    expect(calls.pins.at(-1)).toEqual([last.batch, null]);
    await mouse(hit, "mousedown", last.x, { shiftKey: true });
    await mouse(hit, "mouseup", last.x, { shiftKey: true });
    expect(calls.pins.at(-1)).toEqual([settle.pair[0], last.batch]);

    await act(async () => void container.querySelector("[data-ev-dot]")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    expect(calls.nav.at(-1)).toMatch(/^\/evals\/r\/settle-/);

    const before = container.querySelectorAll("[data-ev-cost-bar]").length;
    await mouse(hit, "mousedown", cols.list[2].x);
    await mouse(hit, "mousemove", cols.list[9].x);
    await mouse(hit, "mouseup", cols.list[9].x);
    expect(container.querySelectorAll("[data-ev-cost-bar]").length).toBe(8);
    expect(before).toBeGreaterThan(8);
    expect(container.querySelector("[data-ev-unzoom]")).not.toBeNull();
    await act(async () => void (container.querySelector("[data-ev-unzoom]") as HTMLButtonElement).click());
    expect(container.querySelectorAll("[data-ev-cost-bar]").length).toBe(before);
    await unmount();
  });
});

describe("the freeze ledger", () => {
  it("draws a well per graded batch with flip notches, most flips first, and pins from a column head", async () => {
    const { p, calls } = props();
    const { container, unmount } = await mount(<SurfaceView {...p} />);
    const rows = [...container.querySelectorAll("[data-ev-ledger-row]")];
    expect(rows.length).toBe(settle.data.ledger.length);
    const flips = rows.map((r) => Number(r.getAttribute("data-ev-flips")));
    expect(flips).toEqual([...flips].sort((a, b) => b - a));
    const graded = settle.data.batches.filter((b) => !b.dry).length;
    expect(rows[0].querySelectorAll("[data-ev-well]").length).toBe(graded);
    expect(container.querySelectorAll('[data-ev-ledger] [data-ev-flip="broke"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-ev-ledger] [data-ev-flip="fixed"]').length).toBeGreaterThan(0);
    const head = container.querySelector(`[data-ev-col="${settle.pair[1]}"] button`) as HTMLButtonElement;
    await act(async () => void head.click());
    expect(calls.pins.at(-1)).toEqual([settle.pair[1], null]);
    await unmount();
  });
});

describe("the compare drawer and the epoch sheet", () => {
  it("weighs the later pin against the earlier, with flips as ExamplePairs, the prompt diff and the attribute link", async () => {
    const { p } = props({ pinned: settle.pair[1], compare: settle.pair[0], batches: { res: settle.batches, loading: false, error: null } });
    const { container, unmount } = await mount(<SurfaceView {...p} />);
    const drawer = container.querySelector("[data-ev-compare]")!;
    expect(drawer).not.toBeNull();
    expect(drawer.querySelector("[data-ev-compare-verdict]")?.getAttribute("data-ev-compare-verdict")).toBe(settle.batches.verdict.separation.kind);
    expect(drawer.querySelectorAll(".cc-example").length).toBe(settle.batches.examples.length);
    expect([...drawer.querySelectorAll("[data-ev-example]")].map((e) => e.getAttribute("data-ev-example")).sort()).toEqual(settle.batches.examples.map((e) => e.direction).sort());
    // Changed files are diffed; unchanged ones are named on one line.
    const changed = settle.batches.promptDiffs.filter((p) => p.a.text !== p.b.text);
    expect(drawer.querySelectorAll("[data-ev-prompt-diff]").length).toBe(changed.length);
    expect(changed.length).toBeGreaterThan(0);
    // A gate failing more often says how often, out of how many reps, in which numbered batch.
    for (const li of drawer.querySelectorAll("[data-ev-compare-gates] li")) expect(li.textContent).toMatch(/failed \d+ of \d+ reps? in 1, \d+ of \d+ in 2$/);
    const attribute = drawer.querySelector("[data-ev-attribute]")!.getAttribute("href")!;
    expect(attribute).toContain("/evals/bisect/new?");
    expect(new URLSearchParams(attribute.split("?")[1]).get("good")).toBe(settle.pair[0]);
    expect(new URLSearchParams(attribute.split("?")[1]).get("bad")).toBe(settle.pair[1]);
    await unmount();
  });

  it("opens an epoch from its label and shows its per-freeze prompt diffs and commits", async () => {
    const n = settle.epoch.epoch.n;
    const { p, calls } = props();
    const first = await mount(<SurfaceView {...p} />);
    await act(async () => void first.container.querySelector(`[data-ev-epoch-label="${n}"]`)!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    expect(calls.epoch.at(-1)).toBe(n);
    await first.unmount();
    const { container, unmount } = await mount(<SurfaceView {...props({ epoch: { n, res: settle.epoch, loading: false, error: null } }).p} />);
    const sheet = document.body.querySelector(`[data-ev-epoch-sheet="${n}"]`)!;
    expect(sheet).not.toBeNull();
    expect(sheet.querySelectorAll("[data-ev-prompt-diff]").length).toBe(settle.epoch.diffs.filter((p) => p.a.text !== p.b.text).length);
    // GET /epoch hands over only the files that changed across the boundary, so the sheet has none to name as unchanged.
    expect(settle.epoch.diffs.length).toBeGreaterThan(0);
    expect(sheet.querySelectorAll("[data-ev-unchanged]").length).toBe(0);
    expect(sheet.querySelectorAll("[data-ev-commit]").length).toBe(settle.epoch.commits.length);
    // A commit opens its diff scoped to the surface; its session reads from the
    // trailer (a full link as git log hands it over) as a pill, never as a raw URL.
    const c = settle.epoch.commits.find((x) => x.session)!;
    expect(c.session).toContain("/conversation/");
    const row = sheet.querySelector(`[data-ev-commit="${c.sha}"]`)!;
    expect(row.querySelector(`a[href="/evals/c/${c.sha}?surface=settle"]`)).not.toBeNull();
    expect(row.textContent).not.toContain("http");
    expect([...sheet.querySelectorAll("a")].some((a) => (a.getAttribute("href") ?? "").includes("/conversation/http"))).toBe(false);
    expect(row.querySelector(".entity-ref")).not.toBeNull();
    void container;
    await unmount();
  });

  it("steps the pin with [ and ], opens the pinned epoch with e and attributes with b", async () => {
    const graded = settle.data.batches.filter((b) => !b.dry).map((b) => b.batch);
    const { p, calls } = props({ pinned: settle.pair[1] });
    const { unmount } = await mount(<SurfaceView {...p} />);
    await key("[");
    expect(calls.pins.at(-1)).toEqual([graded[graded.length - 2], null]);
    await key("e");
    expect(calls.epoch.at(-1)).toBe(settle.epoch.epoch.n);
    await key("b");
    expect(calls.nav.at(-1)).toContain(`good=${encodeURIComponent(graded[graded.length - 2])}`);
    await unmount();
  });
});

describe("the connected page", () => {
  it("reads the surface through the transport, and names an unknown surface", async () => {
    useEvalsStore.setState({ connection: "connected", transport: await fixtureTransport("on", { latencyMs: 0 }), resources: {} });
    const { container, unmount } = await mount(<SurfacePage view={{ view: "surface", surface: "settle", batch: null, compare: null }} />);
    for (let i = 0; i < 50 && !container.querySelector("[data-ev-seismograph]"); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(container.querySelector("[data-ev-seismograph]")).not.toBeNull();
    expect(container.querySelector("[data-ev-surface]")?.getAttribute("data-ev-surface")).toBe("settle");
    await unmount();
    const missing = await mount(<SurfacePage view={{ view: "surface", surface: "nope", batch: null, compare: null }} />);
    for (let i = 0; i < 50 && !missing.container.textContent?.includes("No surface named"); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(missing.container.textContent).toContain("No surface named nope");
    // Codecast's own words through the host's words slot, as before the shared views.
    expect(missing.container.textContent).toContain("The wall lists every surface this checkout's registry knows.");
    await missing.unmount();
  });
});
