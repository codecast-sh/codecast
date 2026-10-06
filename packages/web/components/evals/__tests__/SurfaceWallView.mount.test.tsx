// The surface wall (U7, evals-ui.md 4.1): thirteen rows with the worse one
// first and edged, a shared hover cursor whose tooltip names the batch, the
// j/k/Enter/b keys, What moved as links, and the foot's empty states.

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { HOME_NOW, homeFixture, quietHomeFixture } from "../__fixtures__/home";

// Building the world and mounting 13 strips is slow on a loaded machine.
setDefaultTimeout(60_000);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/evals", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  // jsdom lays nothing out: the strip column reports 800px wide.
  ResizeObserver: class {
    constructor(private cb: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {}
    observe() {
      this.cb([{ contentRect: { width: 800, height: 32 } }]);
    }
    unobserve() {}
    disconnect() {}
  },
  CSS: { escape: (s: string) => s.replace(/["\\]/g, "\\$&") },
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ShortcutProvider } = await import("../../../shortcuts");
const { SurfaceWallView } = await import("@platform/evals/react");
const { wallOrder, newestWorsePair, attributeHref, rowHref, wallWindowFrom, WALL_CADENCES, DEFAULT_WALL_CADENCE, movedLine, wallSpend, usd, endpointLabel } = await import("@platform/evals/client");
const { CodecastEvalsProvider, codecastEvalsHost } = await import("../host");
const { evalsHref } = await import("../evalsPaths");
type EvalsHost = import("@platform/evals/react").EvalsHost;

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const data = await homeFixture();
const quiet = await quietHomeFixture();
const nightly = await homeFixture({ cadence: "nightly" });

async function mount(d = data, active = true, host: EvalsHost = codecastEvalsHost) {
  const opened: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/evals"]}>
        <ShortcutProvider>
          <CodecastEvalsProvider host={host}>
            <SurfaceWallView data={d} now={HOME_NOW} cadence="all" onCadence={() => {}} onOpen={(h) => opened.push(h)} active={active} />
          </CodecastEvalsProvider>
        </ShortcutProvider>
      </MemoryRouter>,
    ),
  );
  return {
    container,
    opened,
    rows: () => [...container.querySelectorAll<HTMLElement>("[data-ev-wall-row]")],
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function press(key: string) {
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("the wall's order", () => {
  it("puts rows that separated worse first, then call surfaces, then agent surfaces", () => {
    const order = wallOrder(data.surfaces);
    expect(order).toHaveLength(13);
    expect(order[0].id).toBe("settle");
    expect(order[0].latest?.separation.kind).toBe("worse");
    const rest = order.slice(1);
    const firstAgent = rest.findIndex((s) => s.route === "agent");
    expect(rest.slice(0, firstAgent).every((s) => s.route === "call")).toBe(true);
    expect(rest.slice(firstAgent).every((s) => s.route === "agent")).toBe(true);
  });

  it("names the newest worse pair: the red batch and the newest batch of its baseline", () => {
    const pair = newestWorsePair(data.surfaces)!;
    const settle = data.surfaces.find((s) => s.id === "settle")!;
    expect(pair.surface).toBe("settle");
    expect(pair.bad).toBe(settle.latest!.batch);
    const at = (b: string) => Date.parse(settle.strip.find((x) => x.batch === b)!.batchAt);
    for (const b of settle.latest!.baseline!.batches) expect(at(pair.good!)).toBeGreaterThanOrEqual(at(b));
    expect(newestWorsePair(quiet.surfaces)).toBeNull();
    // A worse row opens its surface with that same pair pinned; any other row opens it plain.
    expect(rowHref(evalsHref, settle)).toBe(`/evals/s/settle?${new URLSearchParams({ batch: pair.bad, compare: pair.good! })}`);
    expect(rowHref(evalsHref, data.surfaces.find((s) => s.id === "title")!)).toBe("/evals/s/title");
    expect(attributeHref(evalsHref, quiet.surfaces, "title")).toBe("/evals/bisect/new?surface=title");
  });
});

describe("the cadence", () => {
  it("defaults to every batch, since agent surfaces and most call batches carry no cadence", () => {
    expect(DEFAULT_WALL_CADENCE).toBe("all");
    expect(WALL_CADENCES[0].key).toBe("all");
    expect(nightly.surfaces.filter((s) => s.route === "agent").every((s) => s.strip.length === 0)).toBe(true);
    expect(data.surfaces.every((s) => s.strip.length > 0)).toBe(true);
  });
});

describe("the wall", () => {
  it("draws 13 rows, the worse one first with its edge, each with a strip, a pass rate and a verdict", async () => {
    const m = await mount();
    const rows = m.rows();
    expect(rows).toHaveLength(13);
    expect(rows[0].dataset.evWallRow).toBe("settle");
    expect(rows[0].hasAttribute("data-ev-worse")).toBe(true);
    expect(rows.filter((r) => r.hasAttribute("data-ev-worse"))).toHaveLength(1);
    expect(rows[0].querySelector("[data-ev-separation]")?.getAttribute("data-ev-separation")).toBe("worse");
    for (const r of rows) {
      expect(r.querySelector("[data-ev-strip]")).not.toBeNull();
      expect(r.querySelector("[data-ev-rate]")?.textContent).toMatch(/^\d+%$/);
    }
    // title's last batch is still landing: it pulses.
    expect(m.container.querySelector('[data-ev-wall-row="title"] [data-ev-landing]')).not.toBeNull();
    expect(m.container.querySelector('[data-ev-wall-row="settle"] [data-ev-landing]')).toBeNull();
    // Epoch notches and footing markers ride the strips.
    expect(m.container.querySelector('[data-ev-wall-row="settle"] [data-ev-epoch]')).not.toBeNull();
    expect(m.container.querySelector('[data-ev-wall-row="insight"] [data-ev-footing="model"]')).not.toBeNull();
    expect(m.container.querySelector('[data-ev-wall-row="title"] [data-ev-footing="judge"]')).not.toBeNull();
    // The worse row's strip marks the batch its verdict is about and the baseline it was weighed against; no other row's does.
    expect(rows[0].querySelector("[data-ev-strip-red]")).not.toBeNull();
    expect(Number(rows[0].querySelector("[data-ev-strip-baseline]")?.getAttribute("data-ev-strip-baseline"))).toBeGreaterThan(0);
    expect(rows.slice(1).some((r) => r.querySelector("[data-ev-strip-red], [data-ev-strip-baseline]"))).toBe(false);
    // The big figure is the newest batch's, and says so.
    expect(rows[0].querySelector(".ev-wall-rate .ev-wall-sub")?.textContent).toMatch(/^\d+ of \d+ reps$/);
    expect(m.container.textContent).toContain("Latest batch");
    await m.unmount();
  });

  it("names one spend window in the header, the surface column and the foot, and the rows add up to the total", async () => {
    const m = await mount();
    const summary = m.container.querySelector(".ev-wall-summary")!.textContent!;
    const window = summary.match(/in (\d+ days?)$/)![1];
    const foot = m.container.querySelector(".ev-wall-row--spend .ev-wall-rate")!;
    expect(foot.querySelector(".ev-wall-sub")!.textContent).toBe(window);
    expect(summary).toContain(foot.querySelector(".ev-tabular")!.textContent!);
    expect([...m.container.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent)).toContain(window);
    // Every figure is wallSpend over the same window: each row's cell, and the rows together make the total.
    const from = wallWindowFrom(data, HOME_NOW);
    for (const s of data.surfaces) expect(m.container.querySelector(`[data-ev-wall-row="${s.id}"] .ev-wall-spend`)!.textContent).toBe(usd(wallSpend(s.spendByDay, from, HOME_NOW).usd));
    const rowsUsd = data.surfaces.reduce((t, s) => t + wallSpend(s.spendByDay, from, HOME_NOW).usd, 0);
    expect(rowsUsd).toBeCloseTo(wallSpend(data.spendByDay, from, HOME_NOW).usd, 1);
    await m.unmount();
  });

  it("shares one hover cursor across every strip and tips the batch under the pointer", async () => {
    const m = await mount();
    const settle = data.surfaces.find((s) => s.id === "settle")!;
    const last = settle.strip[settle.strip.length - 1];
    const hit = m.container.querySelector<SVGRectElement>('[data-ev-wall-row="settle"] .ev-strip-hit')!;
    const svg = hit.ownerSVGElement!;
    const w = Number(svg.getAttribute("width"));
    Object.defineProperty(hit, "getBoundingClientRect", { value: () => ({ left: 0, top: 100, width: w, height: 44, right: w, bottom: 144, x: 0, y: 100 }) });
    const from = HOME_NOW - 30 * 86_400_000;
    const px = 2 + ((Date.parse(last.batchAt) - from) / (HOME_NOW - from)) * (w - 4);
    await act(async () => {
      hit.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: px, clientY: 120, bubbles: true }));
    });
    const strips = m.container.querySelectorAll("[data-ev-wall-row] [data-ev-strip]").length;
    expect(m.container.querySelectorAll("[data-ev-wall-row] .ev-strip-cursor").length).toBe(strips);
    const tip = document.body.querySelector(".ev-wall-tip");
    expect(tip?.textContent).toContain(last.batch);
    expect(tip?.textContent).toContain("median");
    expect(tip?.textContent).toContain(`${last.passed} of ${last.reps} passed`);
    if (last.dirtyReps) expect(tip?.textContent).toContain(`${last.dirtyReps} of ${last.reps + last.crashes} reps dirty`);
    // A click on the point opens the surface with that batch pinned, not the bare surface.
    await act(async () => {
      hit.dispatchEvent(new dom.window.MouseEvent("click", { clientX: px, bubbles: true }));
    });
    expect(m.opened).toEqual([`/evals/s/settle?batch=${encodeURIComponent(last.batch)}`]);
    await m.unmount();
  });

  it("walks with j and k, opens with Enter and attributes the newest worse pair with b", async () => {
    const m = await mount();
    const sel = () => m.rows().findIndex((r) => r.getAttribute("aria-selected") === "true");
    await press("j");
    expect(sel()).toBe(0);
    await press("j");
    await press("j");
    expect(sel()).toBe(2);
    await press("k");
    expect(sel()).toBe(1);
    await press("Enter");
    expect(m.opened.pop()).toBe(`/evals/s/${m.rows()[1].dataset.evWallRow}`);
    await press("b");
    const pair = newestWorsePair(data.surfaces)!;
    expect(m.opened.pop()).toBe(`/evals/bisect/new?surface=settle&good=${encodeURIComponent(pair.good!)}&bad=${encodeURIComponent(pair.bad)}`);
    await m.unmount();
  });

  it("leaves the keys alone when it is not the active pane", async () => {
    const m = await mount(data, false);
    await press("j");
    await press("b");
    expect(m.rows().some((r) => r.getAttribute("aria-selected") === "true")).toBe(false);
    expect(m.opened).toEqual([]);
    await m.unmount();
  });

  it("lists what moved as links, newest first, at most 12", async () => {
    const m = await mount();
    const lines = [...m.container.querySelectorAll<HTMLAnchorElement>("[data-ev-moved] a")];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(12);
    const times = [...m.container.querySelectorAll("[data-ev-moved] time")].map((t) => t.getAttribute("datetime")!);
    expect([...times].sort().reverse()).toEqual(times);
    const sim = data.moved.find((e) => e.kind === "sim-failure");
    if (sim && sim.kind === "sim-failure") expect(lines.some((a) => a.getAttribute("href") === `/evals/sim/${encodeURIComponent(sim.session)}/${encodeURIComponent(sim.run)}`)).toBe(true);
    for (const e of data.moved) expect(movedLine(evalsHref, e, codecastEvalsHost.wall!.moved).text).not.toMatch(/undefined|null/);
    // The open bisect rides the foot as a ribbon; the finished one does not.
    expect(m.container.querySelector('[data-ev-bisect-ribbon="b-settle-1003"]')).not.toBeNull();
    expect(m.container.querySelector('[data-ev-bisect-ribbon="b-settle-0927"]')).toBeNull();
    // Its ends read as every bisect page writes them: a batch as its local time, never a sliced UTC name.
    const open = data.bisects.find((b) => b.id === "b-settle-1003")!;
    const range = m.container.querySelector('[data-ev-bisect-ribbon="b-settle-1003"] .ev-wall-ribbon-range')!.textContent;
    expect(range).toBe(`${endpointLabel(open.good)} to ${endpointLabel(open.bad)}`);
    expect(range).not.toMatch(/\d{4}-\d{2}-(\s|$)/);
    expect(m.container.querySelector("[data-ev-sim-line]")).not.toBeNull();
    await m.unmount();
  });

  it("says so when nothing moved, no bisect runs and no Multiplayer sim session exists", async () => {
    const m = await mount(quiet);
    expect(m.rows().some((r) => r.hasAttribute("data-ev-worse"))).toBe(false);
    expect(m.container.textContent).toContain("Nothing has moved in the window");
    expect(m.container.textContent).toContain("No bisect is running.");
    expect(m.container.textContent).toContain("No Multiplayer sim session on this machine yet.");
    await m.unmount();
  });

  it("marks a Multiplayer sim session that exited non-zero as broken, never as a pass", async () => {
    // A real session: `killUndo --sweep 25` exited 1 after 10 s with no run recorded.
    const base = data.sim!;
    const broke = { ...base, exit: 1, runs: 0, failed: 0, scenarios: 0, failing: [], finishedAt: base.finishedAt ?? base.startedAt };
    const m = await mount({ ...data, sim: broke });
    const line = m.container.querySelector("[data-ev-sim-line]")!;
    expect(line.textContent).toContain("exited 1 before any run");
    expect(line.textContent).not.toContain("none failed");
    expect(line.querySelector("[data-ev-verdict]")!.getAttribute("data-ev-verdict")).toBe("crash");
    await m.unmount();
    const ok = await mount({ ...data, sim: { ...base, exit: 0, failed: 0, failing: [], runs: Math.max(1, base.runs), finishedAt: base.finishedAt ?? base.startedAt } });
    expect(ok.container.querySelector("[data-ev-sim-line] [data-ev-verdict]")!.getAttribute("data-ev-verdict")).toBe("pass");
    await ok.unmount();
  });

  it("draws a host's own parts only through its wall slot: no slot, no sim", async () => {
    const plain: EvalsHost = { ...codecastEvalsHost, wall: undefined };
    expect(data.moved.some((e) => e.kind === "sim-failure")).toBe(true);
    const m = await mount(data, true, plain);
    expect(m.container.querySelector("[data-ev-sim-line]")).toBeNull();
    expect(m.container.textContent).not.toContain("Multiplayer");
    // The event still lands, as a plain line home, rather than vanishing.
    const line = m.container.querySelector<HTMLAnchorElement>('[data-ev-moved-kind="sim-failure"]')!;
    expect(line.getAttribute("href")).toBe("/evals");
    expect(line.querySelector(".ev-moved-mark")!.childElementCount).toBe(0);
    await m.unmount();
    const q = await mount(quiet, true, plain);
    expect(q.container.textContent).toContain("Nothing has moved in the window: no new epoch, footing change, flip or finished bisect.");
    await q.unmount();
    // Codecast's slot names its own kind in the empty line and marks a sim failure with its X.
    const c = await mount(quiet);
    expect(c.container.textContent).toContain("Nothing has moved in the window: no new epoch, footing change, flip, finished bisect or Multiplayer sim failure.");
    await c.unmount();
  });

  it("never shows a pass for a Multiplayer sim session that has not finished", async () => {
    // No finishedAt: still running, or killed before it wrote one.
    const open = { ...data.sim!, exit: null, failed: 0, failing: [], runs: 4, finishedAt: null };
    const m = await mount({ ...data, sim: open });
    const line = m.container.querySelector("[data-ev-sim-line]")!;
    expect(line.textContent).toContain("running or cut short");
    expect(line.querySelector("[data-ev-verdict]")!.getAttribute("data-ev-verdict")).not.toBe("pass");
    await m.unmount();
  });
});
