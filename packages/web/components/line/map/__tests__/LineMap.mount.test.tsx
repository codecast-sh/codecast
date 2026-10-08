// Mounts the line map in jsdom (line-map.md LX1 to LX3): the map draws a node
// for every node of the model and an edge for every edge, a highlighted path
// lights its nodes and dims the rest, and on the line page the URL opens a
// node's panel, an edge's panel, the line's settings panel or a trace.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line?project=pr-1", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// The same mocks the other line page tests use: bun shares mock.module across
// the files of one run, so they must agree. The search is this file's own.
let search = new URLSearchParams("project=pr-1");
const replaced: string[] = [];
mock.module("../../../../hooks/useSyncCollection", () => ({
  useSyncCollection: () => ({ ready: true }),
  useFeederError: () => {},
  entityIdArgs: () => "skip",
  applyCollectionFeed: () => {},
  keyRowsBy: (rows: any[]) => rows ?? [],
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace(to: string) { replaced.push(to); } }),
  usePathname: () => "/line",
  useSearchParams: () => search,
}));
mock.module("../../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: null }) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { LinePage } = await import("../../LinePage");
const { LineMap } = await import("../LineMap");
const { buildLineMap } = await import("../../../../lib/line/lineMap");
const { buildLineTrace, resolveTraceRef } = await import("../../../../lib/line/lineTrace");
const F = await import("../../../../lib/line/__tests__/lineFixtures");

const ME = "u1";
const WS = `user:${ME}`;
const project = { _id: "proj", short_id: "pr-1", title: "Codecast", workspace: WS };
const keyed = <T extends { _id: string }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r._id, { ...r, workspace: WS }]));

async function render(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, rerender: (next: React.ReactElement) => root.render(next), done: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

beforeEach(() => {
  replaced.length = 0;
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    clientStateInitialized: true,
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: {} },
    teams: [],
    teamMembers: [],
    projects: { proj: project },
    tasks: keyed(F.rows.tasks as any),
    signals: keyed(F.rows.signals as any),
    workflowRuns: keyed(F.rows.runs as any),
    sessionDecisions: {},
  } as any);
});

const fixtureMap = () => buildLineMap({ ...F.rows, finders: F.finders, now: F.NOW, windowMs: 7 * F.DAY });

test("the map draws every node and edge of the model, wider where more crossed, with marks in words", async () => {
  const map = fixtureMap();
  const { host, done } = await render(React.createElement(LineMap, { map }));
  const nodes = [...host.querySelectorAll<HTMLElement>("[data-map-node]")].map((n) => n.dataset.mapNode);
  expect(nodes.sort()).toEqual(map.nodes.map((n) => n.id).sort());
  expect(host.querySelectorAll("[data-map-edge]").length).toBe(map.edges.length);
  const width = (id: string) => parseFloat((host.querySelector(`[data-map-edge="${id}"] .lmap-edge-line`) as SVGElement).style.strokeWidth);
  expect(width("signals->causes")).toBeGreaterThan(width("causes->ground"));
  expect(host.querySelector("[data-map-edge='ground->park']")?.getAttribute("data-empty")).toBe("true");
  expect(host.querySelector("[data-map-mark='implement']")?.textContent).toContain("past three times the usual");
  // A node says what is here now (the big number) and what passed, in words; an empty node says empty.
  expect(host.querySelector("[data-map-node='implement'] .lmap-here")?.textContent).toBe("1");
  expect(host.querySelector("[data-map-node='implement'] .lmap-through")?.textContent).toMatch(/^\d+ runs?$/);
  const empty = [...host.querySelectorAll<HTMLElement>("[data-map-node][data-empty='true']")];
  // An end is a terminal: it has had none yet, not an empty box.
  for (const n of empty) expect(n.querySelector(".lmap-empty-word")?.textContent).toBe(n.dataset.kind === "end" ? "none yet" : "empty");
  expect(host.querySelector("[data-map-node='implement']")?.getAttribute("data-tone")).toBe("warn");
  await done();
});

