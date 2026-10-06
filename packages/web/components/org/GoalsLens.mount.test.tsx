// Mounts the Goals lens and the chart pane in jsdom (org-staffing.md S36):
// the goal, project and owner cards wearing a proposal's ghost chrome, the two
// openers (the card's Chart button, the header chip) reaching the stage's
// split opener with the pane's address, and the pane itself: its lens from
// the address, the proposal in its bar, and the thread's newest pointer
// re-pointing it while it follows.
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
const { OrgChartChip, ProposalChartButton } = await import("./orgChartLink");
const { OrgChartPane } = await import("./OrgChartPane");
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
  // The project it would carry is drawn under the live goal that carries it today: a reference chip here.
  expect(q("[data-project-ref='proj-org']", fresh)!.getAttribute("title")).toContain("drawn under The role page is the session page");
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

test("the card's Chart button and the header chip open the pane beside the conversation", async () => {
  const opened: string[] = [];
  registerSplitOpener((path) => { opened.push(path); return true; });
  // The conversation in view rides along as `s`; the view guard owns that
  // field, so the button is read here with none in view and the chip names its own.
  useInboxStore.setState({
    messages: { "conv-hop": [{ _id: "m1", role: "assistant", content: "Here is the first pass.\n\nop-7", timestamp: 1 }, { _id: "m2", role: "assistant", content: "Look at the owner: /org?proposal=op-8&focus=4", timestamp: 2 }], "conv-plain": [{ _id: "m3", role: "assistant", content: "I revised op-8 in passing.", timestamp: 3 }] },
  } as any);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(h("div", null,
      h(ProposalChartButton, { proposal: { short_id: "op-7" } }),
      h(OrgChartChip, { conversationId: "conv-hop" }),
      h("span", { "data-plain": true }, h(OrgChartChip, { conversationId: "conv-plain" })),
    ));
  });
  // A thread that holds no pointer has no chip.
  expect(q("[data-plain]", el)!.children.length).toBe(0);
  expect(q("[data-org-chart-chip]", el)!.getAttribute("data-org-chart-chip")).toBe("op-8");
  await act(async () => { q("[data-open-chart='op-7']", el)!.click(); });
  await tick();
  await act(async () => { q("[data-org-chart-chip]", el)!.click(); });
  await tick();
  expect(opened).toEqual(["/org?view=chart&proposal=op-7", "/org?view=chart&proposal=op-8&focus=4&s=conv-hop"]);
  await act(async () => { root.unmount(); });
  el.remove();
});

