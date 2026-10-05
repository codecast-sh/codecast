// The freeze page (U10): the default pair straddles the newest flip the
// surface ledger names, the view paints the label, production's reply, the
// moment with its cut, every rep as a dot, the two cards and the "prompt
// changed" banner, and the connected page reads all of it through the fixture
// transport.

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/evals", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Element: dom.window.Element,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  MouseEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle,
  // jsdom has no layout: the panes measure 0 and the view takes its narrow layout.
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { useEvalsStore } = await import("../../../store/evalsStore");
const { fixtureTransport } = await import("../../../lib/evals/fixtureTransport");
const { freezeFixture } = await import("../__fixtures__/freeze");
const { FreezeView, FreezeRepStrip } = await import("../FreezeView");
const { defaultFreezePair, batchColumns, shownRep, promptFilePairs, attributionEnds, pairStory, tickLabel } = await import("../freezeModel");
const { FreezePage } = await import("../pages/FreezePage");
type FreezePair = import("../FreezeView").FreezePair;

// A loaded machine renders a DiffView in seconds, not milliseconds.
setDefaultTimeout(60_000);

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const fx = freezeFixture();
const rowOf = (id: string | null) => fx.freeze.runs.find((r) => r.id === id)!;

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={["/evals"]}>{node}</MemoryRouter>));
  return {
    container,
    rerender: (next: React.ReactNode) => act(async () => root.render(<MemoryRouter initialEntries={["/evals"]}>{next}</MemoryRouter>)),
    unmount: () => act(async () => root.unmount()),
  };
}

