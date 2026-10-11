// /org mounted over the org fixture: the People | Everything | Goals switch and
// what it saves, and the People chart driven the way a person drives it (fold a
// card, open a "+N more" stack and page the server, drop a card and confirm).
// React Flow is mocked (it draws nothing without a measured viewport): the
// test reads what the page hands the canvas and calls the gestures it reports.
// The store's writes are replaced by recorders, so nothing reaches a server.
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

const { ORG_FIXTURE, ORG_FIXTURE_ALL_SESSIONS } = await import("./orgFixture");
const { sortOrgSessions } = await import("./orgTypes");
let tree: any = ORG_FIXTURE;

const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}) }));
const pushed: string[] = [];
const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push: (p: string) => pushed.push(p), replace() {} }), useSearchParams: () => new URLSearchParams() }));
const realTree = { ...(await import("../../hooks/useSyncOrgTree")) };
mock.module("../../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTree: () => ({ tree, ready: true, missing: false, refused: false, retry() {} }) }));
const realProjects = { ...(await import("../../hooks/useSyncProjects")) };
mock.module("../../hooks/useSyncProjects", () => ({ ...realProjects, useSyncProjects: () => {} }));
const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
mock.module("../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposal: () => ({ ready: true, missing: false }) }));
const realHealth = { ...(await import("../../hooks/useSyncOrgHealth")) };
mock.module("../../hooks/useSyncOrgHealth", () => ({ ...realHealth, useSyncOrgHealth: () => ({ health: null, ready: true, missing: false, refresh: async () => {} }) }));
// org.sessionsUnder: answers the asked page from the fixture's full list, as the server pages by offset.
const pageAsks: any[] = [];
const realUnder = { ...(await import("../../hooks/useOrgSessionsUnder")) };
mock.module("../../hooks/useOrgSessionsUnder", () => ({
  ...realUnder,
  useOrgSessionsUnder: (args: any) => {
    if (args === "skip") return { data: undefined };
    pageAsks.push(args);
    const all = sortOrgSessions(ORG_FIXTURE_ALL_SESSIONS.filter((s) => args.parent.kind === "user" ? s.owner_user_id === args.parent.user_id && !s.org_role_id : s.org_role_id === args.parent.role_id));
    const start = Number(args.cursor);
    return { data: { sessions: all.slice(start, start + args.limit), next_cursor: start + args.limit < all.length ? String(start + args.limit) : undefined } };
  },
}));
const graphProps: any[] = [];
mock.module("./OrgGraph", () => ({ OrgGraph: (props: any) => { graphProps.push(props); return h("div", { "data-graph-lens": props.lens }); } }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { OrgChart } = await import("./OrgChart");

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const last = () => graphProps.at(-1)!;
const ME = "fixture-user-me";
const meNode = `person:${ME}`;

// Recorders in place of the store's writes: the UI pref and both reparents.
const uiWrites: any[] = [];
const sessionMoves: any[] = [];
const roleMoves: any[] = [];
function seedStore(org_view?: string) {
  const st = useInboxStore.getState() as any;
  useInboxStore.setState({
    currentUser: { ...(st.currentUser ?? {}), _id: ME },
    clientState: { ...st.clientState, ui: { ...(st.clientState?.ui ?? {}), org_view } },
    updateClientUI: (partial: any) => {
      uiWrites.push(partial);
      const s2 = useInboxStore.getState() as any;
      useInboxStore.setState({ clientState: { ...s2.clientState, ui: { ...s2.clientState.ui, ...partial } } } as any);
    },
    reparentOrgSession: (...args: any[]) => { sessionMoves.push(args); return Promise.resolve(undefined); },
    reparentOrgRole: (...args: any[]) => { roleMoves.push(args); return Promise.resolve(undefined); },
  } as any);
}

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(OrgChart)); });
  return { el, done: async () => { await act(async () => { root.unmount(); }); el.remove(); } };
}

