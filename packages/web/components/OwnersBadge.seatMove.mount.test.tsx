// ct-73240: a role's own session, opened in the inbox, offers "Reports to ·
// whose inbox". Picking from it reparents the role, which the server allows
// only for the role's host, its personal owner or a team admin
// (convex/lib/orgAccess.ts userCanAdminRole). A plain member who is not the
// host was offered the picker anyway, the pick went out, and the server
// refused it as "Only an admin (or the host) can reshape this role", reported
// as a dispatch Server Error. The menu must not send a move the server refuses.
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "DOMRect"]) {
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
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => {} }));
const realTree = { ...(await import("../hooks/useSyncOrgTree")) };
mock.module("../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry() {} }) }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../store/inboxStore");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import("./ui/dropdown-menu");
const { OwnerMenuItems } = await import("./OwnersBadge");
const { ORG_FIXTURE } = await import("./org/orgFixture");

const HOST = "fixture-user-me";
const SAM = "fixture-user-sam";
const ROLE = "fixture-role-growth";
const SEAT = "fixture-growth-conv";
const people = [
  { _id: HOST, name: "Ashot Petrosian" },
  { _id: SAM, name: "Samvit Jain" },
];

const roleMoves: any[] = [];
function seed(viewer: string, viewerTeamRole: "admin" | "member") {
  const tree = JSON.parse(JSON.stringify(ORG_FIXTURE));
  for (const p of tree.people) {
    p.is_me = p.user_id === viewer;
    p.role = p.user_id === viewer ? viewerTeamRole : "member";
  }
  const st = useInboxStore.getState() as any;
  useInboxStore.setState({
    currentUser: { ...(st.currentUser ?? {}), _id: viewer },
    clientState: { ...st.clientState, ui: { ...(st.clientState?.ui ?? {}), active_team_id: "fixture-team" } },
    orgTree: tree,
    orgScope: null,
    sessions: { ...(st.sessions ?? {}), [SEAT]: { _id: SEAT, team_id: "fixture-team", standing_role_id: ROLE, user_id: HOST } },
    reparentOrgRole: (...args: any[]) => { roleMoves.push(args); return Promise.resolve(undefined); },
  } as any);
}

async function pickEveryReportsTo(viewer: string) {
  const owners: any = { ownerList: [HOST], currentUser: { _id: viewer }, selectable: people, moveToRole: () => {} };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(h(DropdownMenu, { open: true, modal: false },
      h(DropdownMenuTrigger, null, "open"),
      h(DropdownMenuContent, null,
        h(OwnerMenuItems, { owners, conversationId: SEAT, handingOff: false, onHandingOff: () => {}, onDone: () => {} }))));
  });
  const items = Array.from(document.querySelectorAll("[role='menuitemcheckbox']")) as HTMLElement[];
  for (const item of items) await act(async () => { item.click(); });
  await act(async () => { root.unmount(); });
  el.remove();
  return items.length;
}

test("control: a team admin who is not the host is offered the move and it is sent", async () => {
  roleMoves.length = 0;
  seed(SAM, "admin");
  const offered = await pickEveryReportsTo(SAM);
  expect(offered).toBeGreaterThan(0);
  expect(roleMoves.length).toBeGreaterThan(0);
});

test("a plain member who is not the role's host sends no move from the seat's Reports-to menu", async () => {
  roleMoves.length = 0;
  seed(SAM, "member");
  await pickEveryReportsTo(SAM);
  expect(roleMoves).toEqual([]);
});
