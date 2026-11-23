import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";
import { useOwnersFromStore } from "../OwnersBadge";
import { OwnersSegment } from "../OwnersMenu";
import { machineOf } from "../../lib/ownersDraft";

// The owners menu by keyboard and by touch (round 1 web findings 1-3, 8, 10,
// 12): nothing is highlighted on open; the arrows walk the owners and then
// the candidates, keeping the highlighted row in view; Shift+Enter makes the
// highlighted row driver; a touch's synthetic hover highlights nothing; the
// only owner's × says why it cannot leave; an outside tap keeps a staged change.
// Run: bun test components/__tests__/ownersMenu.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const ID = "jx70000000000000000000000ownmenu"; // 32 chars => isConvexId
const ME = "user_me";
const TEAM = "team_t";
const ROLE = { _id: "role_lead", short_id: "or-1", handle: "lead", name: "Resourcing lead", status: "active", team_id: TEAM, scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: "user_me" } };
const member = (_id: string, name: string) => ({ _id, name, roster_team: TEAM });

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

let scrolled: string[] = [];
let applied: any[] = [];
beforeEach(() => {
  scrolled = [];
  applied = [];
  (w.HTMLElement.prototype as any).scrollIntoView = function () { scrolled.push(this.getAttribute("data-owner-row") ?? this.getAttribute("data-owner-candidate")); };
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: any[]) => { if (action === "applySessionOwners") applied.push(args[1]); });
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me Person" } as any,
    clientState: { ...useInboxStore.getState().clientState, ui: { ...(useInboxStore.getState().clientState as any)?.ui, active_team_id: TEAM } } as any,
    teamMembers: [member(ME, "Me Person"), member("user_ashot", "Ashot Petrosian"), member("user_sam", "Samvit Rao")] as any,
    orgTree: { workspace: { kind: "team", id: TEAM }, roles: [ROLE], anchors: [], people: [] } as any,
    pending: {},
    sessions: { [ID]: { _id: ID, session_id: "s-own", user_id: ME, team_id: TEAM, updated_at: 1, owner_user_id: ME, owner_ids: [ME, "user_ashot"], org_role_id: ROLE._id, driver_user_id: "user_ashot" } },
    conversations: {},
    sessionOwners: { [ID]: { _id: ID, conversation_id: ID, can_edit: true, role: { role_id: ROLE._id, short_id: ROLE.short_id, handle: ROLE.handle, name: ROLE.name }, runner: { user_id: ME, is_bot: false }, author_id: ME, bots: [],
      owners: [{ user_id: ME, name: "Me Person", added_at: 1 }, { user_id: "user_ashot", name: "Ashot Petrosian", added_at: 2 }] } },
  } as any);
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  w.document.body.innerHTML = "";
});

function Seg() {
  const owners = useOwnersFromStore(ID);
  return <OwnersSegment conversationId={ID} owners={owners} compact={false} />;
}

async function openMenu(): Promise<HTMLElement> {
  host = w.document.createElement("div");
  w.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ConvexProvider client={fakeConvex()}><div data-cc-runner><Seg /></div></ConvexProvider>); });
  const seg = host!.querySelector("[data-owners-seg]") as HTMLElement;
  await act(async () => {
    seg.dispatchEvent(new w.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    seg.click();
  });
  const menu = w.document.querySelector("[data-owners-menu]") as HTMLElement;
  expect(menu).toBeTruthy();
  return menu;
}

const press = async (key: string, shiftKey = false) => {
  const input = w.document.querySelector("[data-owners-menu] input") as HTMLElement;
  await act(async () => { input.dispatchEvent(new w.KeyboardEvent("keydown", { key, shiftKey, bubbles: true })); });
};
const highlighted = () => [...w.document.querySelectorAll("[data-owners-menu] [data-highlighted]")].map((e: any) => e.getAttribute("data-owner-row") ?? e.getAttribute("data-owner-candidate"));
const chips = () => [...w.document.querySelectorAll("[data-owners-menu] .own-chip")].map((e: any) => e.textContent);

test("nothing is highlighted on open; the arrows walk the owners, then the candidates, and keep the row in view", async () => {
  await openMenu();
  expect(highlighted()).toEqual([]);
  await press("ArrowDown");
  expect(highlighted()).toEqual([`p:${ME}`]);
  await press("ArrowDown");
  await press("ArrowDown");
  expect(highlighted()).toEqual([`r:${ROLE._id}`]);
  await press("ArrowDown");
  expect(highlighted()).toEqual(["p:user_sam"]);
  expect(scrolled.at(-1)).toBe("p:user_sam");
  await press("ArrowUp");
  expect(highlighted()).toEqual([`r:${ROLE._id}`]);
});

