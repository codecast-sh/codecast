// The map (docs/architecture/org-staffing.md S40) mounted over the Union
// fixture: what it hands the canvas for each filter and overlay, and how a
// card hovered in the conversation reaches it. React Flow is mocked (it draws
// nothing without a measured viewport); the layout it would draw is covered
// by goalsLayout.test.ts, the cards by GoalsLens.mount.test.tsx.
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "DOMMatrixReadOnly"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
const { act } = React;

const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}) }));
const realHealth = { ...(await import("../../hooks/useSyncOrgHealth")) };
const healthAsks: boolean[] = [];
mock.module("../../hooks/useSyncOrgHealth", () => ({ ...realHealth, useSyncOrgHealth: (on: boolean) => { healthAsks.push(on); return { health: null, ready: true, missing: false, refresh: async () => {} }; } }));
const graphProps: any[] = [];
mock.module("./OrgGraph", () => ({ OrgGraph: (props: any) => { graphProps.push(props); return h("div", { "data-graph-lens": props.lens, "data-graph-changes": props.changes?.length ?? 0 }); } }));

const { createRoot } = await import("react-dom/client");
const { UNION_GOALS_CHANGES, UNION_GOALS_DATA, UNION_GOALS_TREE } = await import("./goalsFixture");
const { OrgMap } = await import("./OrgMap");

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const last = () => graphProps.at(-1)!;

test("each filter is one lens on the same tree, read only, with no session stacks; the overlay hands the canvas the proposal's changes", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const picked: string[] = [], overlay: boolean[] = [];
  const render = (filter: "everything" | "goals" | "people", asProposed: boolean) => act(async () => {
    root.render(h(OrgMap, { tree: UNION_GOALS_TREE, goals: UNION_GOALS_DATA, proposal: { changes: UNION_GOALS_CHANGES }, filter, onFilter: (f: string) => picked.push(f), asProposed, onAsProposed: (on: boolean) => overlay.push(on) }));
  });
  await render("everything", true);
  expect(last().lens).toBe("everything");
  expect(last().changes.length).toBe(UNION_GOALS_CHANGES.length);
  expect(last().view.sessionCards).toBe(false);
  expect(last().canDrag({ kind: "role" })).toBe(false);
  expect(q("[data-org-map='everything'][data-org-map-proposed='on']", el)).not.toBeNull();
  // The overlay off: the company as it is.
  await render("everything", false);
  expect(last().changes).toBeUndefined();
  expect(q("[data-org-map-proposed='off']", el)).not.toBeNull();
  // The filter is the company pane's: the map draws no chips of its own. Its
  // corner keeps the overlay toggle, which reports to the page.
  expect(q("[data-map-filter-pick]", el)).toBeNull();
  expect(picked).toEqual([]);
  await act(async () => { q("[data-map-proposed]", el)!.click(); });
  expect(overlay).toEqual([true]);
  await render("goals", true);
  expect(last().lens).toBe("goals");
  expect(last().dimGoals).toBe(false);
  // Projects: the goals outline, its goals stepped back so the projects lead.
  await render("projects" as any, true);
  expect(last().lens).toBe("goals");
  expect(last().dimGoals).toBe(true);
  await render("people", true);
  expect(last().lens).toBe("people");
  // Only the People filter asks for org.health, and only when the page gave none.
  expect(healthAsks.at(-1)).toBe(true);
  expect(healthAsks.filter(Boolean).length).toBe(1);
  await act(async () => { root.unmount(); });
  el.remove();
});

test("a card hovered in the conversation lights its change and pans only when off screen; a link pans always; the last ask wins", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = (highlightChangeId: string | null, focusTarget: any = null) => act(async () => {
    root.render(h(OrgMap, { tree: UNION_GOALS_TREE, goals: UNION_GOALS_DATA, proposal: { changes: UNION_GOALS_CHANGES }, filter: "everything", onFilter() {}, asProposed: true, onAsProposed() {}, highlightChangeId, focusTarget }));
  });
  await render(null);
  expect(last().focusTarget).toBeNull();
  await render("union-funnel");
  expect(last().focusTarget).toMatchObject({ kind: "change", id: "union-funnel", ifHidden: true });
  expect(last().focusChangeId).toBe("union-funnel");
  // The same hover re-rendered is the same ask.
  const hover = last().focusTarget;
  await render("union-funnel");
  expect(last().focusTarget).toBe(hover);
  // A link lands over a hover.
  const link = { kind: "change", id: "union-cost", seq: 99 };
  await render("union-funnel", link);
  expect(last().focusTarget).toBe(link);
  // A hover ending asks for nothing: the old link does not pull the map back.
  await render(null, link);
  expect(last().focusTarget).toBeNull();
  // A new hover after the link wins; the lit change follows the hover.
  await render("union-revenue", link);
  expect(last().focusTarget).toMatchObject({ id: "union-revenue", ifHidden: true });
  expect(last().focusChangeId).toBe("union-revenue");
  await act(async () => { root.unmount(); });
  el.remove();
});