test("the switch reads People by default, saves each choice for the person, and an older screen's saved value reads as People", async () => {
  tree = ORG_FIXTURE;
  seedStore("map");
  const { el, done } = await mount();
  expect(q("[data-org-chart='people']", el)).not.toBeNull();
  expect(q("[data-org-view='people']", el)!.getAttribute("aria-checked")).toBe("true");
  expect(last().lens).toBe("people");
  // People is the interactive chart: session cards under every card, and the page's own gestures.
  expect(last().view.sessionCards).toBe(true);
  expect(last().canDrag({ kind: "role", role: tree.roles[0] })).toBe(true);
  await act(async () => { q("[data-org-view='everything']", el)!.click(); });
  expect(uiWrites.at(-1)).toEqual({ org_view: "everything" });
  // Everything is the people chart with the product layer joined in: same drag, same view.
  expect(last().lens).toBe("people");
  expect(last().product).toEqual({ sessionProject: {} });
  expect(last().view.sessionCards).toBe(true);
  await act(async () => { q("[data-org-view='goals']", el)!.click(); });
  expect(uiWrites.at(-1)).toEqual({ org_view: "goals" });
  expect(last().lens).toBe("goals");
  // Pressing the view already on writes nothing.
  const n = uiWrites.length;
  await act(async () => { q("[data-org-view='goals']", el)!.click(); });
  expect(uiWrites.length).toBe(n);
  await done();
});

test("People: a card folds and unfolds, a \"+N more\" stack opens what the tree holds then pages the server, and \"Show fewer\" closes it", async () => {
  tree = ORG_FIXTURE;
  seedStore("people");
  pageAsks.length = 0;
  const { done } = await mount();
  await act(async () => { last().onToggleCollapse(meNode); });
  expect(last().view.collapsed.has(meNode)).toBe(true);
  await act(async () => { last().onToggleCollapse(meNode); });
  expect(last().view.collapsed.has(meNode)).toBe(false);
  // First click: the tree's payload holds eight, the stack drew five; it opens with no request.
  await act(async () => { last().onExpandCluster(meNode); });
  expect(last().view.expanded[meNode]).toEqual([]);
  expect(pageAsks.length).toBe(0);
  // Second click: the server's next page starts past the eight the tree carried.
  await act(async () => { last().onExpandCluster(meNode); });
  expect(pageAsks[0]).toMatchObject({ parent: { kind: "user", user_id: ME }, cursor: "8", limit: 8, team_id: "fixture-team" });
  expect(last().view.expanded[meNode].length).toBe(8);
  expect(last().loadingClusters.has(meNode)).toBe(false);
  // The next click continues from the server's cursor.
  await act(async () => { last().onExpandCluster(meNode); });
  expect(pageAsks.at(-1).cursor).toBe("16");
  expect(last().view.expanded[meNode].length).toBe(14);
  await act(async () => { last().onCollapseCluster(meNode); });
  expect(meNode in last().view.expanded).toBe(false);
  await done();
});

test("People: a dropped session asks first, and Move hands the store the session, its new parent and its row; Cancel moves nothing and puts the card back", async () => {
  tree = ORG_FIXTURE;
  seedStore("people");
  sessionMoves.length = 0;
  const { done } = await mount();
  const s = ORG_FIXTURE.people[0].sessions[0];
  const to = { kind: "role", role_id: "fixture-role-growth" };
  const req = { subject: { kind: "session", id: s._id, title: s.title }, target: to, targetTitle: "Head of Growth", at: { x: 200, y: 200 } };
  const reset0 = last().resetKey;
  await act(async () => { last().onReparentRequest(req); });
  expect(q("[data-move-confirm]")!.textContent).toContain("Head of Growth");
  await act(async () => { q("[data-move-cancel]")!.click(); });
  expect(q("[data-move-confirm]")).toBeNull();
  expect(sessionMoves.length).toBe(0);
  expect(last().resetKey).toBe(reset0 + 1);
  await act(async () => { last().onReparentRequest(req); });
  await act(async () => { q("[data-move-confirm] button[data-primary]")!.click(); });
  expect(sessionMoves.length).toBe(1);
  expect(sessionMoves[0][0]).toBe(s._id);
  expect(sessionMoves[0][1]).toEqual(to);
  expect(sessionMoves[0][2].row._id).toBe(s._id);
  expect(q("[data-move-confirm]")).toBeNull();
  // A drop where it already is asks nothing.
  await act(async () => { last().onReparentRequest({ ...req, target: { kind: "user", user_id: ME } }); });
  expect(q("[data-move-confirm]")).toBeNull();
  await done();
});