test("Shift+Enter makes the highlighted owner driver, and adds a candidate as driver", async () => {
  await openMenu();
  await press("ArrowDown");
  await press("ArrowDown");
  await press("ArrowDown");
  await press("Enter", true);
  expect(chips()).toEqual(["Resourcing lead · driver"]);
  await press("ArrowDown");
  await press("Enter", true);
  expect(chips()).toEqual(["+ Samvit Rao · driver"]);
});

test("a touch's synthetic hover highlights nothing; a mouse's does", async () => {
  await openMenu();
  const row = w.document.querySelector("[data-owner-candidate='p:user_sam']") as HTMLElement;
  await act(async () => { row.dispatchEvent(new w.PointerEvent("pointerover", { bubbles: true, pointerType: "touch" })); });
  expect(highlighted()).toEqual([]);
  await act(async () => { row.dispatchEvent(new w.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
  expect(highlighted()).toEqual(["p:user_sam"]);
});

test("an outside tap keeps a staged change; Cancel discards it", async () => {
  await openMenu();
  await act(async () => { (w.document.querySelector("[data-owner-candidate='p:user_sam'] .own-plus") as HTMLElement).click(); });
  expect(chips()).toEqual(["+ Samvit Rao"]);
  await act(async () => { w.document.body.dispatchEvent(new w.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch" })); });
  expect(chips()).toEqual(["+ Samvit Rao"]);
  const cancel = [...w.document.querySelectorAll("[data-owners-foot] button")].find((b: any) => b.textContent === "Cancel") as HTMLElement;
  await act(async () => { cancel.click(); });
  expect(w.document.querySelector("[data-owners-menu]")).toBeNull();
  expect(applied).toEqual([]);
});

test("the only owner of an agent box's session is told why they cannot leave", async () => {
  useInboxStore.setState({
    sessions: { [ID]: { ...(useInboxStore.getState().sessions as any)[ID], user_id: "user_bot", owner_ids: [ME], org_role_id: null, driver_user_id: null } },
    sessionOwners: { [ID]: { ...(useInboxStore.getState() as any).sessionOwners[ID], role: null, runner: { user_id: "user_bot", is_bot: true }, bots: ["user_bot"], owners: [{ user_id: ME, name: "Me Person", added_at: 1 }] } },
  } as any);
  await openMenu();
  await act(async () => { (w.document.querySelector(`[data-owner-row='p:${ME}'] .own-x`) as HTMLElement).click(); });
  expect(w.document.querySelector("[data-owners-notice]")?.textContent).toBe("Add an owner before you leave");
  expect(w.document.activeElement).toBe(w.document.querySelector("[data-owners-menu] input"));
  expect(chips()).toEqual([]);
});

test("a machine is named with whose it is", () => {
  expect(machineOf("Ashot Petrosian", "Mac-mini")).toBe("Ashot's Mac-mini");
  expect(machineOf("Ashot Petrosian", "Ashot's Mac mini")).toBe("Ashot's Mac mini");
  expect(machineOf(null, "Mac-mini")).toBe("Mac-mini");
});

test("a personal session offers the viewer's own roles while a team workspace is active", async () => {
  const MINE = { _id: "role_mine", short_id: "or-9", handle: "resourcing", name: "Resourcing", status: "active", team_id: null, avatar: "fox" };
  useInboxStore.setState({
    viewerRoles: { [MINE._id]: MINE, [ROLE._id]: ROLE } as any,
    teamMembers: [member(ME, "Me Person")] as any,
    sessions: { [ID]: { ...(useInboxStore.getState().sessions as any)[ID], team_id: null, owner_ids: [ME], org_role_id: null, driver_user_id: null } },
    sessionOwners: { [ID]: { ...(useInboxStore.getState() as any).sessionOwners[ID], role: null, owners: [{ user_id: ME, name: "Me Person", added_at: 1 }] } },
  } as any);
  await openMenu();
  const candidates = [...w.document.querySelectorAll("[data-owner-candidate]")].map((e: any) => e.getAttribute("data-owner-candidate"));
  expect(candidates).toEqual(["r:role_mine"]);
  expect(w.document.querySelector("[data-owners-menu]")!.textContent).not.toContain("Nobody else to add");
});
