// The Multiplayer sim pages (U15): the catalog grid with its markers, history
// and invariant filter, and one run as lanes with replication arcs, step
// bands, the failure rule, the shrink's dimming and a playhead that steps on
// the registered keys. Data comes from the fixture world, the same answers
// the dev transport serves.

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { SimCatalogResponse, SimRunResponse, SimSessionsResponse } from "@codecast/shared/contracts/evalsApi";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { evalsFixtureWorld } from "../__fixtures__/world";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/evals/sim", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle,
  // The lanes size to their container; jsdom lays nothing out, so they take their initial width.
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ShortcutProvider, useShortcuts } = await import("../../../shortcuts/ShortcutProvider");
const { useEvalsStore } = await import("../../../store/evalsStore");
const { fixtureTransport } = await import("../../../lib/evals/fixtureTransport");
const { SimCatalogView } = await import("../SimCatalogView");
const { cellFailure, gridRows, markersFor } = await import("../simModel");
const { SimRunView } = await import("../SimRunView");
const { PLAY_STEP_MS } = await import("../simModel");
const { SimRunPage } = await import("../pages/SimRunPage");
const { SimCatalogPage } = await import("../pages/SimCatalogPage");

// Mounting the lanes and building the fixture world take seconds on a loaded machine.
setDefaultTimeout(60_000);

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const world = evalsFixtureWorld({ now: NOW });
const catalog = world.answer("GET /sim/catalog", {}, {}) as SimCatalogResponse;
const { sessions } = world.answer("GET /sim/sessions", {}, {}) as SimSessionsResponse;
const failingCell = catalog.grid.find((c) => c.newestFailure)!;
const runOf = (session: string, run: string) => world.answer("GET /sim/run/:session/:run", { session, run }, {}) as SimRunResponse;
const shrunk = runOf(failingCell.newestFailure!.session, failingCell.newestFailure!.run);
const olderFail = [...sessions].reverse().find((s) => s.failed && !s.unsessioned && s.id !== failingCell.newestFailure!.session)!;
const unshrunk = runOf(olderFail.id, failingCell.newestFailure!.run);

async function mount(node: React.ReactNode, path = "/evals/sim") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>));
  return { container, unmount: () => act(async () => root.unmount()) };
}

const q = (c: Element, sel: string) => c.querySelector(sel);
const qa = (c: Element, sel: string) => [...c.querySelectorAll(sel)];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits for the page's answer to land: the transport builds its world on first use, which is slow under load. */
async function waitFor(c: Element, sel: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!q(c, sel) && Date.now() < end) await act(async () => wait(25));
  return q(c, sel);
}

