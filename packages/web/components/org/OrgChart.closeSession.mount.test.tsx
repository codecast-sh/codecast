// ct-101312: a role's session opened from the org chart (/org?session=<id>)
// closes back to the chart, never to the page the person was on before /org.
// placeKey drops the query, so /org and /org?session=X were one trail entry
// and Close followed the trail to the entry below it (/goals in rp-24830).
// React Flow and the feeders are mocked as in OrgChart.closeProposal.mount.test.tsx.
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/org", pretendToBeVisual: true });
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

const { ORG_FIXTURE_WITH_HEAD } = await import("./orgFixture");
const tree: any = ORG_FIXTURE_WITH_HEAD;

let search = "";
const nav: string[] = [];
const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}) }));
const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...realNav,
  useRouter: () => ({ push: (p: string) => nav.push(`push ${p}`), replace: (p: string) => nav.push(`replace ${p}`), back: () => nav.push("back") }),
  useSearchParams: () => new URLSearchParams(search),
}));
const realTree = { ...(await import("../../hooks/useSyncOrgTree")) };
mock.module("../../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTree: () => ({ tree, ready: true, missing: false, refused: false, retry() {} }) }));
const realProjects = { ...(await import("../../hooks/useSyncProjects")) };
mock.module("../../hooks/useSyncProjects", () => ({ ...realProjects, useSyncProjects: () => {} }));
const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
mock.module("../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposal: () => ({ ready: true, missing: false }) }));
const realHealth = { ...(await import("../../hooks/useSyncOrgHealth")) };
mock.module("../../hooks/useSyncOrgHealth", () => ({ ...realHealth, useSyncOrgHealth: () => ({ health: null, ready: true, missing: false, refresh: async () => {} }) }));
const realUnder = { ...(await import("../../hooks/useOrgSessionsUnder")) };
mock.module("../../hooks/useOrgSessionsUnder", () => ({ ...realUnder, useOrgSessionsUnder: () => ({ data: undefined }) }));
mock.module("./OrgGraph", () => ({ OrgGraph: (props: any) => h("div", { "data-graph-lens": props.lens }) }));
// The Head of People's thread itself is the real conversation view, which needs a Convex client; the drawer around it is what this test reads.
const realAnchor = { ...(await import("../anchor/AnchorConversation")) };
mock.module("../anchor/AnchorConversation", () => ({ ...realAnchor, AnchorConversation: (props: any) => h("div", { "data-thread": props.conversationId }) }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { OrgChart } = await import("./OrgChart");
const { MemoryRouter } = await import("react-router");
const { TabParamsCtx, parseTabLocation } = await import("../../lib/tabParams");
const { recordTrail, _resetTrailForTests } = await import("../../lib/navTrail");

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const uiWrites: any[] = [];
function seedStore() {
  const st = useInboxStore.getState() as any;
  useInboxStore.setState({
    currentUser: { ...(st.currentUser ?? {}), _id: "fixture-user-me" },
    orgTree: tree,
    clientState: { ...st.clientState, ui: { ...(st.clientState?.ui ?? {}), org_view: "people", org_panel: undefined, active_team_id: "fixture-team" } },
    updateClientUI: (partial: any) => {
      uiWrites.push(partial);
      const s2 = useInboxStore.getState() as any;
      useInboxStore.setState({ clientState: { ...s2.clientState, ui: { ...s2.clientState.ui, ...partial } } } as any);
    },
  } as any);
}
/** Mount the chart, as app tab t1's own page showing `tabPath` when given (so Close can read the tab's trail). */
async function mount(tabPath?: string) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  let page: any = h(OrgChart);
  if (tabPath) {
    useInboxStore.setState({ tabs: [{ id: "t1", path: tabPath, title: "", createdAt: 0 }], activeTabId: "t1" } as any);
    page = h(TabParamsCtx.Provider, { value: { tabId: "t1", ...parseTabLocation(tabPath), params: {}, isActive: true, isVisible: true } as any }, page);
  }
  await act(async () => { root.render(h(MemoryRouter, null, page)); });
  return { el, done: async () => { await act(async () => { root.unmount(); }); el.remove(); } };
}

const SESSION = "jx7role0session00000000000000s1";

test("Close on a session drawer opened from the org chart stays on the chart, not the page before it", async () => {
  seedStore();
  _resetTrailForTests();
  // The tab was on /goals, went to /org, then a role's session opened in the drawer.
  recordTrail("t1", "/goals", "push");
  recordTrail("t1", "/org", "push");
  recordTrail("t1", `/org?session=${SESSION}`, "push");
  search = `session=${SESSION}`;
  nav.length = 0;
  const m = await mount(`/org?session=${SESSION}`);
  const close = q("[data-line-drawer-close]", m.el);
  expect(close).not.toBeNull();
  await act(async () => { close!.click(); });
  await m.done();

  expect(nav.filter((n) => n.includes("/goals"))).toEqual([]);
  expect(nav.some((n) => n === "push /org" || n === "replace /org" || n === "back")).toBe(true);
  expect(uiWrites.filter((w) => w.org_panel === "closed")).toEqual([]);
});