test("a highlighted path lights its nodes and edges, counts a loop's visits, and dims the rest", async () => {
  const map = fixtureMap();
  const rows = { ...F.rows, tasks: F.rows.tasks as any };
  const trace = buildLineTrace(resolveTraceRef("ct-101", rows)!, rows, { now: F.NOW });
  const { host, done } = await render(React.createElement(LineMap, { map, highlightPath: trace.pathNodeIds }));
  expect(host.querySelector("[data-line-map]")?.getAttribute("data-tracing")).toBe("true");
  const on = (id: string) => host.querySelector(`[data-map-node="${id}"]`)?.getAttribute("data-on");
  expect(on("implement")).toBe("true");
  expect(on("end:held")).toBe("true");
  expect(on("dissolve")).toBeNull();
  expect(host.querySelector("[data-map-node='implement'] .lmap-visits")?.textContent).toBe("x2");
  expect(host.querySelector("[data-map-edge='decide->reopen']")?.getAttribute("data-on")).toBe("true");
  expect(host.querySelector("[data-map-edge='prove->dissolve']")?.getAttribute("data-on")).toBeNull();
  await done();
});

test("the line page draws the project's map; ?node opens that node's panel with what is there now", async () => {
  search = new URLSearchParams("project=pr-1&window=30d&node=implement");
  const { host, done } = await render(React.createElement(LinePage));
  expect(host.querySelector("[data-line-map]")).not.toBeNull();
  expect(host.querySelector("[data-map-window='30d']")?.getAttribute("aria-pressed")).toBe("true");
  const panel = host.querySelector("[data-map-panel='implement']")!;
  expect(panel).not.toBeNull();
  expect(host.querySelector("[data-map-node='implement']")?.getAttribute("data-selected")).toBe("true");
  const now = panel.querySelector("[data-map-section='now']")!;
  expect(now.textContent).toContain("Call summary drops the action items");
  expect(now.querySelector("a[data-map-trace-link]")?.getAttribute("href")).toBe("/line/trace/run_c");
  expect([...panel.querySelectorAll("[data-map-section]")].map((s) => (s as HTMLElement).dataset.mapSection)).toEqual(["now", "through", "health", "definition"]);
  // The station's own prompt sits in Definition; asking for a change is pinned to the footer and opens the composer for the node.
  expect(panel.querySelector("[data-station-definition='implement']")).not.toBeNull();
  // Under it, the station's own version history (LX3).
  expect(panel.querySelector("[data-station-history]")).not.toBeNull();
  const ask = panel.querySelector<HTMLElement>("[data-map-ask-open]")!;
  expect(ask.textContent).toContain("Ask for a change to");
  await act(async () => { ask.click(); });
  expect(panel.querySelector("[data-change-composer]")?.getAttribute("data-change-composer")).toBe("line:station:implement");
  await done();
});

test("Esc closes the panel; a click on a node opens it; an item click traces it", async () => {
  search = new URLSearchParams("project=pr-1&window=30d&node=implement");
  const { host, done } = await render(React.createElement(LinePage));
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })); });
  expect(replaced.at(-1)).toBe("/line?project=pr-1&window=30d");
  await act(async () => { (host.querySelector("[data-map-node='prove']") as HTMLElement).click(); });
  expect(replaced.at(-1)).toBe("/line?project=pr-1&window=30d&node=prove");
  await act(async () => { (host.querySelector("[data-map-panel='implement'] [data-map-item]") as HTMLElement).click(); });
  expect(replaced.at(-1)).toContain("trace=run_c");
  await done();
});

test("?edge opens what crossed it; ?trace lights the path; ?node=line opens the line's settings in place", async () => {
  search = new URLSearchParams("project=pr-1&window=30d&edge=signals->causes");
  let m = await render(React.createElement(LinePage));
  const edge = m.host.querySelector("[data-map-panel='signals->causes']")!;
  expect(edge.querySelectorAll("[data-map-item]").length).toBeGreaterThan(0);
  await m.done();

  search = new URLSearchParams("project=pr-1&window=30d&trace=ct-101");
  m = await render(React.createElement(LinePage));
  expect(m.host.querySelector("[data-line-map]")?.getAttribute("data-tracing")).toBe("true");
  expect(m.host.querySelector("[data-map-trace]")?.textContent).toContain("Broker replies skip the question asked");
  await m.done();

  search = new URLSearchParams("project=pr-1&node=line&section=limits");
  m = await render(React.createElement(LinePage));
  const settings = m.host.querySelector("[data-map-panel='line'] [data-line-settings]");
  expect(settings).not.toBeNull();
  // Embedded, the settings drop their own header and way back: the map holds both.
  expect(settings?.querySelector("[data-lset-back]")).toBeNull();
  await m.done();
});

