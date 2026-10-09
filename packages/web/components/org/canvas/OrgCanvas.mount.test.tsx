// Mounts the Org canvas in jsdom over the synthetic company, read through the
// real store hooks: the mission, the goal tiles and what serves them, a band
// per person with every role large and whole, the No lead band, ids in a
// role's latest line drawn as reference pills, the ring on the open object,
// and what a click asks the panel to open. Nothing the map drew survives:
// no "+N", no StateBar, no flag dots, no goal colours, no React Flow.
// Run: ulimit -n 10240; bun test --timeout 240000 components/org/canvas/OrgCanvas.mount.test.tsx
import { afterAll, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/org", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const scrolled: Element[] = [];
(dom.window.Element.prototype as any).scrollIntoView = function (this: Element) { scrolled.push(this); };
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/org" }));
mock.module("../../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}) }));
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));

const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { useInboxStore } = await import("../../../store/inboxStore");
const F = await import("./canvasFixture");
const { OrgCanvas } = await import("./OrgCanvas");
type PanelRef = import("../panelTarget").PanelRef;

const byId = <T extends { _id: string }>(rows: readonly T[]) => Object.fromEntries(rows.map((r) => [r._id, r]));
useInboxStore.setState({
  currentUser: { _id: F.CANVAS_ME, name: "Maya Okafor" },
  clientState: { ...useInboxStore.getState().clientState, ui: { ...useInboxStore.getState().clientState.ui, active_team_id: F.CANVAS_FIXTURE_TREE.workspace.id } },
  orgTree: F.CANVAS_FIXTURE_TREE,
  initiatives: byId(F.CANVAS_FIXTURE_GOALS),
  initiativeUpdates: byId(F.CANVAS_FIXTURE_UPDATES),
  projects: byId(F.CANVAS_FIXTURE_PROJECTS),
  plans: byId(F.CANVAS_FIXTURE_PLANS),
  tasks: byId(F.CANVAS_FIXTURE_TASKS),
} as any);

const opened: PanelRef[] = [];
const root = createRoot(document.getElementById("root")!);
const render = (openRef: PanelRef | null, waits?: React.ReactNode) =>
  act(() => { root.render(h(OrgCanvas, { openRef, onOpen: (r: PanelRef) => opened.push(r), waitingRoleIds: F.CANVAS_FIXTURE_WAITING, waits })); });
const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];
const text = () => document.getElementById("root")!.textContent ?? "";
const click = (el: Element | null) => act(() => { el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });

test("the whole company paints on one page: mission, goals, every person and role, the No lead band", async () => {
  await render(null, h("div", { "data-test-waits": "" }, "Waits on you"));
  expect(q("[data-canvas-skeleton]")).toBeNull();
  expect(q("[data-test-waits]")).not.toBeNull();
  expect(q("[data-canvas-mission]")?.textContent).toContain("Spokeworks exists to");
  expect(q("[data-canvas-mission]")?.textContent).toContain("Keep every bike in the valley on the road");
  expect(qa("[data-canvas-goal]").map((g) => g.getAttribute("data-canvas-goal"))).toEqual(["in-2", "in-3"]);
  expect(q("[data-canvas-drafts]")?.textContent).toBe("7 draft goals · open in Goals →");
  expect(q("[data-canvas-drafts]")?.getAttribute("href")).toBe("/org/goals");
  expect(qa("[data-canvas-band]").map((b) => b.querySelector(".oc-pname")?.textContent)).toEqual(["Maya Okafor", "Tomas Reyes", "Ines Park", "Dev Arora", "No lead yet"]);
  expect(qa("[data-canvas-role]")).toHaveLength(11);
  expect(q("[data-canvas-person]")?.textContent).toContain("online · 5 roles");
  expect(text()).toContain("you");
});

test("a goal tile says its health, its latest update and what serves it, with leads", () => {
  const win = q('[data-canvas-goal="in-2"]')!;
  expect(win.querySelector("[data-health]")?.textContent).toBe("At risk");
  expect(win.querySelector("[data-canvas-update]")?.textContent).toContain("two wiring problems");
  expect([...win.querySelectorAll("[data-canvas-serving]")].map((s) => s.textContent)).toEqual(["Second Workshop· Workshop lead", "Shop Partners· Shop Partners lead"]);
  const cost = q('[data-canvas-goal="in-3"]')!;
  expect(cost.querySelector("[data-health]")).toBeNull();
  expect(cost.textContent).toContain("Cheaper Tune-ups· No lead");
});

test("a role card is whole: state and age, latest line, its projects with counts and goal, its sessions", () => {
  const card = q('[data-canvas-role="or-7"]')!;
  expect(card.textContent).toContain("Workshop lead");
  expect(card.textContent).toContain("Juniper · @workshops");
  expect(card.querySelector("[data-state]")?.getAttribute("data-state")).toBe("working");
  expect(card.querySelector("[data-state]")?.textContent).toMatch(/^Working · \d+h$/);
  expect(card.querySelector(".oc-pj-count")?.textContent).toBe("38 of 90 · 3 in progress");
  expect(card.querySelector(".oc-pj-count")?.getAttribute("href")).toBe("/projects/pj-1");
  expect(card.querySelector(".oc-pj-for")?.textContent).toBe("for Open the second workshop");
  expect([...card.querySelectorAll("[data-canvas-session]")].map((s) => s.textContent)).toEqual(["Wiring quote comparisonworking", "Lease checklist reviewworking"]);
  expect(q('[data-canvas-role="or-10"]')!.textContent).toContain("Thimble · @warranty · under Repairs lead");
});

