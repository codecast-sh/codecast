// Mounts the Goals lens in jsdom (org-staffing.md S36): the goal, project
// and owner cards wearing a proposal's ghost chrome, the header chip reaching
// the stage's split opener with the org screen's address, and the map
// lighting the change a card points at.
// Run: bun test --timeout 120000 components/org/GoalsLens.mount.test.tsx
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

// The pane's address: the test moves it the way the stage would.
let search = "";
const replaced: string[] = [];
const router = { push() {}, replace(path: string) { replaced.push(path); } };
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams(search), usePathname: () => "/org" }));
mock.module("../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));
const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}) }));
const noThrow = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));
const { useInboxStore } = await import("../../store/inboxStore");
const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
mock.module("../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposal: (ref: string | null) => ({ ready: !!ref, missing: false }), useSyncOrgProposals: () => ({ ready: true, missing: false }) }));
// org.health is an action the pane asks for on the people lens; the test feeds none.
const realHealth = { ...(await import("../../hooks/useSyncOrgHealth")) };
mock.module("../../hooks/useSyncOrgHealth", () => ({ ...realHealth, useSyncOrgHealth: () => ({ health: null, ready: true, missing: false, refresh: async () => {} }) }));
const realTree = { ...(await import("../../hooks/useSyncOrgTree")) };
mock.module("../../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTree: () => ({ tree: useInboxStore((s) => s.orgTree), ready: true, missing: false, refused: false, retry() {} }), useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry() {} }) }));
// The canvas is React Flow, which draws nothing without a measured viewport:
// the pane's own test reads what it hands the canvas.
const graphProps: any[] = [];
mock.module("./OrgGraph", () => ({ OrgGraph: (props: any) => { graphProps.push(props); return h("div", { "data-graph-lens": props.lens, "data-graph-changes": props.changes?.length ?? 0, "data-graph-focus": props.focusTarget ? `${props.focusTarget.kind}:${props.focusTarget.id}` : "" }); } }));

const { createRoot } = await import("react-dom/client");
const { ReactFlowProvider } = await import("@xyflow/react");
const { ORG_FIXTURE } = await import("./orgFixture");
const { GOALS_FIXTURE_CHANGES, GOALS_FIXTURE_DATA, ORG_GOALS_FIXTURE_PROPOSAL } = await import("./goalsFixture");
const { goalNodeId, layoutGoals, projectNodeId } = await import("./goalsLayout");
const { roleNodeId, personNodeId } = await import("./orgLayout");
const { GoalCard, GoalOwnerCard, GoalProjectCard, CompanyCard } = await import("./GoalsNodeCards");
const { OrgChartChip } = await import("./orgChartLink");
const { registerSplitOpener } = await import("../../lib/openIntent");

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("goal, project and owner cards wear the proposal's ghost chrome", async () => {
  const layout = layoutGoals({ tree: ORG_FIXTURE, ...GOALS_FIXTURE_DATA, changes: GOALS_FIXTURE_CHANGES });
  const node = (id: string) => layout.nodes.find((n) => n.id === id) as any;
  const focused: string[] = [];
  const card = (Comp: any, n: any, data: any) => h("div", { "data-card": n.id, key: n.id }, h(Comp, { id: n.id, type: n.kind, selected: false, dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0, data }));
  const goal = (id: string) => { const n = node(goalNodeId(id)); return card(GoalCard, n, { goal: n.goal, metrics: n.metrics, rows: n.rows, refs: n.refs, running: n.running, focusChangeId: null, onFocusChange: (c: string) => focused.push(c) }); };
  const project = (g: string, p: string) => { const n = node(projectNodeId(g, p)); return card(GoalProjectCard, n, { project: n.project }); };
  const owner = (id: string) => { const n = node(id); return card(GoalOwnerCard, n, { owner: n.owner, owns: n.owns }); };
  const company = node("company");

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(h(ReactFlowProvider, null,
      card(CompanyCard, company, { name: company.name, goals: company.goals, projects: company.projects }),
      goal("init-org"), goal("g-new"), goal("init-org-sub"), goal("init-orphan"), goal("init-revenue"),
      project("init-revenue", "proj-org"), project("init-org", "proj-inbox"),
      owner(roleNodeId("fixture-role-growth")), owner(personNodeId("fixture-user-sam")),
    ));
  });
  const cardOf = (id: string) => q(`[data-card='${id}']`, el)!;

  expect(cardOf("company").textContent).toContain("Codecast");
  expect(q("[data-company-tally]", el)!.textContent).toBe("5 goals · 3 projects");
  // A live goal: no ghost chrome, its health in words.
  const live = cardOf(goalNodeId("init-org"));
  expect(q("[data-org-node='goal']", live)).not.toBeNull();
  expect(q("[data-ghost-tag]", live)).toBeNull();
  expect(q("[data-initiative-health='at_risk']", live)).not.toBeNull();
  // A new goal wears one quiet mark: a thin solid outline over a tint, its tag
  // a plain word, its metrics a plain line. Nothing on the card is dashed.
  const fresh = cardOf(goalNodeId("g-new"));
  expect(q("[data-org-node='goal-ghost']", fresh)!.style.border).toContain("solid");
  expect(q("[data-ghost-tag]", fresh)!.style.border).toBe("");
  expect(fresh.innerHTML).not.toContain("dashed");
  // The project it would carry is drawn under the live goal that carries it today: one quiet line here naming it.
  expect(q("[data-project-refs]", fresh)!.getAttribute("title")).toContain("drawn under The role page is the session page");
  expect(q("[data-project-refs]", fresh)!.textContent).toContain("also ");
  expect(q("[data-goal-projects='1']", fresh)).not.toBeNull();
  expect(q("[data-ghost-chip='g-new']", fresh)!.textContent).toBe("Teams with a head of people → 40");
  // A placed goal says where it was.
  const placed = cardOf(goalNodeId("init-org-sub"));
  expect(q("[data-ghost-tag]", placed)).not.toBeNull();
  expect(q("[data-goal-was]", placed)!.textContent).toBe("was under Agents run the company's routine work");
  // A named owner and new metrics are chips on a goal that keeps its plain frame.
  expect(q("[data-ghost-chip='g-owner']", cardOf(goalNodeId("init-orphan")))!.textContent).toBe("owner Samvit Jain");
  expect(q("[data-org-node='goal']", cardOf(goalNodeId("init-revenue")))).not.toBeNull();
  expect(q("[data-ghost-chip='g-measure']", cardOf(goalNodeId("init-revenue")))!.textContent).toContain("Paying teams");
  // Projects: one it carries, one a change adds, one nobody leads.
  // proj-org under init-org is folded: a goal feeding it carries it too. A live row wears no tag.
  expect(layout.nodes.some((n) => n.id === projectNodeId("init-org", "proj-org"))).toBe(false);
  expect(q("[data-ghost-tag]", cardOf(projectNodeId("init-org", "proj-inbox")))).toBeNull();
  expect(q("[data-ghost-tag='added']", cardOf(projectNodeId("init-revenue", "proj-org")))).not.toBeNull();
  // The middle card names no lead; the close card does (orgZoom), and jsdom sits at zoom 1.
  expect(q("[data-project-lead]", cardOf(projectNodeId("init-org", "proj-inbox")))).toBeNull();
  // Owners: the role by its handle with what it owns, the person by name.
  expect(cardOf(roleNodeId("fixture-role-growth")).textContent).toContain("@growth");
  expect(cardOf(roleNodeId("fixture-role-growth")).textContent).toMatch(/owns \d+/);
  expect(cardOf(personNodeId("fixture-user-sam")).textContent).toContain("Samvit Jain");
  // A chip click focuses its change.
  await act(async () => { q("[data-ghost-chip='g-owner']", el)!.click(); });
  expect(focused).toEqual(["g-owner"]);
  await act(async () => { root.unmount(); });
  el.remove();
});