test("the evals source's panel opens the surface its newest signal names", async () => {
  const at = Date.now() - 3_600_000;
  useInboxStore.setState({
    signals: { ...keyed(F.rows.signals as any), ev: { _id: "ev", short_id: "sg-ev", source: "evals", kind: "regression", title: "settle fell", subject: "settle", observed_at: at, created_at: at, task_id: "task_e", project_id: "proj", workspace: WS } },
  } as any);
  search = new URLSearchParams("project=pr-1&node=source:evals");
  const { host, done } = await render(React.createElement(LinePage));
  expect(host.querySelector("[data-map-evals-link]")?.getAttribute("href")).toBe("/evals/s/settle");
  await done();
});

// With a panel open the map column narrows; the map pans so the open node and
// one neighbor on each side show whole, and a node in the first two columns
// keeps the first column past the 24px left gutter (LX3). jsdom has no layout,
// so the scroller's width is given and its scrollTo recorded.
test("a panel open keeps the first column past the gutter and the open node's neighbors whole", async () => {
  const proto = dom.window.HTMLElement.prototype as any;
  const own = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  const scrollTo = proto.scrollTo;
  let width = 720;
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return this.classList?.contains("lmap-scroll") ? width : 0; } });
  proto.scrollTo = function (o: { left?: number }) { if (this.classList?.contains("lmap-scroll") && o?.left != null) this.dataset.left = String(o.left); };
  try {
    const box = (host: HTMLElement, id: string) => {
      const n = host.querySelector<HTMLElement>(`[data-map-node="${id}"]`)!;
      const zoom = Number(host.querySelector<HTMLElement>(".lmap-canvas")!.dataset.zoom ?? 1);
      const sl = Number(host.querySelector<HTMLElement>(".lmap-scroll")!.dataset.left ?? 0);
      const l = parseFloat(n.style.left) * zoom - sl;
      return { l, r: l + parseFloat(n.style.width) * zoom };
    };
    const firstSource = (host: HTMLElement) => box(host, host.querySelector<HTMLElement>("[data-map-node][data-kind='source']")!.dataset.mapNode!);
    const firstColumn = (host: HTMLElement) => {
      const nodes = [...host.querySelectorAll<HTMLElement>("[data-map-node]")];
      const minX = Math.min(...nodes.map((n) => parseFloat(n.style.left)));
      return box(host, nodes.find((n) => parseFloat(n.style.left) === minX)!.dataset.mapNode!);
    };

    for (const node of ["causes", "signals"]) {
      search = new URLSearchParams(`project=pr-1&window=30d&node=${node}`);
      const m = await render(React.createElement(LinePage));
      expect(m.host.querySelector(".lmap-canvas")?.getAttribute("data-zoom")).toBe("0.85");
      expect(firstColumn(m.host).l).toBeGreaterThanOrEqual(24);
      expect(box(m.host, "ground").r).toBeLessThanOrEqual(width);
      await m.done();
    }

    // Causes fits from the map's start but Ground would sit under the panel:
    // the sources win, so the reader sees what feeds the queue (LX3).
    width = 600;
    search = new URLSearchParams("project=pr-1&window=30d&node=causes");
    let m = await render(React.createElement(LinePage));
    expect(firstColumn(m.host).l).toBeGreaterThanOrEqual(24);
    expect(firstSource(m.host).l).toBeGreaterThanOrEqual(24);
    expect(box(m.host, "causes").r).toBeLessThanOrEqual(width);
    await m.done();

    // Too narrow for Causes from the start: Signals and Ground show whole.
    width = 420;
    m = await render(React.createElement(LinePage));
    expect(box(m.host, "signals").l).toBeGreaterThanOrEqual(0);
    expect(box(m.host, "ground").r).toBeLessThanOrEqual(width);
    await m.done();

    // The map opened scrolled to a station further on; a click opens Causes,
    // and the first column and source pill come back to the gutter (round 7).
    width = 600;
    search = new URLSearchParams("project=pr-1&window=30d");
    m = await render(React.createElement(LinePage));
    const scroller = m.host.querySelector<HTMLElement>(".lmap-scroll")!;
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => Number(scroller.dataset.left ?? 0) });
    scroller.dataset.left = "298";
    await act(async () => { m.host.querySelector<HTMLElement>("[data-map-node='causes']")!.click(); });
    search = new URLSearchParams(replaced.at(-1)!.split("?")[1]);
    await act(async () => { m.rerender(React.createElement(LinePage)); });
    expect(search.get("node")).toBe("causes");
    expect(scroller.dataset.left).toBe("0");
    expect(firstColumn(m.host).l).toBeGreaterThanOrEqual(24);
    expect(firstSource(m.host).l).toBeGreaterThanOrEqual(24);
    await m.done();
  } finally {
    if (own) Object.defineProperty(proto, "clientWidth", own); else delete proto.clientWidth;
    proto.scrollTo = scrollTo;
  }
});

