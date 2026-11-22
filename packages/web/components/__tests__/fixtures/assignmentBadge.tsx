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
const setOwners = (owners: any[]) => replies.set("sessionOwnership:listOwners", { conversation_id: id, owners });
let generation = 0;
const render = async (isOwner = false, compact = false, reset = true, guest = false) => {
  if (reset) generation++;
  await act(async () => { root.render(<ConversationAssignmentBadge key={generation} conversation={{ _id: id, user_id: runner.id, owner_device_id: "theirs", user: { name: runner.name } }} guest={guest} isOwner={isOwner} compact={compact} />); });
};
const ownersSeg = () => container.querySelector<HTMLButtonElement>("[data-owners-seg]");
afterAll(async () => { await act(async () => root.unmount()); dom.window.close(); });

test("a teammate sees the machine and can claim before being an owner", async () => {
  setOwners([]);
  await render();
  expect(container.textContent).toContain("Jason MacBook");
  expect(container.textContent).not.toContain("Take ownership");
  expect(container.textContent).not.toContain("Assigned to you");
  expect(ownersSeg()?.title).toMatch(/Owners: Jason/);
});

test("share-only viewers and failed permission reads get no assignment controls", async () => {
  for (const reply of [null, new Error("Permission lookup unavailable"), undefined]) {
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
  setOwners([]);
  await render(true, false, true, true);
  expect(container.textContent).toContain("Jason");
  expect(container.textContent).not.toContain("Jason MacBook");
  expect(container.querySelector("button")).toBeNull();
});

test("a viewer with no registered devices still sees the foreign machine", async () => {
  replies.set("devices:listDevices", []);
  await act(async () => useInboxStore.setState({ machineRoster: [] }));
  setOwners([]);
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
  replies.set("sessionOwnership:listOwners", {
    conversation_id: id,
    owners: [{ user_id: "me", name: "Ashot" }],
    role: { role_id: "role1", short_id: "or-1", handle: "evals", name: "Eval Suite lead", avatar: null },
    driver: { kind: "user", user_id: "me" },
  });
  await render(true);
  expect(ownersSeg()!.title).toBe("Owners: Ashot (driver), Eval Suite lead (paused)");
  expect(ownersSeg()!.querySelectorAll(".own-drv").length).toBe(1);
  expect(ownersSeg()!.querySelectorAll(".own-paused").length).toBe(1);
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
  replies.set("sessionOwnership:listOwners", {
    conversation_id: id,
    owners: [{ user_id: "me", name: "Ashot" }, { user_id: "jason", name: "Jason" }],
    role: null,
    driver: { kind: "user", user_id: "me" },
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
  useInboxStore.setState({ applySessionOwners: (async (...args: any[]) => { dispatched.push(args); return undefined; }) as any });
  useInboxStore.setState({ conversations: { [id]: { _id: id, user_id: runner.id } } });
  replies.set("sessionOwnership:listOwners", {
    conversation_id: id,
    owners: [{ user_id: "jason", name: "Jason" }],
    role: null,
    driver: { kind: "user", user_id: "jason" },
    runner: { user_id: "jason", name: "Jason", email: null, is_bot: false },
  });
  await render(true);
  await openOwnersMenu();
  await click(document.querySelector('[aria-label="Add Ashot"]'));
  expect([...document.querySelectorAll(".own-chip")].map((c) => c.textContent)).toEqual(["+ Ashot"]);
  await click(document.querySelector("[data-owners-save]"));
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0][1]).toEqual({ add: ["me"] });
  expect(dispatched[0][2]).toEqual({ remove: ["me"], driver: { kind: "user", user_id: "jason" } });
  expect(ownersSeg()!.title).toBe("Owners: Jason (driver), Ashot");
  useInboxStore.setState({ applySessionOwners: real });
});