test("the header chip opens the org screen's map beside the conversation", async () => {
  const opened: string[] = [];
  registerSplitOpener((path) => { opened.push(path); return true; });
  // The chip names its own conversation as `beside`.
  useInboxStore.setState({
    messages: { "conv-hop": [{ _id: "m1", role: "assistant", content: "Here is the first pass.\n\nop-7", timestamp: 1 }, { _id: "m2", role: "assistant", content: "Look at the owner: /org?proposal=op-8&focus=4", timestamp: 2 }], "conv-plain": [{ _id: "m3", role: "assistant", content: "I revised op-8 in passing.", timestamp: 3 }] },
  } as any);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(h("div", null,
      h(OrgChartChip, { conversationId: "conv-hop" }),
      h("span", { "data-plain": true }, h(OrgChartChip, { conversationId: "conv-plain" })),
    ));
  });
  // A thread that holds no pointer has no chip.
  expect(q("[data-plain]", el)!.children.length).toBe(0);
  expect(q("[data-org-chart-chip]", el)!.getAttribute("data-org-chart-chip")).toBe("op-8");
  await act(async () => { q("[data-org-chart-chip]", el)!.click(); });
  await tick();
  expect(opened).toEqual(["/org?proposal=op-8&focus=4&show=map&beside=conv-hop"]);
  await act(async () => { root.unmount(); });
  el.remove();
});

test("the map lights the change a card in the conversation points at, and pans only when it is off screen", async () => {
  const { OrgMap } = await import("./OrgMap");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = (highlightChangeId: string | null) => act(async () => { root.render(h(OrgMap, { tree: ORG_FIXTURE, goals: GOALS_FIXTURE_DATA, proposal: { changes: GOALS_FIXTURE_CHANGES }, filter: "everything", onFilter() {}, asProposed: true, onAsProposed() {}, highlightChangeId })); });
  await render(null);
  expect(graphProps.at(-1)!.focusTarget).toBeNull();
  expect(graphProps.at(-1)!.changes.length).toBe(5);
  await render("g-owner");
  const target = graphProps.at(-1)!.focusTarget;
  expect(target).toMatchObject({ kind: "change", id: "g-owner", ifHidden: true });
  expect(graphProps.at(-1)!.focusChangeId).toBe("g-owner");
  // The same hover re-rendered is the same ask, not a new pan.
  await render("g-owner");
  expect(graphProps.at(-1)!.focusTarget).toBe(target);
  await render(null);
  expect(graphProps.at(-1)!.focusTarget).toBeNull();
  // The filter chips and the overlay toggle are in the map's own bar.
  expect(q("[data-map-filter='everything']", el)).not.toBeNull();
  expect(q("[data-map-proposed='on']", el)).not.toBeNull();
  await act(async () => { root.unmount(); });
  el.remove();
});
