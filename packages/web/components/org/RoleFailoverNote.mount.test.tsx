// The owner's failover line on the role page (convex roleFailover.ts):
// from, to, why and the billing change in structure; Move back goes through
// the consequential review only when it changes who the role bills under;
// a stuck role names the host and offers no move.
// Run: bun test components/org/RoleFailoverNote.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.test/org/or-1", pretendToBeVisual: true });
const restore = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent, FocusEvent: dom.window.FocusEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restore(); });

const React = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RoleFailoverNote } = await import("./RoleFailoverNote");

const base = { at: 1, reason: "offline" as const, owner_user_id: "me", from: { device_id: "mac", label: "Jason's MacBook", user_id: "jason" }, to: { device_id: "c1", label: "cloud-1", user_id: "me" } };
const nameOf = (id: string) => (id === "jason" ? "Jason" : "someone");

async function mount(failover: any, onMoveBack?: () => void, back: "ok" | "offline" | "not_yours" | null = "ok") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(RoleFailoverNote, { role: { handle: "agent-quality", name: "Agent Quality" }, failover, viewerId: "me", nameOf, onMoveBack, back })); });
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("a move that changed billing shows it, and Move back asks first", async () => {
  let moved = 0;
  const { host, unmount } = await mount({ ...base, cross_user: true }, () => moved++);
  expect(host.querySelector("[data-failover-from]")?.textContent).toBe("Jason's MacBook");
  expect(host.querySelector("[data-failover-to]")?.textContent).toBe("cloud-1");
  expect(host.querySelector("[data-failover-bills]")?.textContent).toBe("bills under you");
  await act(async () => { (host.querySelector("[data-failover-back]") as HTMLButtonElement).click(); });
  expect(moved).toBe(0);
  const review = document.querySelector("[data-switch-review]");
  expect(review?.getAttribute("data-switch-review")).toBe("Move @agent-quality back");
  expect(review?.textContent).toContain("Jason");
  const confirm = review!.querySelector("[data-switch-confirm]") as HTMLButtonElement;
  expect(confirm.textContent).toStartWith("Move back");
  await act(async () => { confirm.click(); });
  expect(moved).toBe(1);
  await unmount();
});

test("a move on the same account moves back in one press", async () => {
  let moved = 0;
  const { host, unmount } = await mount(base, () => moved++);
  expect(host.querySelector("[data-failover-bills]")).toBeNull();
  await act(async () => { (host.querySelector("[data-failover-back]") as HTMLButtonElement).click(); });
  expect(moved).toBe(1);
  await unmount();
});

test("stuck names the host, and offers no move", async () => {
  const { host, unmount } = await mount({ ...base, to: undefined }, () => {});
  expect(host.querySelector("[data-head-failover]")?.getAttribute("data-head-failover")).toBe("stuck");
  expect(host.textContent).toContain("no always-on machine");
  expect(host.querySelector("[data-failover-back]")).toBeNull();
  await unmount();
});

test("a host the viewer may not use names who can, with no button", async () => {
  const { host, unmount } = await mount({ ...base, cross_user: true }, () => {}, "not_yours");
  expect(host.querySelector("[data-failover-back]")).toBeNull();
  expect(host.querySelector("[data-failover-back-who]")?.textContent).toBe("Only Jason can move it back to Jason's MacBook");
  await unmount();
});

test("a host still offline holds the button and marks the host", async () => {
  let moved = 0;
  const { host, unmount } = await mount(base, () => moved++, "offline");
  const button = host.querySelector("[data-failover-back]") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(host.querySelector("[data-failover-from-offline]")?.textContent).toBe("offline");
  await act(async () => { button.click(); });
  expect(moved).toBe(0);
  await unmount();
});

test("a viewer who may not move it sees the line without the button", async () => {
  const { host, unmount } = await mount(base, undefined);
  expect(host.querySelector("[data-failover-back]")).toBeNull();
  await unmount();
});