test("Causes says why nothing starts, first in Health and under the node, with the switch and slots right there (LE6)", async () => {
  const role = { _id: "role1", short_id: "rl-1", handle: "aq-line", name: "AQ line", status: "active", trust: "understand", scope: { project_ids: ["proj"], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, host_user_id: ME, scope_type: "user", caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000, cards: 2 } };
  const calls: any[] = [];
  const realUpdate = useInboxStore.getState().updateOrgRole;
  useInboxStore.setState({
    orgTree: { workspace: { kind: "user", id: ME, name: "Me" }, roles: [role], anchors: [], people: [], generated_at: 0 },
    updateOrgRole: (id: string, fields: any) => { calls.push([id, fields]); useInboxStore.setState((st: any) => ({ orgTree: { ...st.orgTree, roles: st.orgTree.roles.map((r: any) => (r._id === id ? { ...r, ...fields } : r)) } })); },
  } as any);
  search = new URLSearchParams("project=pr-1&window=30d&node=causes");
  const { host, done } = await render(React.createElement(LinePage));
  const panel = host.querySelector("[data-map-panel='causes']")!;
  expect(panel.querySelector("[data-map-health] p")?.textContent).toBe("Admission is off for @aq-line, so nothing starts on its own.");
  expect(host.querySelector("[data-map-mark='causes']")?.textContent).toContain("Admission off");
  expect(host.querySelector("[data-line-headline]")?.textContent).toContain("admission is off for @aq-line");
  const row = panel.querySelector<HTMLElement>("[data-map-admission]")!;
  expect(row.dataset.mapAdmission).toBe("off");
  await act(async () => { row.querySelector<HTMLElement>("[data-map-admission-switch]")!.click(); });
  expect(calls[0]).toEqual(["role1", { trust: "direct" }]);
  // On, at the role's own 2 slots, and the queue no longer says it is held.
  expect(panel.querySelector("[data-map-admission]")?.getAttribute("data-map-admission")).toBe("on");
  expect(panel.querySelector("[data-map-admission-slots]")?.textContent).toBe("2");
  expect(panel.querySelector("[data-map-health] p")?.textContent).not.toContain("Admission is off");
  useInboxStore.setState({ orgTree: null, updateOrgRole: realUpdate } as any);
  await done();
});

test("a trailing machine number leaves a row's title, so rows it alone told apart merge", async () => {
  const { plainTitle } = await import("../LineMapPanel");
  expect(plainTitle("e2e keyless sink error 1791140327")).toBe("e2e keyless sink error");
  expect(plainTitle("e2e FinalCheckError timeline link 1791111060000")).toBe("e2e FinalCheckError timeline link");
  // A short number is part of the words, and a title that is only a number stays.
  expect(plainTitle("Twilio error 31009")).toBe("Twilio error 31009");
  expect(plainTitle("1791140327")).toBe("1791140327");
});

// A body too short to scroll sits at its end from the first paint; that is not
// the viewer scrolling to the last section, so the first tab stays lit (round 9).
test("a panel with short content opens with its first tab active", async () => {
  search = new URLSearchParams("project=pr-1&window=30d&node=source:ci");
  const { host, done } = await render(React.createElement(LinePage));
  const panel = host.querySelector("[data-map-panel='source:ci']");
  const tabs = [...panel!.querySelectorAll<HTMLElement>("[data-map-nav]")];
  expect(tabs.length).toBeGreaterThan(1);
  expect(tabs[0].getAttribute("aria-current")).toBe("true");
  expect(tabs.slice(1).every((t) => t.getAttribute("aria-current") == null)).toBe(true);
  await done();
});

