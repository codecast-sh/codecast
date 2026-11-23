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

// The owners menu by keyboard and by touch: nothing is highlighted on open;
// the arrows walk the owners and then the candidates, keeping the highlighted
// row in view; Shift+Enter resumes a paused role; a touch's synthetic hover
// highlights nothing; the only owner's × says why it cannot leave; an outside
// tap keeps a staged change.
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

// People are never shown driving; the role is Active or Paused, and a paused
// role offers Resume, and Shift+Enter takes it from anywhere but another
// owner's row. Nothing else takes Shift+Enter.
test("people rows say nothing of driving; the paused role says Paused and offers Resume", async () => {
  await openMenu();
  const rowText = (key: string) => (w.document.querySelector(`[data-owner-row='${key}']`) as HTMLElement).textContent;
  expect(rowText(`p:${ME}`)).not.toMatch(/driv/i);
  expect(rowText("p:user_ashot")).not.toMatch(/driv/i);
  expect(rowText(`r:${ROLE._id}`)).toContain("Paused");
  expect([...w.document.querySelectorAll("[data-owner-resume]")].map((e: any) => e.closest("[data-owner-row]").getAttribute("data-owner-row"))).toEqual([`r:${ROLE._id}`]);
  expect(w.document.querySelector("[data-owners-menu]")!.textContent).not.toMatch(/driver/i);
  await act(async () => { (w.document.querySelector("[data-owner-resume]") as HTMLElement).click(); });
  expect(chips()).toEqual(["Resume @lead"]);
  expect(rowText(`r:${ROLE._id}`)).toContain("Active");
  expect(w.document.querySelector("[data-owner-resume]")).toBeNull();
});

test("Shift+Enter resumes a paused role the moment the menu opens, with nothing highlighted", async () => {
  await openMenu();
  expect(highlighted()).toEqual([]);
  await press("Enter", true);
  expect(chips()).toEqual(["Resume @lead"]);
});

test("Shift+Enter does nothing on a person's row, and resumes the role from a candidate's", async () => {
  await openMenu();
  await press("ArrowDown");
  await press("ArrowDown");
  await press("Enter", true);
  expect(chips()).toEqual([]);
  await press("ArrowDown");
  await press("ArrowDown");
  expect(highlighted()).toEqual(["p:user_sam"]);
  await press("Enter", true);
  expect(chips()).toEqual(["Resume @lead"]);
  await press("Enter");
  expect(chips()).toEqual(["+ Samvit Rao", "Resume @lead"]);
});

test("a candidate has + only; adding a role replaces the current one, Active", async () => {
  useInboxStore.setState({ orgTree: { workspace: { kind: "team", id: TEAM }, roles: [ROLE, { ...ROLE, _id: "role_ops", short_id: "or-2", handle: "ops", name: "Ops lead" }], anchors: [], people: [] } } as any);
  await openMenu();
  expect(w.document.querySelector("[data-owner-candidate] [data-owner-resume]")).toBeNull();
  expect(w.document.querySelector("[data-owner-candidates]")!.textContent).not.toMatch(/driver/i);
  await act(async () => { (w.document.querySelector("[data-owner-candidate='r:role_ops'] .own-plus") as HTMLElement).click(); });
  expect(chips()).toEqual(["+ Ops lead", "− Resourcing lead"]);
  expect((w.document.querySelector("[data-owner-row='r:role_ops']") as HTMLElement).textContent).toContain("Active");
});

test("a search with no match highlights nothing: Enter adds nobody, Shift+Enter still resumes the role", async () => {
  await openMenu();
  const input = w.document.querySelector("[data-owners-menu] input") as HTMLInputElement;
  const props = (input as any)[Object.keys(input).find((k) => k.startsWith("__reactProps$"))!];
  await act(async () => { props.onChange({ target: { value: "zzzq" } }); });
  expect(w.document.querySelector("[data-owners-menu]")!.textContent).toContain("Nobody matches");
  expect(highlighted()).toEqual([]);
  await press("Enter");
  expect(chips()).toEqual([]);
  await press("Enter", true);
  expect(chips()).toEqual(["Resume @lead"]);
});

