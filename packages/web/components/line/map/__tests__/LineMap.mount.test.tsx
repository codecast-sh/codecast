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
  return { host, done: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
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
  expect(host.querySelector("[data-map-node='implement'] .lmap-through")?.textContent).toMatch(/^\d+ passed$/);
  const empty = [...host.querySelectorAll<HTMLElement>("[data-map-node][data-empty='true']")];
  for (const n of empty) expect(n.querySelector(".lmap-empty-word")?.textContent).toBe("empty");
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
