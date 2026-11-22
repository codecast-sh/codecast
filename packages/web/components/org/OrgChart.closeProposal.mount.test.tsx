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

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { OrgChart } = await import("./OrgChart");
const { MemoryRouter } = await import("react-router");

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
async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(MemoryRouter, null, h(OrgChart))); });
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