test("the pane reads its address, draws the proposal, and follows the thread's newest pointer", async () => {
  useInboxStore.setState({
    orgTree: ORG_FIXTURE,
    orgProposals: { [ORG_GOALS_FIXTURE_PROPOSAL._id]: (({ changes: _c, ...row }) => row)(ORG_GOALS_FIXTURE_PROPOSAL) },
    orgProposalChanges: Object.fromEntries(GOALS_FIXTURE_CHANGES.map((c) => [c._id, c])),
    messages: { "conv-hop": [{ _id: "m1", role: "assistant", content: "op-8", timestamp: 1 }] },
  } as any);
  search = "view=chart&proposal=op-8&s=conv-hop";
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = () => act(async () => { root.render(h(OrgChartPane, { goalsData: GOALS_FIXTURE_DATA })); });
  await render();
  // The map opens on everything, with the proposal's changes drawn over it ("As proposed" is on).
  expect(q("[data-org-chart-pane]", el)!.getAttribute("data-org-chart-pane")).toBe("everything");
  expect(q("[data-graph-lens]", el)!.getAttribute("data-graph-lens")).toBe("everything");
  expect(q("[data-graph-changes]", el)!.getAttribute("data-graph-changes")).toBe("5");
  expect(q("[data-map-proposed]", el)!.getAttribute("data-map-proposed")).toBe("on");
  expect(q("[data-chart-proposal='op-8']", el)!.textContent).toContain("Name the goals the work already serves");
  // Counted in cards: two of the five changes land on one goal.
  expect(q("[data-proposal-meta]", el)!.getAttribute("data-proposal-meta")).toBe("4 to decide");
  expect(q("[data-chart-follow]", el)!.getAttribute("data-chart-follow")).toBe("on");
  // The pointer that was there when the pane opened moves nothing.
  expect(replaced).toEqual([]);

  // The agent points at one change: the pane re-points itself there.
  await act(async () => {
    useInboxStore.setState((s: any) => ({ messages: { ...s.messages, "conv-hop": [...s.messages["conv-hop"], { _id: "m2", role: "assistant", content: "The owner is the open question: /org?proposal=op-8&focus=4", timestamp: 2 }] } }));
  });
  expect(replaced).toEqual(["/org?view=chart&proposal=op-8&focus=4&s=conv-hop"]);
  search = replaced[0].split("?")[1];
  await render();
  expect(q("[data-graph-focus]", el)!.getAttribute("data-graph-focus")).toBe("change:g-owner");

  // The person picks the People filter: it holds, in the address, and the focus (a goal change, not on that chart) is dropped.
  await act(async () => { q("[data-map-filter-pick='people']", el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?view=chart&proposal=op-8&lens=people&s=conv-hop");
  search = replaced.at(-1)!.split("?")[1];
  await render();
  expect(q("[data-graph-lens]", el)!.getAttribute("data-graph-lens")).toBe("people");
  // The overlay off: the company as it is, the proposal still named in the bar.
  await act(async () => { q("[data-map-proposed]", el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?view=chart&proposal=op-8&lens=people&proposed=0&s=conv-hop");
  search = replaced.at(-1)!.split("?")[1];
  await render();
  expect(q("[data-graph-changes]", el)!.getAttribute("data-graph-changes")).toBe("0");
  expect(q("[data-chart-proposal='op-8']", el)).not.toBeNull();
  search = "view=chart&proposal=op-8&focus=4&lens=people&s=conv-hop";
  await render();
  // Follow off: a newer pointer no longer moves the pane.
  await act(async () => { q("[data-chart-follow]", el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?view=chart&proposal=op-8&focus=4&lens=people&s=conv-hop&follow=0");
  search = replaced.at(-1)!.split("?")[1];
  await render();
  // A goal change in focus has no place on the reporting chart: the map shows everything for it.
  expect(q("[data-graph-lens]", el)!.getAttribute("data-graph-lens")).toBe("everything");
  const before = replaced.length;
  await act(async () => {
    useInboxStore.setState((s: any) => ({ messages: { ...s.messages, "conv-hop": [...s.messages["conv-hop"], { _id: "m3", role: "assistant", content: "op-7", timestamp: 3 }] } }));
  });
  expect(replaced.length).toBe(before);
  expect(q("[data-chart-follow]", el)!.getAttribute("data-chart-follow")).toBe("off");
  // Follow on again lands on what the thread points at now.
  await act(async () => { q("[data-chart-follow]", el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?view=chart&proposal=op-7&s=conv-hop");
  await act(async () => { root.unmount(); });
  el.remove();
});

test("the pane is read only: no reply box, no answer handlers, and the card hovered in the conversation lights its node without a pan", async () => {
  useInboxStore.setState({
    orgTree: ORG_FIXTURE,
    orgProposals: { [ORG_GOALS_FIXTURE_PROPOSAL._id]: (({ changes: _c, ...row }) => row)(ORG_GOALS_FIXTURE_PROPOSAL) },
    orgProposalChanges: Object.fromEntries(GOALS_FIXTURE_CHANGES.map((c) => [c._id, c])),
    messages: { "conv-hop": [{ _id: "m1", role: "assistant", content: "op-8", timestamp: 1 }] },
    reviewComments: {},
  } as any);
  for (const s of ["view=chart&proposal=op-8&s=conv-hop", "view=chart&proposal=op-8"]) {
    search = s;
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(OrgChartPane, { goalsData: GOALS_FIXTURE_DATA })); });
    expect(q("[data-chart-reply]", el)).toBeNull();
    expect(q("[data-ghost-actions]", el)).toBeNull();
    const graph = graphProps.at(-1)!;
    expect(graph.ghostAnswers).toBeUndefined();
    expect(graph.onEditAccept).toBeUndefined();
    expect(graph.canDrag({ kind: "role" })).toBe(false);
    expect(graph.view.sessionCards).toBe(false);
    await act(async () => { root.unmount(); });
    el.remove();
  }
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