describe("the catalog", () => {
  it("lists every scenario by mode, selftests last, with the latest glyph and a history trace", async () => {
    const { container, unmount } = await mount(<SimCatalogView catalog={catalog} sessions={sessions} sweep={{ state: "idle" }} onSweep={() => {}} now={NOW} />);
    const rows = qa(container, "[data-evs-row]");
    expect(rows.length).toBe(catalog.scenarios.length);
    expect(rows.map((r) => r.getAttribute("data-evs-row")).slice(-1)[0]).toBe(catalog.scenarios.filter((s) => s.selftest).slice(-1)[0].name);
    expect(qa(container, ".evs-grid thead th").map((th) => th.textContent)).toEqual(["Scenario", "scripted", "interleave", "Newest run"]);
    const failRow = q(container, `[data-evs-row="${failingCell.scenario}"]`)!;
    expect(qa(failRow, '[data-evs-cell="fail"]').length).toBe(1);
    // One trace per run cell for seeds run (scripted and interleave).
    expect(qa(q(container, '[data-evs-row="agentPingPong"]')!, ".evs-spark path").length).toBe(2);
    // The failed trace is drawn only where a seed failed, so a clean row has no magenta line.
    expect(qa(q(container, '[data-evs-row="agentPingPong"]')!, ".evs-spark-fail").length).toBe(0);
    expect(qa(failRow, ".evs-spark-fail").length).toBe(1);
    await unmount();
  });

  it("links a failing cell to its newest failing run, and a marked cell to its task with a dotted ring", async () => {
    const { container, unmount } = await mount(<SimCatalogView catalog={catalog} sessions={sessions} sweep={{ state: "idle" }} onSweep={() => {}} now={NOW} />);
    const link = q(container, `[data-evs-row="${failingCell.scenario}"] a.evs-cell`)!;
    expect(link.getAttribute("href")).toBe(`/evals/sim/${encodeURIComponent(failingCell.newestFailure!.session)}/${encodeURIComponent(failingCell.newestFailure!.run)}`);
    const red = q(container, '[data-evs-row="roleTriggerScope"]')!;
    expect(qa(red, "[data-evs-marked]").length).toBe(1); // red only in interleave
    expect(q(red, "a.evs-marker")!.getAttribute("href")).toBe("/tasks/ct-55120");
    const known = q(container, '[data-evs-row="visibilityFlip"]')!;
    expect(qa(known, "[data-evs-marked]").length).toBe(2); // known applies to every mode
    await unmount();
  });

  it("filters the grid by invariant from the side panel, and lists what is not compared and every session", async () => {
    const { container, unmount } = await mount(<SimCatalogView catalog={catalog} sessions={sessions} sweep={{ state: "idle" }} onSweep={() => {}} now={NOW} />);
    expect(qa(container, ".evs-inv-row").length).toBe(15);
    expect(qa(container, ".evs-nc-row").length).toBe(catalog.notCompared.length);
    expect(qa(container, "[data-evs-session]").length).toBe(sessions.length);
    expect(qa(container, "[data-evs-legacy]").length).toBe(1);
    const inv = qa(container, ".evs-inv-row").find((b) => b.textContent?.startsWith("INV-followers"))! as HTMLButtonElement;
    expect(inv.querySelector('[data-evs-caught="yes"]')).not.toBeNull();
    await act(async () => inv.click());
    expect(qa(container, "[data-evs-row]").map((r) => r.getAttribute("data-evs-row"))).toEqual([failingCell.scenario]);
    await act(async () => (q(container, "[data-evs-filter]") as HTMLButtonElement).click());
    expect(qa(container, "[data-evs-row]").length).toBe(catalog.scenarios.length);
    await unmount();
  });

  it("filters to what fails now, and opens a session's failing runs and its kept edits", async () => {
    const { container, unmount } = await mount(<SimCatalogView catalog={catalog} sessions={sessions} sweep={{ state: "idle" }} onSweep={() => {}} now={NOW} />);
    await act(async () => (q(container, "[data-evs-failing-filter]") as HTMLButtonElement).click());
    const failingRows = gridRows(catalog).rows.filter((r) => [...r.cells.values()].some((c) => c.latest && !c.latest.passed)).map((r) => r.name);
    expect(failingRows.length).toBeGreaterThan(0);
    expect(qa(container, "[data-evs-row]").map((r) => r.getAttribute("data-evs-row"))).toEqual(failingRows);
    await act(async () => (q(container, '[data-evs-filter="failing"]') as HTMLButtonElement).click());
    expect(qa(container, "[data-evs-row]").length).toBe(catalog.scenarios.length);
    // An older session's failure is one click from the table, not only the grid's newest.
    const older = olderFail;
    expect(q(container, `[data-evs-failing="${older.id}"]`)).toBeNull();
    await act(async () => (q(container, `[data-evs-failed-toggle="${older.id}"]`) as HTMLButtonElement).click());
    const runLinks = qa(q(container, `[data-evs-failing="${older.id}"]`)!, "a").map((a) => a.getAttribute("href"));
    expect(runLinks).toEqual(older.failing.filter((f) => f.dir).map((f) => `/evals/sim/${encodeURIComponent(older.id)}/${encodeURIComponent(f.dir!)}`));
    const kept = sessions.find((x) => x.treePatch)!;
    expect(q(container, `[data-evs-session="${kept.id}"] a.ev-chip--dirty`)!.getAttribute("href")).toBe(`/evals/p/${kept.treePatch}`);
    await unmount();
  });

  it("starts a sweep with the filter and seed count, and shows its job", async () => {
    const calls: Array<[string, number]> = [];
    const { container, unmount } = await mount(<SimCatalogView catalog={catalog} sessions={sessions} sweep={{ state: "idle" }} onSweep={(f, n) => calls.push([f, n])} now={NOW} />);
    await act(async () => (q(container, "[data-evs-sweep-start]") as HTMLButtonElement).click());
    expect(calls).toEqual([["", 20]]);
    await unmount();
    const job = { id: "j1", kind: "sweep" as const, status: "running" as const, startedAt: "", updatedAt: "", tmux: "evals-sim-sweep-j1", progress: { done: 30, total: 120, text: "30 of 120 seeds, 1 failed" }, session: null, run: null };
    const running = await mount(<SimCatalogView catalog={catalog} sessions={sessions} sweep={{ state: "running", job }} onSweep={() => {}} now={NOW} />);
    expect(q(running.container, "[data-evs-sweep]")!.textContent).toContain("30 of 120 seeds, 1 failed");
    expect((q(running.container, ".evs-job-fill") as HTMLElement).style.width).toBe("25%");
    await running.unmount();
  });

  it("keeps a scenario the history still holds after it left the suite, and marks only a cell's own mode as red", () => {
    const extra = { ...catalog, grid: [...catalog.grid, { scenario: "goneScenario", mode: "interleave" as const, latest: { session: "s", run: null, seed: 1, passed: true, at: "2026-10-01T00:00:00.000Z" }, history: [{ session: "s", seeds: 4, failed: 0 }], gitHead: null, lastRunAt: "2026-10-01T00:00:00.000Z", newestFailure: null }] };
    expect(gridRows(extra).rows.slice(-1)[0]).toMatchObject({ name: "goneScenario", scenario: null });
    const red = catalog.scenarios.find((s) => s.name === "roleTriggerScope")!;
    expect(markersFor(red, "scripted")).toEqual([]);
    expect(markersFor(red, "interleave")).toEqual([{ task: "ct-55120", invariant: "INV-triggers", kind: "red" }]);
  });

  it("opens a cell's newest failure, and falls back to a failed latest run with a folder", () => {
    const base = { scenario: "s", mode: "interleave" as const, history: [], gitHead: null, lastRunAt: null };
    const latestFail = { session: "s2", run: "s-interleave-4", seed: 4, passed: false, at: "2026-10-02T00:00:00.000Z" };
    const newest = { session: "s1", run: "s-interleave-3", seed: 3, invariant: "INV-followers", at: "2026-10-01T00:00:00.000Z" };
    expect(cellFailure({ ...base, latest: { ...latestFail, passed: true }, newestFailure: newest })).toEqual(newest);
    expect(cellFailure({ ...base, latest: latestFail, newestFailure: null })).toEqual({ session: "s2", run: "s-interleave-4", seed: 4, invariant: null });
    expect(cellFailure({ ...base, latest: { ...latestFail, run: null }, newestFailure: null })).toBeNull();
    // The fixture world folds its history with the child's own grid.ts: the
    // newest session's interleave cell fails, and its failure names the invariant.
    expect(failingCell.newestFailure).toMatchObject({ invariant: "INV-followers", run: "memberRemovedMidTurn-interleave-3" });
    expect(catalog.caught["INV-followers"]).toBe(catalog.grid.reduce((n, c) => n + (c.scenario === "memberRemovedMidTurn" && c.mode === "interleave" ? c.history.reduce((k, h) => k + h.failed, 0) : 0), 0));
  });
});