const click = (el: Element | null) =>
  act(async () => {
    el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

describe("the default pair", () => {
  it("is the last pass before the newest break and the first fail after it", () => {
    const { pick, cells } = fx;
    expect(pick.flip?.direction).toBe("broke");
    const a = rowOf(pick.a);
    const b = rowOf(pick.b);
    expect(a.batch).toBe(pick.flip!.before);
    expect(b.batch).toBe(pick.flip!.batch);
    expect(a.status).toBe("pass");
    expect(b.status).toBe("fail");
    // The newest flip: no later batch of this freeze flipped.
    const later = Object.entries(cells).filter(([batch, c]) => c.flip && batch > pick.flip!.batch);
    expect(later).toEqual([]);
    // Last pass in the batch before, first fail in the flipping batch.
    const passesBefore = fx.freeze.runs.filter((r) => r.batch === pick.flip!.before && r.status === "pass").sort((x, y) => x.stamp.localeCompare(y.stamp));
    const failsAfter = fx.freeze.runs.filter((r) => r.batch === pick.flip!.batch && r.status === "fail").sort((x, y) => x.stamp.localeCompare(y.stamp));
    expect(pick.a).toBe(passesBefore[passesBefore.length - 1].id);
    expect(pick.b).toBe(failsAfter[0].id);
  });

  it("takes the batch the page was opened on in the flip's place", () => {
    const cols = batchColumns(fx.freeze.runs).filter((c) => c.reps.some((r) => r.status === "pass" || r.status === "fail"));
    const pinned = cols[3].batch;
    const pick = defaultFreezePair(fx.freeze.runs, fx.cells, pinned);
    expect(rowOf(pick.b).batch).toBe(pinned);
    expect(cols.findIndex((c) => c.batch === rowOf(pick.a).batch)).toBeLessThan(3);
    expect(pick.why).toMatch(/opened on/);
  });

  it("falls back to the newest two graded batches, and says why", () => {
    const steady = defaultFreezePair(fx.steady.freeze.runs, fx.steady.cells, null);
    expect(steady.flip).toBeNull();
    expect(steady.why).toMatch(/No flip on the same footing/);
    const cols = batchColumns(fx.steady.freeze.runs).filter((c) => c.reps.some((r) => r.status === "pass" || r.status === "fail"));
    expect(fx.steady.freeze.runs.find((r) => r.id === steady.b)!.batch).toBe(cols[cols.length - 1].batch);
    const blind = defaultFreezePair(fx.freeze.runs, null, null);
    expect(blind.flip).toBeNull();
    expect(blind.why).toMatch(/ledger is not loaded/);
    expect(defaultFreezePair([], null, null)).toMatchObject({ a: null, b: null });
  });

  it("pairs every rendered prompt file of both reps", () => {
    const pairs = promptFilePairs(fx.runs[fx.pick.a!], fx.runs[fx.pick.b!]);
    expect(pairs.map((p) => p.file)).toEqual(["call1/system.md", "call1/prompt.md"]);
    expect(pairs[0].a.text).not.toBe(pairs[0].b.text);
  });
});

describe("the strip's axis", () => {
  it("names a day once and the time of later ticks on that day", () => {
    const cols = ["2026-10-02T09:00:00", "2026-10-02T13:00:00", "2026-10-03T09:00:00"].map((at) => ({ at }));
    const labels = [0, 1, 2].map((k) => tickLabel(cols, [0, 1, 2], k));
    expect(labels[0]).toMatch(/Oct 2/);
    expect(labels[1]).not.toMatch(/Oct/);
    expect(labels[1]).toMatch(/1:00/);
    expect(labels[2]).toMatch(/Oct 3/);
  });
});

describe("the view", () => {
  const props = (pair: FreezePair, onPair: (p: FreezePair) => void = () => {}) => ({
    freeze: fx.freeze,
    cells: fx.cells,
    footing: fx.footing,
    pinnedBatch: null,
    pair,
    pick: fx.pick,
    runA: pair.a ? fx.runs[pair.a] : null,
    runB: pair.b ? fx.runs[pair.b] : null,
    onPair,
  });

  it("paints the label, production's reply and the moment cut where the freeze was taken", async () => {
    const { container, unmount } = await mount(<FreezeView {...props(fx.pick)} />);
    expect(container.querySelector("[data-ev-label-verdict]")?.textContent).toContain(String((fx.freeze.label as { verdict: string }).verdict));
    expect(container.querySelector("[data-ev-production]")?.textContent).toContain('{"state":"waiting"}');
    const lines = [...container.querySelectorAll("[data-ev-moment-line]")];
    expect(lines.length).toBe(fx.freeze.moment.length);
    expect(lines.filter((l) => l.getAttribute("data-ev-moment-line") === "before").length).toBe(fx.freeze.cutAt);
    // The cut sits right before the first line after it.
    const cut = container.querySelector("[data-ev-frozen-cut]")!;
    expect(cut.parentElement!.querySelector("[data-ev-moment-line]")?.getAttribute("data-ev-moment-line")).toBe("after");
    await unmount();
  });

  it("draws every shown rep as a dot, the broke notch, and marks A and B", async () => {
    const { container, unmount } = await mount(<FreezeView {...props(fx.pick)} />);
    const shown = fx.freeze.runs.filter(shownRep);
    expect(container.querySelectorAll("[data-ev-rep]").length).toBe(shown.length);
    expect(container.querySelectorAll('[data-ev-strip-flip="broke"]').length).toBe(Object.values(fx.cells).filter((c) => c.flip === "broke").length);
    expect(container.querySelector(`[data-ev-selected-rep="${fx.pick.a}"]`)?.textContent).toBe("A");
    expect(container.querySelector(`[data-ev-selected-rep="${fx.pick.b}"]`)?.textContent).toBe("B");
    expect(container.querySelectorAll("[data-ev-epoch-band]").length).toBe(fx.freeze.epochs.length);
    await unmount();
  });

  it("draws each rep with the seismograph's own mark: the dirty hatch, a failed gate dropped to 0 with the gate tick, footing glyphs", async () => {
    // Plant a gate failure on one of the two fails, both at one score, and a footing change of each kind.
    const fails = fx.freeze.runs.filter((r) => r.status === "fail");
    const runs = fx.freeze.runs.map((r) => (r.id === fails[0].id ? { ...r, score: 0.62, gatesFailed: ["no-leak"] } : r.id === fails[1].id ? { ...r, score: 0.62, gatesFailed: [] } : r));
    const batches = batchColumns(runs).map((c) => c.batch);
    const footing = [
      { batch: batches[5], batchAt: batches[5], kind: "model" as const, from: "haiku", to: "sonnet" },
      { batch: batches[9], batchAt: batches[9], kind: "judge" as const, from: "r1", to: "r2" },
    ];
    const { container, unmount } = await mount(<FreezeRepStrip runs={runs} epochs={fx.freeze.epochs} footing={footing} cells={fx.cells} pair={fx.pick} pinnedBatch={null} width={900} />);
    const mark = (id: string) => container.querySelector(`[data-ev-rep="${id}"]`)!;
    const cyOf = (id: string) => Number(mark(id).querySelector("circle:not([fill^='url']):not([fill='transparent'])")!.getAttribute("cy"));
    expect(mark(fails[0].id).getAttribute("data-ev-dot")).toBe("fail");
    expect(mark(fails[0].id).querySelector("[data-ev-gate-tick]")?.getAttribute("class")).toBe("ev-gate");
    expect(mark(fails[1].id).querySelector("[data-ev-gate-tick]")).toBeNull();
    expect(cyOf(fails[0].id)).toBeGreaterThan(cyOf(fails[1].id));
    const dirty = runs.filter((r) => shownRep(r) && r.dirty);
    expect(dirty.length).toBeGreaterThan(0);
    for (const r of dirty) expect(mark(r.id).querySelector("circle[fill='url(#ev-sf-hatch)']")).not.toBeNull();
    expect(container.querySelector("pattern#ev-sf-hatch")).not.toBeNull();
    expect(container.querySelectorAll('[data-ev-footing="model"]').length).toBe(1);
    expect(container.querySelectorAll('[data-ev-footing="judge"]').length).toBe(1);
    await unmount();
  });

  it("puts the two cards either side of the break with the prompt change between them", async () => {
    const { container, unmount } = await mount(<FreezeView {...props(fx.pick)} />);
    const cards = container.querySelector("[data-ev-cards]")!;
    const order = [...cards.children].map((c) => (c.hasAttribute("data-ev-card-slot") ? c.getAttribute("data-ev-card-slot") : c.hasAttribute("data-ev-prompt-changed") ? "banner" : "other"));
    expect(order).toEqual(["A", "banner", "B"]);
    expect(container.querySelector('[data-ev-card-slot="A"]')?.textContent).toContain("before the flip");
    expect(container.querySelector('[data-ev-card-slot="B"]')?.textContent).toContain("after the flip");
    expect(container.querySelector("[data-ev-prompt-changed]")?.textContent).toMatch(/Prompt changed/);
    // A prompt change is a new epoch, not a verdict: the banner borrows none of the fixed pass, fail or gate colours.
    expect(container.querySelector("[data-ev-prompt-changed]")?.getAttribute("style") ?? "").not.toMatch(/sol-(magenta|cyan|red)/);
    expect(container.querySelector("[data-ev-prompt-diff]")).not.toBeNull();
    expect(container.querySelector("[data-ev-pair-why]")?.textContent).toMatch(/last pass before the newest flip/);
    await unmount();
  });

  it("says the prompt held still when both reps share a promptSha", async () => {
    const before = fx.freeze.runs.filter((r) => r.batch === fx.pick.flip!.before && r.status !== "crash");
    const pair = { a: before[0].id, b: before[before.length - 1].id };
    const { container, unmount } = await mount(<FreezeView {...props(pair)} />);
    expect(container.querySelector("[data-ev-prompt-changed]")).toBeNull();
    expect(container.querySelector("[data-ev-prompt-same]")?.textContent).toMatch(/Same prompt/);
    await unmount();
  });

  it("sets A then B from clicks on the dots, swaps them, and pairs production with either", async () => {
    const calls: FreezePair[] = [];
    const shown = fx.freeze.runs.filter((r) => shownRep(r) && r.status === "pass");
    const { container, rerender, unmount } = await mount(<FreezeView {...props(fx.pick, (p) => calls.push(p))} />);
    await click(container.querySelector(`[data-ev-rep="${shown[0].id}"]`));
    expect(calls[0]).toEqual({ a: shown[0].id, b: fx.pick.b });
    expect(container.querySelector("[data-ev-next-slot]")?.getAttribute("data-ev-next-slot")).toBe("b");
    await click(container.querySelector(`[data-ev-rep="${shown[1].id}"]`));
    expect(calls[1]).toEqual({ a: fx.pick.a, b: shown[1].id });
    await click(container.querySelector("[data-ev-swap]"));
    expect(calls[2]).toEqual({ a: fx.pick.b, b: fx.pick.a });
    const prodA = [...container.querySelectorAll("button")].find((b) => b.textContent === "prod and A")!;
    await click(prodA);
    await rerender(<FreezeView {...props(fx.pick)} />);
    const cards = container.querySelector('[data-ev-cards="prod-a"]')!;
    expect(cards.children[0].hasAttribute("data-ev-production")).toBe(true);
    expect(cards.querySelector("[data-ev-prompt-changed]")).toBeNull();
    await unmount();
  });

  it("tells the picked pair as it is, not the default's reason", async () => {
    const passes = fx.freeze.runs.filter((r) => shownRep(r) && r.status === "pass").sort((x, y) => x.stamp.localeCompare(y.stamp));
    const picked = { a: passes[passes.length - 1].id, b: passes[0].id };
    const { container, unmount } = await mount(<FreezeView {...props(picked)} />);
    expect(container.querySelector("[data-ev-pair-title]")?.getAttribute("data-ev-pair-title")).toBe("picked");
    expect(container.querySelector("[data-ev-pair-title]")?.textContent).toContain("Two reps you picked");
    expect(container.querySelector("[data-ev-pair-title] [data-ev-verdict]")?.getAttribute("data-ev-verdict")).toBe("pass");
    const why = container.querySelector("[data-ev-pair-why]")!.textContent!;
    expect(why).not.toMatch(/newest flip|Either side/);
    expect(why).toContain(`seed ${passes[0].seed}`);
    expect(why).toContain("A is the later of the two");
    expect(container.querySelector("[data-ev-pair-reset]")).not.toBeNull();
    // A swap of the default pair is a pick too, and its cards still name their own side of the flip.
    const swapped = { a: fx.pick.b, b: fx.pick.a };
    expect(pairStory(swapped, fx.pick, fx.freeze.runs).isDefault).toBe(false);
    await unmount();
    const again = await mount(<FreezeView {...props(swapped)} />);
    expect(again.container.querySelector('[data-ev-card-slot="A"]')?.textContent).toContain("after the flip");
    expect(again.container.querySelector('[data-ev-card-slot="B"]')?.textContent).toContain("before the flip");
    await again.unmount();
  });

  it("orders the attribution ends by time and reads them from the pair, not the loaded cards", async () => {
    const swapped = { a: fx.pick.b, b: fx.pick.a };
    // The cards still hold the old pair while the new one loads.
    const { container, unmount } = await mount(<FreezeView {...props(fx.pick)} pair={swapped} />);
    const q = new URLSearchParams(container.querySelector("[data-ev-attribute]")!.getAttribute("href")!.split("?")[1]);
    expect(q.get("good")).toBe(fx.pick.flip!.before);
    expect(q.get("bad")).toBe(fx.pick.flip!.batch);
    await unmount();
    const cols = batchColumns(fx.freeze.runs);
    const early = cols[2].reps[0];
    const late = cols[cols.length - 3].reps[0];
    expect(attributionEnds({ a: late.id, b: early.id }, fx.freeze.runs, fx.pick)).toEqual({ good: early.batch, bad: late.batch });
    const sameBatch = cols[4].reps;
    expect(attributionEnds({ a: sameBatch[0].id, b: sameBatch[sameBatch.length - 1].id }, fx.freeze.runs, fx.pick)).toEqual({ good: null, bad: sameBatch[0].batch });
    expect(attributionEnds({ a: null, b: null }, fx.freeze.runs, fx.pick)).toEqual({ good: fx.pick.flip!.before, bad: fx.pick.flip!.batch });
  });

  it("links the attribution launcher to this freeze and the pair's batches, and offers the replay command", async () => {
    const { container, unmount } = await mount(<FreezeView {...props(fx.pick)} />);
    const href = container.querySelector("[data-ev-attribute]")!.getAttribute("href")!;
    const q = new URLSearchParams(href.split("?")[1]);
    expect(href.startsWith("/evals/bisect/new?")).toBe(true);
    expect(q.get("freeze")).toBe(fx.freeze.freeze.id);
    expect(q.get("surface")).toBe("settle");
    expect(q.get("good")).toBe(fx.pick.flip!.before);
    expect(q.get("bad")).toBe(fx.pick.flip!.batch);
    expect(container.querySelector("[data-ev-copy] code")?.textContent).toBe(`./evals freeze replay ${fx.freeze.freeze.id} --reps 3`);
    await unmount();
  });
});

describe("the connected page", () => {
  const settle = async () => {
    for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
  };

  it("reads the freeze, the ledger and both cards through the transport", async () => {
    useEvalsStore.setState({ connection: "connected", transport: await fixtureTransport("on", { latencyMs: 0 }), resources: {} });
    const id = fx.freeze.freeze.id;
    const { container, unmount } = await mount(<FreezePage view={{ view: "freeze", freezeId: id, batch: null, a: null, b: null }} />);
    await settle();
    // The transport's world runs on today's clock, so its run ids are its own: read the answers it gave.
    const res = useEvalsStore.getState().resources;
    const freeze = res[`GET /freeze/${id}`]?.data as import("@codecast/shared/contracts/evalsApi").FreezeResponse;
    const surface = res["GET /surface/settle"]?.data as import("@codecast/shared/contracts/evalsApi").SurfaceResponse;
    expect(freeze && surface).toBeTruthy();
    const pick = defaultFreezePair(freeze.runs, surface.ledger.find((r) => r.freezeId === id)!.cells, null);
    expect(container.querySelector(`[data-evals-freeze="${id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-ev-card-slot="A"] [data-ev-reply="${pick.a}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-ev-card-slot="B"] [data-ev-reply="${pick.b}"]`)).not.toBeNull();
    expect(container.querySelector("[data-ev-prompt-changed], [data-ev-prompt-same]")).not.toBeNull();
    await unmount();
  });

  it("says plainly when the freeze is not on this machine", async () => {
    useEvalsStore.setState({ connection: "connected", transport: await fixtureTransport("on", { latencyMs: 0 }), resources: {} });
    const { container, unmount } = await mount(<FreezePage view={{ view: "freeze", freezeId: "00000000-nope", batch: null, a: null, b: null }} />);
    await settle();
    expect(container.textContent).toContain("No freeze with this id");
    await unmount();
  });
});
