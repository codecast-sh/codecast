import { afterAll, expect, test, mock } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: dom.window.MouseEvent });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");
const convex = await import("convex/react");
const replies = new Map<string, any>();
const mutations: Array<{ name: string; args: any; resolve: () => void }> = [];
mock.module("convex/react", () => ({
  ...convex,
  useQueries: (queries: Record<string, any>) => Object.fromEntries(Object.entries(queries).map(([key, request]) => [key, replies.get(getFunctionName(request.query))])),
  useMutation: (query: any) => (args: any) => new Promise<void>((resolve) => { mutations.push({ name: getFunctionName(query), args, resolve }); }),
}));
const { useInboxStore } = await import("../../../store/inboxStore");
const { ConversationAssignmentBadge } = await import("../../AssignmentBadge");
const { withTeamRoster } = await import("../../../test-helpers/teamRoster");
const id = "c".repeat(32);
const me = { _id: "me", name: "Ashot" };
const runner = { id: "jason", name: "Jason" };
const devices = [
  { device_id: "mine", label: "Ashot MacBook", platform: "darwin", online: true, is_remote: false, last_seen: Date.now(), local_project_roots: [] },
  { device_id: "remote", label: "Ashot Cloud", platform: "linux", online: true, is_remote: true, last_seen: Date.now(), local_project_roots: [] },
];
const foreign = { device_id: "theirs", label: "Jason MacBook", platform: "darwin", online: true, is_remote: false, last_seen: Date.now(), runner: { name: "Jason", is_bot: false } };
useInboxStore.setState({
  currentUser: me as any,
  ...withTeamRoster([me, { _id: "jason", name: "Jason" }], { clientState: useInboxStore.getState().clientState }),
  machineRoster: devices,
  sessions: {},
  conversations: { [id]: { _id: id, user_id: runner.id } },
});
replies.set("devices:listDevices", devices);
replies.set("devices:ownerDeviceDisplay", foreign);
replies.set("sessionOwnership:listOwnerCandidates", { team_members: [me, { _id: "jason", name: "Jason" }] });
const container = document.getElementById("root")!;
const root = createRoot(container);
// listOwners as the server answers it (sessionOwnership.performListOwners).
const ownersReply = (owners: any[], extra: Record<string, any> = {}) => ({
  conversation_id: id, short_id: "jx1", owners, owner_ids: owners.map((o) => o.user_id), role: null,
  runner: null, author_id: null, bots: [], can_edit: true, ...extra,
});
const setOwners = (owners: any[], extra: Record<string, any> = {}) => replies.set("sessionOwnership:listOwners", ownersReply(owners, extra));
let generation = 0;
const render = async (isOwner = false, compact = false, reset = true, guest = false) => {
  if (reset) generation++;
  await act(async () => { root.render(<ConversationAssignmentBadge key={generation} conversation={{ _id: id, user_id: runner.id, owner_device_id: "theirs", user: { name: runner.name } }} guest={guest} isOwner={isOwner} compact={compact} />); });
};
const ownersSeg = () => container.querySelector<HTMLButtonElement>("[data-owners-seg]");
afterAll(async () => { await act(async () => root.unmount()); dom.window.close(); });

// With no owner rows the server names the human who started it (Jason).
const starterOnly = () => setOwners([{ user_id: "jason", name: "Jason" }]);

test("a teammate sees the machine and can claim before being an owner", async () => {
  starterOnly();
  await render();
  expect(container.textContent).toContain("Jason MacBook");
  expect(container.textContent).not.toContain("Take ownership");
  expect(container.textContent).not.toContain("Assigned to you");
  expect(ownersSeg()?.title).toMatch(/Owners: Jason/);
});

test("share-only viewers and failed permission reads get no assignment controls", async () => {
  // A refusal or a failure hides the controls even over a cached row; a row
  // cached from before paints while the answer is still on its way.
  for (const reply of [null, new Error("Permission lookup unavailable")]) {
    replies.set("sessionOwnership:listOwners", reply);
    await render();
    expect(container.textContent).toContain("Jason");
    expect(container.textContent).not.toContain("Take ownership");
    expect(container.querySelector("button")).toBeNull();
  }
});

test("a server denial overrides even a stale owner flag", async () => {
  replies.set("sessionOwnership:listOwners", null);
  await render(true);
  expect(container.querySelector("button")).toBeNull();
});

test("guests never receive machine or ownership controls", async () => {
  starterOnly();
  await render(true, false, true, true);
  expect(container.textContent).toContain("Jason");
  expect(container.textContent).not.toContain("Jason MacBook");
  expect(container.querySelector("button")).toBeNull();
});

test("a viewer with no registered devices still sees the foreign machine", async () => {
  replies.set("devices:listDevices", []);
  await act(async () => useInboxStore.setState({ machineRoster: [] }));
  starterOnly();
  await render();
  expect(container.textContent).toContain("Jason MacBook");
  expect(container.textContent).not.toContain("Take ownership");
  await render(false, true);
  expect(container.querySelector("[data-runner-device]")?.getAttribute("title")).toContain("Jason MacBook");
  expect(ownersSeg()?.title).toMatch(/Owners: Jason/);
  expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(1);
});

test("owners are faces on the chip, named on hover", async () => {
  useInboxStore.setState({ conversations: { [id]: { _id: id, user_id: "me" } } });
  setOwners([{ user_id: "me", name: "Ashot" }]);
  await render(true);
  expect(ownersSeg()!.title).toMatch(/Owners: Ashot/);
  expect(ownersSeg()!.textContent).not.toContain("Ashot");
  expect(container.textContent).not.toContain("Take ownership");
  useInboxStore.setState({ conversations: { [id]: { _id: id, user_id: runner.id } } });
});