test("People: a role never moves under its own report, and a member moves only what they own", async () => {
  // A second role under Growth: Growth dropped on it would close a loop.
  const seo = { ...ORG_FIXTURE.roles[0], _id: "fixture-role-seo", short_id: "or-2", name: "SEO", handle: "seo", reports_to: { kind: "role", role_id: "fixture-role-growth" }, sessions: [], total: 0 };
  tree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, seo] };
  seedStore("people");
  roleMoves.length = 0;
  const { done } = await mount();
  const reset0 = last().resetKey;
  await act(async () => { last().onReparentRequest({ subject: { kind: "role", id: "fixture-role-growth", title: "Head of Growth" }, target: { kind: "role", role_id: "fixture-role-seo" }, targetTitle: "SEO", at: { x: 0, y: 0 } }); });
  expect(q("[data-move-confirm]")).toBeNull();
  expect(last().resetKey).toBe(reset0 + 1);
  expect(roleMoves.length).toBe(0);
  await done();

  // The viewer as a member: their own session moves, a teammate's is not even draggable.
  tree = { ...ORG_FIXTURE, people: ORG_FIXTURE.people.map((p: any) => (p.is_me ? { ...p, role: "member" } : p)) };
  const m = await mount();
  const mine = ORG_FIXTURE.people[0].sessions[0];
  const sams = ORG_FIXTURE.people[1].sessions[0];
  expect(last().canDrag({ kind: "session", session: mine })).toBe(true);
  expect(last().canDrag({ kind: "session", session: sams })).toBe(false);
  // Growth is hosted by the viewer, so it still moves.
  expect(last().canDrag({ kind: "role", role: tree.roles[0] })).toBe(true);
  await act(async () => { last().onReparentRequest({ subject: { kind: "session", id: sams._id, title: sams.title }, target: { kind: "user", user_id: ME }, targetTitle: "Ashot", at: { x: 0, y: 0 } }); });
  expect(q("[data-move-confirm]")).toBeNull();
  await m.done();
});

test("People: a click on a card opens the page it already has", async () => {
  tree = ORG_FIXTURE;
  seedStore("people");
  pushed.length = 0;
  // The page reads a role's session off the store's tree, which the feeder fills in the app.
  useInboxStore.setState({ orgTree: tree } as any);
  const { done } = await mount();
  await act(async () => { last().onOpenSession("fixture-session-1"); });
  expect(pushed.at(-1)).toBe("/conversation/fixture-session-1");
  await act(async () => { last().onOpenObject({ kind: "role", id: "fixture-role-growth" }); });
  expect(pushed.at(-1)).toBe("/conversation/fixture-growth-conv");
  await done();
});

test("a card opens in place from its toggle, and Expand all opens every card, is saved for the person, and Collapse all closes them", async () => {
  tree = ORG_FIXTURE;
  seedStore("people");
  useInboxStore.setState({ clientState: { ...(useInboxStore.getState() as any).clientState, ui: { ...(useInboxStore.getState() as any).clientState.ui, org_expand_all: false } } } as any);
  const { el, done } = await mount();
  const role = `role:${ORG_FIXTURE.roles[0]._id}`;
  const session = `session:${ORG_FIXTURE.people[0].sessions[0]._id}`;
  expect(last().view.opened.size).toBe(0);
  await act(async () => { last().onToggleOpen(role); });
  expect([...last().view.opened]).toEqual([role]);
  // What an open role lists comes from the store: here no projects or tasks, so empty lists, never a guess.
  expect(last().view.roleDetails[ORG_FIXTURE.roles[0]._id]).toEqual({ leads: [], tasks: [] });
  await act(async () => { last().onToggleOpen(role); });
  expect(last().view.opened.size).toBe(0);
  // Expand all: every role and session card, saved as the person's own choice.
  expect(q("[data-org-expand-all='off']", el)!.textContent).toBe("Expand all");
  await act(async () => { q("[data-org-expand-all]", el)!.click(); });
  expect(uiWrites.at(-1)).toEqual({ org_expand_all: true });
  expect(last().view.opened.has(role)).toBe(true);
  expect(last().view.opened.has(session)).toBe(true);
  // A card closed by hand while it is on stays closed; the rest stay open.
  await act(async () => { last().onToggleOpen(session); });
  expect(last().view.opened.has(session)).toBe(false);
  expect(last().view.opened.has(role)).toBe(true);
  expect(q("[data-org-expand-all='on']", el)!.textContent).toBe("Collapse all");
  await act(async () => { q("[data-org-expand-all]", el)!.click(); });
  expect(uiWrites.at(-1)).toEqual({ org_expand_all: false });
  expect(last().view.opened.size).toBe(0);
  // Goals has no cards to open, so no control.
  await act(async () => { q("[data-org-view='goals']", el)!.click(); });
  expect(q("[data-org-expand-all]", el)).toBeNull();
  await done();
});
