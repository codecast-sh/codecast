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
const id = "c".repeat(32);
const me = { _id: "me", name: "Ashot" };
const runner = { id: "jason", name: "Jason" };
const devices = [
  { device_id: "mine", label: "Ashot MacBook", platform: "darwin", online: true, is_remote: false, last_seen: Date.now(), local_project_roots: [] },
  { device_id: "remote", label: "Ashot Cloud", platform: "linux", online: true, is_remote: true, last_seen: Date.now(), local_project_roots: [] },
];
const foreign = { device_id: "theirs", label: "Jason MacBook", platform: "darwin", online: true, is_remote: false, last_seen: Date.now(), runner: { name: "Jason", is_bot: false } };
useInboxStore.setState({ currentUser: me as any, teamMembers: [me, { _id: "jason", name: "Jason" }] as any, machineRoster: devices, sessions: {}, conversations: {} });
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
const openMenu = async () => {
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
};
afterAll(async () => { await act(async () => root.unmount()); dom.window.close(); });

test("a teammate sees the machine and can claim before being an owner", async () => {
  setOwners([]);
  await render();
  expect(container.textContent).toContain("Jason MacBook");
  expect(container.textContent).toContain("Take ownership");
  expect(container.textContent).not.toContain("Assigned to you");
  await openMenu();
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.textContent).toContain("Runs under Jason’s account");
  expect(menu.textContent).toContain("Moving to your machine uses your account and billing.");
  expect(menu.textContent).toContain("Add to your inbox; keep existing owners");
  expect(menu.textContent).toContain("Ashot MacBook");
  expect(menu.textContent).not.toContain("Ashot Cloud");
  const claim = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Take ownership"))!;
  await act(async () => claim.click());
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({ name: "sessionOwnership:addSessionOwner", args: { session_id: id, owner: "me" } });
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Take ownership");
  expect(document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.textContent).toContain("Ashot");
  setOwners([{ user_id: "me", name: "Ashot" }]);
  await act(async () => mutations[0].resolve());
  await render(false, false, false);
  expect(container.textContent).toContain("Jason MacBook");
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
  expect(container.textContent).toContain("Take ownership");
  await render(false, true);
  expect(container.querySelector("button")?.title).toContain("Jason MacBook");
  expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
  await openMenu();
  expect(document.querySelector('[role="menuitem"][data-disabled]')?.textContent).toContain("Jason MacBook");
});

test("existing owners remain selected when another teammate claims", async () => {
  setOwners([{ user_id: "jason", name: "Jason" }]);
  await render();
  await openMenu();
  expect(document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.textContent).toContain("Jason");
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Take ownership");
});