test("a title cut to almost nothing reads as its kind and source; a test prefix leaves the words", async () => {
  const { rowTitle } = await import("../LineMapPanel");
  const sig = (title: string) => ({ title, kind: "signal" as const, source: "sdk:e2e-sdk", signalKind: "bug" });
  expect(rowTitle(sig('e2e InjectionError: "'), true)).toBe("InjectionError from sdk:e2e-sdk");
  expect(rowTitle(sig("[test] checkout total off by one"), true)).toBe("checkout total off by one");
  expect(rowTitle(sig('"'))).toBe("bug from sdk:e2e-sdk");
  expect(rowTitle(sig("Intro email skips the ask"))).toBe("Intro email skips the ask");
});

// Test runs' signals fold into a closed group after the real causes (round 9).
test("Through on Causes folds test signals under a closed group, real causes first", async () => {
  const at = F.NOW - 3_600_000;
  const extra = Object.fromEntries(["e2e keyless sink error", "[test] probe fired", "e2e InjectionError: \""].map((title, i) => [`t${i}`, { _id: `t${i}`, short_id: `sg-t${i}`, source: "sdk:e2e-sdk", kind: "bug", title, observed_at: at, created_at: at - i, task_id: "task_e", project_id: "proj", workspace: WS }]));
  useInboxStore.setState({ signals: { ...keyed(F.rows.signals as any), ...extra } } as any);
  search = new URLSearchParams("project=pr-1&window=30d&node=causes");
  const { host, done } = await render(React.createElement(LinePage));
  const through = host.querySelector("[data-map-panel='causes'] [data-map-section='through']")!;
  const toggle = through.querySelector<HTMLElement>("[data-map-items-tests]");
  expect(toggle?.dataset.mapItemsTests).toBe("3");
  const titles = () => [...through.querySelectorAll(".lmap-item-title")].map((t) => t.textContent ?? "");
  expect(titles().some((t) => /e2e|\[test\]|InjectionError/.test(t))).toBe(false);
  await act(async () => { toggle!.click(); });
  expect(titles()).toContain("InjectionError from sdk:e2e-sdk");
  expect(titles()).toContain("probe fired");
  await done();
});

// Round 10: with Causes open in a column too narrow for it at the panel's
// scale, the map steps back a little further instead of panning the sources
// off screen: the scroll stays at its start and the first source pill keeps
// the 24px gutter (LX3).
test("a panel on Causes keeps the sources at the gutter, stepping the map back to fit", async () => {
  const proto = dom.window.HTMLElement.prototype as any;
  const own = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  const scrollTo = proto.scrollTo;
  let width = 2000;
  const ownLeft = Object.getOwnPropertyDescriptor(proto, "scrollLeft");
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return this.classList?.contains("lmap-scroll") ? width : 0; } });
  // The scroller reports where the last scrollTo put it, as a browser would.
  Object.defineProperty(proto, "scrollLeft", { configurable: true, get() { return Number(this.dataset?.left ?? 0); }, set() {} });
  proto.scrollTo = function (o: { left?: number }) { if (this.classList?.contains("lmap-scroll") && o?.left != null) this.dataset.left = String(o.left); };
  try {
    search = new URLSearchParams("project=pr-1&window=30d&node=causes");
    let m = await render(React.createElement(LinePage));
    const causes = m.host.querySelector<HTMLElement>("[data-map-node='causes']")!;
    const right = parseFloat(causes.style.left) + parseFloat(causes.style.width);
    await m.done();
    // Causes fits whole only below the panel's 0.85.
    width = Math.round(right * 0.78) + 48;
    m = await render(React.createElement(LinePage));
    const zoom = Number(m.host.querySelector<HTMLElement>(".lmap-canvas")!.dataset.zoom);
    expect(zoom).toBeLessThan(0.85);
    expect(zoom).toBeGreaterThanOrEqual(0.7);
    expect(Number(m.host.querySelector<HTMLElement>(".lmap-scroll")!.dataset.left ?? 0)).toBe(0);
    const pill = m.host.querySelector<HTMLElement>("[data-map-node][data-kind='source']")!;
    expect(parseFloat(pill.style.left) * zoom).toBeGreaterThanOrEqual(24);
    const c = m.host.querySelector<HTMLElement>("[data-map-node='causes']")!;
    expect((parseFloat(c.style.left) + parseFloat(c.style.width)) * zoom).toBeLessThanOrEqual(width);
    await m.done();
  } finally {
    if (own) Object.defineProperty(proto, "clientWidth", own); else delete proto.clientWidth;
    if (ownLeft) Object.defineProperty(proto, "scrollLeft", ownLeft); else delete proto.scrollLeft;
    proto.scrollTo = scrollTo;
  }
});

