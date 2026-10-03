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
const { SurfaceWallView, wallOrder, newestWorsePair, attributeHref, rowHref, wallWindowFrom, wallAxisTicks, WALL_AXIS_LABEL_GAP, WALL_CADENCES, DEFAULT_WALL_CADENCE } = await import("../SurfaceWallView");
const { movedLine } = await import("../WhatMoved");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const data = homeFixture();
const quiet = quietHomeFixture();

async function mount(d = data, active = true) {
  const opened: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/evals"]}>
        <ShortcutProvider>
          <SurfaceWallView data={d} now={HOME_NOW} cadence="all" onCadence={() => {}} onOpen={(h) => opened.push(h)} active={active} />
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
    expect(rowHref(settle)).toBe(`/evals/s/settle?${new URLSearchParams({ batch: pair.bad, compare: pair.good! })}`);
    expect(rowHref(data.surfaces.find((s) => s.id === "title")!)).toBe("/evals/s/title");
    expect(attributeHref(quiet.surfaces, "title")).toBe("/evals/bisect/new?surface=title");
  });
});

describe("the time window", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-10-04T06:00:00Z");
  const at = (iso: string) => ({ surfaces: [{ ...data.surfaces[0], strip: [{ ...data.surfaces[0].strip[0], batchAt: iso }] }], spendByDay: [] });

  it("starts just before the oldest batch, so a short history fills the strip", () => {
    const oldest = Date.parse("2026-09-20T12:00:00Z");
    expect(wallWindowFrom(at("2026-09-20T12:00:00Z"), now)).toBe(oldest - (now - oldest) * 0.03);
  });

  it("is never narrower than 2 days nor wider than 30", () => {
    expect(wallWindowFrom(at("2026-10-03T23:00:00Z"), now)).toBe(now - 2 * DAY);
    expect(wallWindowFrom(at("2026-07-01T12:00:00Z"), now)).toBe(now - 30 * DAY);
    expect(wallWindowFrom({ surfaces: [], spendByDay: [] }, now)).toBe(now - 30 * DAY);
  });

  it("never sets two date labels closer than a label is wide, down to a split pane's strip", () => {
    // The real home spans a few days, so the axis ticks daily; at 180px the shared 28px gap overlapped "Sep 29" and "Sep 30".
    const from = now - 6 * DAY;
    for (const width of [120, 180, 240, 320, 480, 760]) {
      const ticks = wallAxisTicks(from, now, width);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i].x - ticks[i - 1].x).toBeGreaterThanOrEqual(WALL_AXIS_LABEL_GAP);
      expect(ticks.every((t) => t.x >= 0 && t.x <= width)).toBe(true);
    }
    // A wide strip still labels every day.
    expect(wallAxisTicks(from, now, 760).length).toBeGreaterThanOrEqual(6);
  });
});

describe("the cadence", () => {
  it("defaults to every batch, since agent surfaces and most call batches carry no cadence", () => {
    expect(DEFAULT_WALL_CADENCE).toBe("all");
    expect(WALL_CADENCES[0].key).toBe("all");
    const nightly = homeFixture({ cadence: "nightly" });
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
    expect(tip?.textContent).toContain(`${last.reps} reps`);
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
    for (const e of data.moved) expect(movedLine(e).text).not.toMatch(/undefined|null/);
    // The open bisect rides the foot as a ribbon; the finished one does not.
    expect(m.container.querySelector('[data-ev-bisect-ribbon="b-settle-1003"]')).not.toBeNull();
    expect(m.container.querySelector('[data-ev-bisect-ribbon="b-settle-0927"]')).toBeNull();
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
});