test("the driver is ringed and a paused role greyed", async () => {
  // The role and the driver live on the session row; the owners row carries the role's face.
  useInboxStore.setState({ conversations: { [id]: { _id: id, user_id: runner.id, org_role_id: "role1", driver_user_id: "me" } } });
  setOwners([{ user_id: "me", name: "Ashot" }], {
    role: { role_id: "role1", short_id: "or-1", handle: "evals", name: "Eval Suite lead", avatar: null },
  });
  await render(true);
  expect(ownersSeg()!.title).toBe("Owners: Ashot (driver), Eval Suite lead (paused)");
  expect(ownersSeg()!.querySelectorAll(".own-drv").length).toBe(1);
  expect(ownersSeg()!.querySelectorAll(".own-paused").length).toBe(1);
  useInboxStore.setState({ conversations: { [id]: { _id: id, user_id: runner.id } } });
});

test("existing owners remain selected when another teammate claims", async () => {
  setOwners([{ user_id: "jason", name: "Jason" }]);
  await render();
  expect(ownersSeg()?.title).toMatch(/Owners: Jason/);
});

const openOwnersMenu = async () => {
  await act(async () => { ownersSeg()!.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })); ownersSeg()!.click(); });
  return document.querySelector<HTMLElement>("[data-owners-menu]");
};
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };

test("leaving a session that runs on your account asks where to move it first", async () => {
  useInboxStore.setState({ conversations: { [id]: { _id: id, user_id: "me" } } });
  setOwners([{ user_id: "me", name: "Ashot" }, { user_id: "jason", name: "Jason" }], {
    runner: { user_id: "me", name: "Ashot", email: null, is_bot: false },
  });
  await render(true);
  const menu = await openOwnersMenu();
  expect(menu).not.toBeNull();
  expect(menu!.querySelector("[data-leave-box]")).toBeNull();
  await click(menu!.querySelector('[aria-label="Leave"]'));
  const box = document.querySelector("[data-leave-box]");
  expect(box?.textContent).toContain("Runs on your account");
  // No team machine in this roster: it says so rather than offering nothing.
  expect(box?.textContent).toContain("No team machine to move it to");
  // Still an owner until a machine is picked: nothing staged.
  expect(document.querySelector("[data-owners-save]")?.hasAttribute("disabled")).toBe(true);
  await act(async () => root.render(<></>));
});

test("Save sends the whole staged change once, and the faces follow at once", async () => {
  const dispatched: any[] = [];
  const real = useInboxStore.getState().applySessionOwners;
  useInboxStore.setState({ applySessionOwners: ((...args: any[]) => { dispatched.push(args); return (real as any)(...args); }) as any });
  useInboxStore.setState({ conversations: { [id]: { _id: id, user_id: runner.id } } });
  setOwners([{ user_id: "jason", name: "Jason" }], {
    runner: { user_id: "jason", name: "Jason", email: null, is_bot: false },
  });
  await render(true);
  await openOwnersMenu();
  await click(document.querySelector('[aria-label="Add Ashot"]'));
  expect([...document.querySelectorAll(".own-chip")].map((c) => c.textContent)).toEqual(["+ Ashot"]);
  await click(document.querySelector("[data-owners-save]"));
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0][1]).toEqual({ add: ["me"] });
  // Undo takes the person back off.
  expect(dispatched[0][2]).toEqual({ remove: ["me"] });
  // Each fact in its home, by the server's own rule: the people on the owners
  // row, and the wheel pinned to Jason on the session row (adding never hands it over).
  expect((useInboxStore.getState() as any).sessionOwners[id].owner_ids).toEqual(["jason", "me"]);
  expect((useInboxStore.getState() as any).conversations[id].driver_user_id).toBe("jason");
  expect(ownersSeg()!.title).toBe("Owners: Jason (driver), Ashot");
  // The server echoes the Save: the pending view settles and goes.
  setOwners([{ user_id: "jason", name: "Jason" }, { user_id: "me", name: "Ashot" }]);
  await render(true, false, false);
  useInboxStore.setState({ applySessionOwners: real });
});

test("Select all teammates stages every non-owner, then hides itself", async () => {
  const dispatched: any[] = [];
  const real = useInboxStore.getState().applySessionOwners;
  useInboxStore.setState({ applySessionOwners: ((...args: any[]) => { dispatched.push(args); return (real as any)(...args); }) as any });
  setOwners([{ user_id: "jason", name: "Jason" }], {
    runner: { user_id: "jason", name: "Jason", email: null, is_bot: false },
  });
  await render(true);
  await openOwnersMenu();
  await click(document.querySelector("[data-select-all-teammates]"));
  expect(document.querySelector("[data-select-all-teammates]")).toBeNull();
  await click(document.querySelector("[data-owners-save]"));
  expect(dispatched[0][1]).toEqual({ add: ["me"] });
  // The server echoes the Save, which releases the row's held fields.
  setOwners([{ user_id: "jason", name: "Jason" }, { user_id: "me", name: "Ashot" }]);
  await render(true, false, false);
  useInboxStore.setState({ applySessionOwners: real });
});

test("a teammate who only sees the session reads the owners and can only claim it", async () => {
  setOwners([{ user_id: "jason", name: "Jason" }], { can_edit: false });
  await render(false);
  const menu = await openOwnersMenu();
  expect(menu?.textContent).toContain("Jason");
  expect(menu!.querySelector('[aria-label="Remove Jason"]')).toBeNull();
  expect(menu!.querySelector("[data-owners-save]")).toBeNull();
  expect(menu!.querySelector("[data-owner-candidates]")).toBeNull();
  expect(menu!.querySelector("[data-take-ownership]")).not.toBeNull();
  await act(async () => root.render(<></>));
});