// Reported in rounds 8, 9 and 10: a tab click jumps the body to its section
// at once (behavior "auto", never smooth, which stalls in a background tab)
// and lights that tab.
test("a panel tab jumps the body to its section at once and lights the tab", async () => {
  search = new URLSearchParams("project=pr-1&window=30d&node=causes");
  const { host, done } = await render(React.createElement(LinePage));
  const panel = host.querySelector<HTMLElement>("[data-map-panel='causes']")!;
  const body = panel.querySelector<HTMLElement>(".lmap-panel-body")!;
  let scrollTop = 0;
  const calls: Array<{ top?: number; behavior?: string }> = [];
  Object.defineProperty(body, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; } });
  Object.defineProperty(body, "clientHeight", { configurable: true, get: () => 300 });
  Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => 2000 });
  body.getBoundingClientRect = () => ({ top: 100, bottom: 400, left: 0, right: 400, width: 400, height: 300, x: 0, y: 100, toJSON() {} }) as DOMRect;
  // Each section sits 500px under the one before, in the body's scrolled content.
  const ids = ["now", "through", "health", "definition"];
  for (const [i, id] of ids.entries()) {
    const sec = body.querySelector<HTMLElement>(`#lmap-${id}`)!;
    sec.getBoundingClientRect = () => ({ top: 100 + i * 500 - scrollTop, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  }
  body.scrollTo = ((o: { top?: number; behavior?: ScrollBehavior }) => { calls.push(o); if (o.top != null) scrollTop = o.top; }) as any;
  const tab = panel.querySelector<HTMLElement>("[data-map-nav='health']")!;
  await act(async () => { tab.click(); });
  expect(calls).toEqual([{ top: 996, behavior: "auto" }]);
  expect(scrollTop).toBe(996);
  expect(tab.getAttribute("aria-current")).toBe("true");
  expect(panel.querySelector("[data-map-nav='now']")?.getAttribute("aria-current")).toBeNull();
  // The scroll event the jump fires keeps the picked tab lit.
  await act(async () => { body.dispatchEvent(new dom.window.Event("scroll")); });
  expect(tab.getAttribute("aria-current")).toBe("true");
  await done();
});

// Round 10: admission on, slots free, causes ready long ago and nothing
// started: Health leads with that, the node's mark says it short, and the
// top cause starts by hand through the store's start (startLineCause).
test("Causes names a stalled sweep in Health and under the node, and starts the top cause by hand", async () => {
  const role = { _id: "role1", short_id: "rl-1", handle: "aq-line", name: "AQ line", status: "active", trust: "direct", scope: { project_ids: ["proj"], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, host_user_id: ME, scope_type: "user", caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000, cards: 2 } };
  const started: string[] = [];
  const realStart = useInboxStore.getState().startLineCause;
  useInboxStore.setState({
    orgTree: { workspace: { kind: "user", id: ME, name: "Me" }, roles: [role], anchors: [], people: [], generated_at: 0 },
    startLineCause: async (id: string) => { started.push(id); return null; },
  } as any);
  search = new URLSearchParams("project=pr-1&window=30d&node=causes");
  const { host, done } = await render(React.createElement(LinePage));
  const panel = host.querySelector("[data-map-panel='causes']")!;
  expect(panel.querySelector("[data-map-health] p")?.textContent).toMatch(/^Admission is on with a free slot and \d+ causes? ready, but nothing has started in \w+\. The sweep that starts the top one every two minutes is not running; start it by hand\.$/);
  expect(host.querySelector("[data-map-mark='causes']")?.textContent).toMatch(/^No start in \w+/);
  expect(panel.querySelector("[data-map-admission] [role='status']")?.textContent).toMatch(/^No start in/);
  const start = panel.querySelector<HTMLElement>("[data-map-start-top-button]")!;
  await act(async () => { start.click(); });
  // The queue's top, as Now and the panel rank it.
  expect(started).toEqual(["task_f"]);
  expect(start.textContent).toBe("Starting the top cause");
  useInboxStore.setState({ orgTree: null, startLineCause: realStart } as any);
  await done();
});
