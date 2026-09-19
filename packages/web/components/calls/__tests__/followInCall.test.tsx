import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { setGestureChannelFactory } from "../../../store/gestureBridge";

import { closeDomWindow } from "../../../test-helpers/domGlobals";
const realCallManager = { ...(await import("../../../lib/calls/callManager")) };
mock.module("../../../lib/calls/callManager", () => ({ ...realCallManager, getRoom: () => null }));
const { useInboxStore } = await import("../../../store/inboxStore");
const { FollowChip } = await import("../FollowInCall");

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
// The bridge posts on every follow change; a null channel keeps the test silent.
setGestureChannelFactory(() => null);
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
  setGestureChannelFactory(null);
  mock.module("../../../lib/calls/callManager", () => realCallManager);
});
afterEach(() => {
  useInboxStore.setState({ followLeaderId: null, followBlocked: false, followedBy: [], currentUser: null } as any);
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

test("a remote person's chip follows them, then offers to stop", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" } } as any);
  const r = await render(<FollowChip identity="u-ann" name="Ann Lee" variant="tile" always />);
  const btn = r.container.querySelector("button[data-sv-call-follow]") as HTMLButtonElement;
  expect(btn.dataset.svCallFollow).toBe("follow");
  expect(btn.textContent).toContain("Follow");
  await act(() => { btn.click(); });
  expect(useInboxStore.getState().followLeaderId).toBe("u-ann");
  expect((r.container.querySelector("button[data-sv-call-follow]") as HTMLButtonElement).dataset.svCallFollow).toBe("following");
  await act(() => { (r.container.querySelector("button[data-sv-call-follow]") as HTMLButtonElement).click(); });
  expect(useInboxStore.getState().followLeaderId).toBeNull();
  await r.unmount();
});

test("my own tile shows how many follow me, and nothing when nobody does", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" } } as any);
  const r = await render(<FollowChip identity="u-me" name="Me" variant="tile" />);
  expect(r.container.querySelector("[data-sv-call-follow]")).toBeNull();
  await act(() => { useInboxStore.getState().setFollowedBy([{ user_id: "a", name: "Ann" }, { user_id: "b", name: "Bob" }]); });
  expect(r.container.querySelector("[data-sv-call-follow='followers']")?.textContent).toBe("2 following you");
  await r.unmount();
});