describe("one run", () => {
  it("shows the failure card with the invariant, the window and the row diff", async () => {
    const { container, unmount } = await mount(<SimRunView data={shrunk} shrink={{ state: "idle" }} onShrink={() => {}} />);
    const card = q(container, "[data-evs-failure]")!;
    expect(card.getAttribute("data-evs-failure")).toBe("INV-followers");
    expect(card.textContent).toContain("every follower holds the host's replicated slice");
    expect(card.textContent).toContain("window laptop-follower");
    expect(qa(card, ".evs-diff tbody tr").length).toBe(3);
    await unmount();
  });

  it("draws lanes by device and window, replication arcs, bridge marks, step bands and the failure rule", async () => {
    const { container, unmount } = await mount(<SimRunView data={shrunk} shrink={{ state: "idle" }} onShrink={() => {}} />);
    const tl = q(container, "[data-evs-timeline]")!;
    expect(tl.getAttribute("data-evs-count")).toBe("35");
    const labels = qa(tl, ".evs-lane-label").map((t) => t.firstChild?.textContent);
    expect(labels.slice(0, 5)).toEqual(["laptop", "laptop-host h", "laptop-follower f", "phone", "phone-host h"]);
    expect(qa(tl, '[data-evs-mark="repl"]').length).toBe(4);
    expect(qa(tl, '[data-evs-mark="repl"] path.evs-arc').length).toBe(4);
    expect(qa(tl, '[data-evs-mark="bridge"]').length).toBe(2);
    expect(qa(tl, "[data-evs-step]").map((s) => s.getAttribute("data-evs-step"))).toEqual(["settle", "send", "remove", "close", "settle"]);
    expect(q(tl, "[data-evs-fail-rule]")!.getAttribute("data-evs-fail-rule")).toBe("34");
    // The phone closed: its lane stops with an end cap.
    expect(qa(tl, ".evs-lane-end").length).toBe(1);
    await unmount();
  });

  it("fills the scroll box the lanes are measured from, which already sits beside the gutter", async () => {
    // A 917px scroll box, as a real run page measured it. Subtracting the
    // 168px gutter again drew 749px of lanes and left the rest empty.
    const proto = dom.window.HTMLElement.prototype;
    const rect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      return this.classList.contains("evs-tape-scroll") ? ({ ...rect.call(this), width: 917, height: 300 } as DOMRect) : rect.call(this);
    };
    try {
      const { container, unmount } = await mount(<SimRunView data={shrunk} shrink={{ state: "idle" }} onShrink={() => {}} />);
      const tl = q(container, "[data-evs-timeline]")!;
      expect(q(tl, "svg.evs-lanes")!.getAttribute("width")).toBe("917");
      // Every open lane runs to the box's inner edge (917 less the 10px pad).
      expect(Math.max(...qa(tl, "line.evs-lane-line").map((l) => Number(l.getAttribute("x2"))))).toBe(907);
      await unmount();
    } finally {
      proto.getBoundingClientRect = rect;
    }
  });

  it("dims every delivery the shrink removed, in the lanes and the order strip, until the toggle is off", async () => {
    const { container, unmount } = await mount(<SimRunView data={shrunk} shrink={{ state: "idle" }} onShrink={() => {}} />);
    const removed = shrunk.minimal!.removed.length;
    expect(qa(container, ".evs-mark[data-evs-off]").length).toBe(removed);
    expect(qa(container, ".evs-ochip[data-evs-removed]").length).toBe(removed);
    expect(q(container, "[data-evs-caption]")!.textContent).toContain(`35 recorded, ${shrunk.minimal!.order.length} needed (1-minimal)`);
    await act(async () => (q(container, "[data-evs-show-kept]") as HTMLInputElement).click());
    expect(qa(container, ".evs-mark[data-evs-off]").length).toBe(0);
    // Trace, full order, minimal order, and the free sim bisect over this run's folder.
    expect(qa(container, "[data-evs-replay] code").map((c) => c.textContent)).toEqual([shrunk.replay.trace, shrunk.replay.order, shrunk.replay.minimal, shrunk.replay.bisect]);
    expect(shrunk.replay.bisect).toBe(`./evals bisect start --sim /Users/you/.local/share/codecast/sim/sessions/${shrunk.session.id}/${shrunk.run.dir}`);
    await unmount();
  });

  it("offers Shrink on an unshrunk run and shows a shrink's progress", async () => {
    let asked = 0;
    const idle = await mount(<SimRunView data={unshrunk} shrink={{ state: "idle" }} onShrink={() => asked++} />);
    expect(qa(idle.container, ".evs-ochip[data-evs-removed]").length).toBe(0);
    await act(async () => (q(idle.container, "[data-evs-shrink-button]") as HTMLButtonElement).click());
    expect(asked).toBe(1);
    await idle.unmount();
    const running = await mount(<SimRunView data={{ ...unshrunk, shrinking: { phase: "ddmin", attempts: 23, best: 14, recorded: 35 } }} shrink={{ state: "idle" }} onShrink={() => {}} />);
    expect(q(running.container, '[data-evs-shrink="running"]')!.textContent).toContain("23 attempts, shortest failing order 14 of 35");
    await running.unmount();
  });

  it("steps the playhead on the registered arrow keys, from an order chip, and plays", async () => {
    let dispatch!: ReturnType<typeof useShortcuts>["dispatchAction"];
    function Probe() {
      dispatch = useShortcuts().dispatchAction;
      return null;
    }
    const { container, unmount } = await mount(
      <ShortcutProvider>
        <Probe />
        <SimRunView data={shrunk} shrink={{ state: "idle" }} onShrink={() => {}} />
      </ShortcutProvider>,
    );
    const readout = () => q(container, "[data-evs-readout]")!.getAttribute("data-evs-readout");
    expect(readout()).toBe("34"); // opens on the failing delivery
    await act(async () => void window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", bubbles: true })));
    expect(readout()).toBe("33");
    await act(async () => void dispatch("evalsSim.first"));
    expect(readout()).toBe("0");
    await act(async () => void dispatch("evalsSim.next"));
    expect(readout()).toBe("1");
    expect(q(container, "[data-evs-playhead]")!.getAttribute("data-evs-playhead")).toBe("1");
    await act(async () => (qa(container, ".evs-ochip")[12] as HTMLButtonElement).click());
    expect(readout()).toBe("12");
    expect(q(container, "[data-evs-readout]")!.textContent).toContain("in step: send a turn on ada/s");
    await act(async () => void dispatch("evalsSim.play"));
    await act(async () => wait(PLAY_STEP_MS * 4));
    expect(Number(readout())).toBeGreaterThan(12);
    await act(async () => void dispatch("evalsSim.play"));
    await unmount();
  });
});