test("orange says one thing: the roles waiting on you, and nothing else", () => {
  const waiting = qa('[data-state="waiting"]').map((s) => s.closest("[data-canvas-role]")!.getAttribute("data-canvas-role"));
  expect(waiting.sort()).toEqual(["or-1", "or-10"]);
  expect(q('[data-canvas-role="or-5"] [data-state]')?.textContent).toMatch(/^Quiet · \d+h$/);
  expect(text()).not.toContain("stuck");
});

test("ids in a latest line are reference pills, never bare text", () => {
  const line = q('[data-canvas-role="or-3"] .oc-latest')!;
  const pills = [...line.querySelectorAll("a.entity-ref")];
  expect(pills.map((a) => a.getAttribute("href"))).toEqual(["/tasks/ct-9101", "/tasks/ct-9102", "/tasks/ct-9103"]);
  // Outside the pills, no id is left as words.
  const outside = line.cloneNode(true) as Element;
  outside.querySelectorAll("a.entity-ref").forEach((a) => a.remove());
  expect(outside.textContent).toBe("Fixed the mail provider outage  and restored 85 bounced addresses. The next issue goes out around 9am . A broken unsubscribe link  waits on Tomas.");
});

test("the No lead band offers to pick a lead", () => {
  const unled = qa('[data-canvas-band="unled"] .oc-card');
  expect(unled.map((c) => c.querySelector(".oc-pj-title")?.textContent)).toEqual(["Cheaper Tune-ups", "Winter Pop-up Market"]);
  expect(unled[0].textContent).toContain("No lead · Pick a lead");
  expect(unled[0].textContent).toContain("for Lower the cost of a tune-up");
});

test("a click asks the panel for the thing clicked: a role, a goal, a session, a project, a lead picker", async () => {
  opened.length = 0;
  await click(q('[data-canvas-role="or-7"]'));
  await click(q('[data-canvas-goal="in-2"]'));
  await click(q('[data-canvas-role="or-7"] [data-canvas-session]'));
  await click(q('[data-canvas-role="or-7"] .oc-pj-title'));
  await click(q('[data-canvas-band="unled"] .oc-pick'));
  await click(q('[data-canvas-person] .oc-phead-open'));
  expect(opened).toEqual([
    { kind: "role", ref: "or-7" },
    { kind: "initiative", ref: "in-2" },
    { kind: "session", id: opened[2]?.kind === "session" ? opened[2].id : "?" },
    { kind: "project", ref: "pj-1" },
    { kind: "project", ref: "pj-9", intent: "pick-lead" },
    { kind: "person", ref: F.CANVAS_ME },
  ]);
  expect((opened[2] as { id: string }).id).toMatch(/^fixture-canvas-session-/);
});

test("the open object wears the ring and is scrolled into view", async () => {
  scrolled.length = 0;
  await render({ kind: "role", ref: "or-3" });
  const ringed = qa("[data-open]");
  expect(ringed).toHaveLength(1);
  expect(ringed[0].getAttribute("data-canvas-role")).toBe("or-3");
  expect(scrolled).toEqual([ringed[0]]);
  await render({ kind: "initiative", ref: "in-2" });
  expect(qa("[data-open]").map((e) => e.getAttribute("data-canvas-goal"))).toEqual(["in-2"]);
});

test("nothing the map drew survives", () => {
  const html = document.getElementById("root")!.innerHTML;
  expect(text()).not.toMatch(/\+\d+ more/);
  expect(html).not.toMatch(/react-flow|data-state-bar|data-flag|StateBar|FlagDot/i);
  // No goal colours: a goal's link to its projects is said in words.
  expect(qa("[data-canvas-goal] [style*='background']")).toHaveLength(0);
  const dir = import.meta.dir;
  for (const f of readdirSync(dir).filter((x) => /\.(tsx?|css)$/.test(x) && !x.includes(".test."))) {
    expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/@xyflow|OrgGraph|orgZoom|StateBar|FlagDots|OverflowTally/);
  }
});

test("a cold cache shows the skeleton, never over cached rows", async () => {
  const keep = useInboxStore.getState();
  await act(() => { useInboxStore.setState({ orgTree: null, initiatives: {} } as any); });
  await render(null);
  expect(q("[data-canvas-skeleton]")).not.toBeNull();
  await act(() => { useInboxStore.setState({ orgTree: keep.orgTree, initiatives: keep.initiatives } as any); });
  expect(q("[data-canvas-skeleton]")).toBeNull();
});

test("goals cached before the tree still wait for it: no false No lead, and a deep link scrolls once the cards mount", async () => {
  const keep = useInboxStore.getState().orgTree;
  await act(() => { useInboxStore.setState({ orgTree: null } as any); });
  scrolled.length = 0;
  await render({ kind: "role", ref: "or-3" });
  expect(q("[data-canvas-skeleton]")).not.toBeNull();
  expect(text()).not.toContain("No lead");
  expect(scrolled).toEqual([]);
  await act(() => { useInboxStore.setState({ orgTree: keep } as any); });
  expect(q("[data-canvas-skeleton]")).toBeNull();
  expect(scrolled).toEqual([q('[data-canvas-role="or-3"]')!]);
  await act(() => root.unmount());
});