test("the search box takes focus on open with a mouse, not on a touch screen", async () => {
  await openMenu();
  expect(w.document.activeElement).toBe(w.document.querySelector("[data-owners-menu] input"));
  await act(async () => { root?.unmount(); });
  const before = w.matchMedia;
  w.matchMedia = (q: string) => ({ matches: q === "(pointer: coarse)", media: q, addEventListener() {}, removeEventListener() {} });
  try {
    await openMenu();
    expect(w.document.activeElement).not.toBe(w.document.querySelector("[data-owners-menu] input"));
  } finally {
    w.matchMedia = before;
  }
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

test("leaving a session on your own account picks a machine first, unless a role started it", async () => {
  await openMenu();
  await act(async () => { (w.document.querySelector(`[data-owner-row='p:${ME}'] .own-x`) as HTMLElement).click(); });
  expect(chips()).toEqual([]);
  expect(w.document.querySelector("[data-leave-box]")).not.toBeNull();
  await act(async () => { root?.unmount(); });
  host?.remove();

  useInboxStore.setState({ sessionOwners: { [ID]: { ...(useInboxStore.getState() as any).sessionOwners[ID], role_started: true } } } as any);
  await openMenu();
  await act(async () => { (w.document.querySelector(`[data-owner-row='p:${ME}'] .own-x`) as HTMLElement).click(); });
  // The read gives no team access here, so the leave has no undo, and says so.
  expect(chips()).toEqual(["You leave · can't undo"]);
  expect(w.document.querySelector("[data-leave-box]")).toBeNull();
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

test("leaving keeps you out of the candidates, and its chips say where it goes and that it cannot be undone", async () => {
  // My run, with Ashot; Aivery's agent box is a team machine to move it to.
  const key = `${ME}:user:agentBoxes`;
  useInboxStore.setState({
    sessions: { [ID]: { ...(useInboxStore.getState().sessions as any)[ID], org_role_id: null, driver_user_id: ME } },
    sessionOwners: { [ID]: { ...(useInboxStore.getState() as any).sessionOwners[ID], role: null } },
    teamMembers: [member(ME, "Me Person"), member("user_ashot", "Ashot Petrosian"), member("user_sam", "Samvit Rao"), { _id: "user_bot", name: "Aivery", is_bot: true, roster_team: TEAM }] as any,
    settingsData: { ...(useInboxStore.getState() as any).settingsData, [key]: { _id: key, value: [{ device_id: "box1", owner_user_id: "user_bot", runner_name: "Aivery", is_bot: true, label: "Mac-mini", platform: "darwin", is_remote: false, online: true, last_seen: 1, local_project_roots: [] }] } },
  } as any);
  await openMenu();
  await act(async () => { (w.document.querySelector(`[data-owner-row='p:${ME}'] .own-x`) as HTMLElement).click(); });
  await act(async () => { (w.document.querySelector("[data-leave-target='box1']") as HTMLElement).click(); });
  expect(chips()).toEqual(["You leave · can't undo", "Move to Aivery's Mac-mini"]);
  const candidates = [...w.document.querySelectorAll("[data-owner-candidate]")].map((e: any) => e.getAttribute("data-owner-candidate"));
  expect(candidates).not.toContain(`p:${ME}`);
  // Select all teammates adds the others, never you: the leave stands.
  await act(async () => { (w.document.querySelector("[data-select-all-teammates]") as HTMLElement).click(); });
  expect(chips()).toEqual(["+ Samvit Rao", "You leave · can't undo", "Move to Aivery's Mac-mini"]);
});

test("a leave that can be undone (a teammate's run the team shares) needs no warning", async () => {
  useInboxStore.setState({
    sessions: { [ID]: { ...(useInboxStore.getState().sessions as any)[ID], user_id: "user_ashot", org_role_id: null, driver_user_id: "user_ashot" } },
    sessionOwners: { [ID]: { ...(useInboxStore.getState() as any).sessionOwners[ID], role: null, team_access: true, runner: { user_id: "user_ashot", is_bot: false } } },
  } as any);
  await openMenu();
  await act(async () => { (w.document.querySelector(`[data-owner-row='p:${ME}'] .own-x`) as HTMLElement).click(); });
  expect(chips()).toEqual(["You leave"]);
});