describe("the pages over the fixture transport", () => {
  it("loads the catalog and a run, and answers a missing run honestly", async () => {
    useEvalsStore.setState({ connection: "connected", transport: await fixtureTransport("on", { latencyMs: 0 }), resources: {} });
    const cat = await mount(<SimCatalogPage view={{ view: "sim" }} />);
    await waitFor(cat.container, "[data-evs-row]");
    expect(qa(cat.container, "[data-evs-row]").length).toBe(catalog.scenarios.length);
    // The transport's world runs on the real clock, so take the run from the link the grid drew.
    const href = q(cat.container, `[data-evs-row="${failingCell.scenario}"] a.evs-cell`)!.getAttribute("href")!;
    await cat.unmount();
    const [, , , session, runId] = href.split("/").map(decodeURIComponent);
    const run = await mount(<SimRunPage view={{ view: "sim-run", session, run: runId }} />);
    await waitFor(run.container, "[data-evs-failure]");
    expect(q(run.container, "[data-evs-failure]")?.getAttribute("data-evs-failure")).toBe("INV-followers");
    await run.unmount();
    const missing = await mount(<SimRunPage view={{ view: "sim-run", session: "nope", run: "nope" }} />);
    const end = Date.now() + 30_000;
    while (!missing.container.textContent?.includes("No such") && Date.now() < end) await act(async () => wait(25));
    expect(missing.container.textContent).toContain("No such Multiplayer sim run");
    await missing.unmount();
  }, 120_000);

  it("after a reload, shows how the newest sweep ended and the lines it printed", async () => {
    const inner = await fixtureTransport("on", { latencyMs: 0 });
    const lastSweep = { id: "sweep-1", kind: "sweep", status: "failed", session: null, run: null, tmux: null, startedAt: "2026-10-03T11:00:00.000Z", updatedAt: "2026-10-03T11:02:00.000Z", progress: { done: 0, total: null, text: "the sweep ended before its session closed" }, logTail: ["sweeping everything", "error: bun exited 1"] };
    const transport = {
      kind: "fixture" as const,
      async send(req: Parameters<typeof inner.send>[0]) {
        const res = await inner.send(req);
        return req.path === "/sim/sessions" ? { ...res, body: { ...(res.body as object), lastSweep } } : res;
      },
    };
    useEvalsStore.setState({ connection: "connected", transport, resources: {} });
    const cat = await mount(<SimCatalogPage view={{ view: "sim" }} />);
    const log = await waitFor(cat.container, "[data-evs-sweep-log]");
    expect(cat.container.textContent).toContain("The sweep failed: the sweep ended before its session closed");
    expect(log?.textContent).toContain("error: bun exited 1");
    await cat.unmount();
  }, 120_000);
});