test("no tree yet draws the placeholder and no toolbar chip decides anything", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(OrgMap, { tree: null, filter: "everything", onFilter() {}, asProposed: false, onAsProposed() {} })); });
  expect(q("[data-map-loading]", el)!.textContent).toBe("The map appears here when it is ready.");
  // No proposal: no overlay toggle to press.
  expect(q("[data-map-proposed]", el)).toBeNull();
  expect(q("[data-ghost-actions]", el)).toBeNull();
  await act(async () => { root.unmount(); });
  el.remove();
});

test("the open sheet's object is ringed and kept clear of the sheet; a click on a card opens its object", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const opened: unknown[] = [], changes: string[] = [], talks: unknown[] = [];
  const ring = { kind: "project", id: "p-1" };
  await act(async () => {
    root.render(h(OrgMap, { tree: UNION_GOALS_TREE, goals: UNION_GOALS_DATA, filter: "everything", asProposed: false, onAsProposed() {}, ring, panelWidth: 560, onOpenObject: (o: unknown) => opened.push(o), onOpenChange: (id: string) => changes.push(id), onTalk: (o: unknown) => talks.push(o) }));
  });
  expect(last().ring).toBe(ring);
  expect(last().panelWidth).toBe(560);
  // The canvas reports its gestures; the map hands them through untouched.
  last().onOpenObject({ kind: "initiative", id: "g-1" });
  last().onOpenChange("c-1");
  last().onTalk({ kind: "role", id: "r-1" });
  expect(opened).toEqual([{ kind: "initiative", id: "g-1" }]);
  expect(changes).toEqual(["c-1"]);
  expect(talks).toEqual([{ kind: "role", id: "r-1" }]);
  // A person card double clicked in the goals lens opens their sheet too.
  last().onOpenInPeople("person:u-1");
  expect(opened.at(-1)).toEqual({ kind: "person", id: "u-1" });
  await act(async () => { root.unmount(); });
  el.remove();
});

test("This week (D12): on People each role card carries its week and the lines the work flowing down them; the open role's lines stay lit; any other filter draws no week", async () => {
  const { ORG_STAFFING_FIXTURE_HEALTH } = await import("./orgStaffingFixture");
  const { ORG_FIXTURE_WITH_HEAD } = await import("./orgFixture");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const role = ORG_FIXTURE_WITH_HEAD.roles[0];
  const render = (filter: "people" | "goals", week: boolean, ring: any = null) => act(async () => {
    root.render(h(OrgMap, { tree: ORG_FIXTURE_WITH_HEAD, health: ORG_STAFFING_FIXTURE_HEALTH, filter, asProposed: false, onAsProposed: () => {}, week, ring }));
  });
  await render("people", false);
  expect(last().flow).toBeUndefined();
  expect(last().view.structureOnly).toBeFalsy();
  expect(q("[data-org-map-week]", el)).toBeNull();
  await render("people", true);
  const flow = last().flow;
  expect(flow).toBeDefined();
  // The week is the reporting structure alone: every role card is its week.
  expect(last().view.structureOnly).toBe(true);
  expect(Object.keys(flow.roles).length).toBe(ORG_FIXTURE_WITH_HEAD.roles.filter((r) => r.status !== "retired").length);
  for (const f of Object.values(flow.roles) as any[]) expect(typeof f.wakesTotal === "number" && typeof f.doneTotal === "number").toBe(true);
  expect(flow.days.length).toBe(7);
  expect(flow.focusNodeId).toBeNull();
  expect(q("[data-org-map-week='on']", el)).not.toBeNull();
  // A role's sheet open over the map keeps its lines lit.
  await render("people", true, { kind: "role", id: role._id });
  expect(last().flow.focusNodeId).toBe(`role:${role._id}`);
  // The week is People's: another filter with the flag set draws none.
  await render("goals", true);
  expect(last().flow).toBeUndefined();
  expect(q("[data-org-map-week]", el)).toBeNull();
  await act(async () => { root.unmount(); });
  el.remove();
});

test("the page's People controls drive the People filter only, and step aside for This week", async () => {
  const { ORG_FIXTURE } = await import("./orgFixture");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const view = { collapsed: new Set<string>(), expanded: {}, sessionCards: true };
  const toggled: string[] = [];
  const people = { view, loadingClusters: new Set(["person:x"]), onToggleCollapse: (id: string) => toggled.push(id), onExpandCluster() {}, onCollapseCluster() {}, onReparentRequest() {}, onNodeContextMenu() {}, canDrag: () => true, resetKey: 3 };
  const render = (filter: "people" | "everything", week = false) => act(async () => {
    root.render(h(OrgMap, { tree: ORG_FIXTURE, health: null, filter, asProposed: false, onAsProposed() {}, people, week }));
  });
  await render("people");
  expect(last().view).toBe(view);
  expect(last().loadingClusters.has("person:x")).toBe(true);
  expect(last().canDrag({ kind: "role" })).toBe(true);
  expect(last().resetKey).toBe(3);
  last().onToggleCollapse("person:y");
  expect(toggled).toEqual(["person:y"]);
  // Another filter keeps the still picture: no stacks, nothing picked up.
  await render("everything");
  expect(last().view.sessionCards).toBe(false);
  expect(last().canDrag({ kind: "role" })).toBe(false);
  // This week draws the structure alone.
  await render("people", true);
  expect(last().view.structureOnly).toBe(true);
  expect(last().canDrag({ kind: "role" })).toBe(false);
  await act(async () => { root.unmount(); });
  el.remove();
});
