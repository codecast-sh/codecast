// ct-97072: a proposal opened from the Head of People's thread (the org drawer
// at home) closes back to that thread. Closing it must not save the drawer as
// "closed" for the person, and the next visit to /org shows the thread again.
// React Flow and the feeders are mocked as in OrgChart.mount.test.tsx; the
// store's UI write is a recorder, so nothing reaches a server.
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

test("closing a proposal opened from the Head of People's thread returns to that thread and keeps the drawer open on later visits", async () => {
  seedStore();
  // At /org the drawer holds the Head of People's thread, where the person is writing.
  search = "";
  let m = await mount();
  expect(q("[data-org-panel='home']", m.el)).not.toBeNull();
  await m.done();

  // The thread's proposal chip opens /org?proposal=op-7 in the drawer; the person presses Close.
  search = "proposal=op-7";
  m = await mount();
  expect(q("[data-org-panel='proposal']", m.el)).not.toBeNull();
  await act(async () => { q("[data-line-drawer-close]", m.el)!.click(); });
  await m.done();

  // Closing the proposal is not closing the drawer: nothing saves it closed.
  expect(uiWrites.filter((w) => w.org_panel === "closed")).toEqual([]);
  expect((useInboxStore.getState() as any).clientState.ui?.org_panel).not.toBe("closed");

  // Back at /org (wherever Close lands), the Head of People's thread is in the drawer again.
  search = "";
  m = await mount();
  expect(q("[data-org-panel='home']", m.el)).not.toBeNull();
  expect(q("[data-org-panel-open]", m.el)).toBeNull();
  await m.done();
});

const SESSION = "jx7head0fpeople000000000000000s1";

test("Close on a proposal opened from the Head of People's conversation goes back to that conversation in one press, draft intact, never via bare /org", async () => {
  seedStore();
  _resetTrailForTests();
  const opened: string[] = [];
  useInboxStore.setState({
    drafts: { [SESSION]: { draft_message: "Thanks, one question before I approve" } },
    navigateToSession: (id: string) => { opened.push(id); },
  } as any);
  // The tab showed the conversation, then its proposal chip opened /org?proposal=op-7 in the same tab.
  recordTrail("t1", `/conversation/${SESSION}`, "push");
  recordTrail("t1", "/org?proposal=op-7", "push");
  search = "proposal=op-7";
  nav.length = 0;
  const m = await mount("/org?proposal=op-7");
  await act(async () => { q("[data-line-drawer-close]", m.el)!.click(); });
  await m.done();

  expect(opened).toEqual([SESSION]);
  expect(nav).toEqual([`push /inbox?s=${SESSION}`]);
  expect(nav).not.toContain("push /org");
  expect((useInboxStore.getState() as any).drafts[SESSION]?.draft_message).toBe("Thanks, one question before I approve");
  expect(uiWrites.filter((w) => w.org_panel === "closed")).toEqual([]);
});

test("Close on a proposal reached by a pasted link, with nothing to go back to, lands on /org with the drawer open", async () => {
  seedStore();
  _resetTrailForTests();
  uiWrites.length = 0;
  search = "proposal=op-7";
  nav.length = 0;
  let m = await mount("/org?proposal=op-7");
  await act(async () => { q("[data-line-drawer-close]", m.el)!.click(); });
  await m.done();

  expect(nav).toEqual(["push /org"]);
  expect(uiWrites.filter((w) => w.org_panel === "closed")).toEqual([]);
  search = "";
  m = await mount("/org");
  expect(q("[data-org-panel='home']", m.el)).not.toBeNull();
  await m.done();
});
