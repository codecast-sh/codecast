// THE NEWEST LINE IS IN VIEW. The card under a face holds the last 30 DM
// lines; when one more arrives it pushes the oldest out, so the count stays
// put and the list must still land on the newest line.
import type { Root } from "react-dom/client";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// The DM's server feeder and the chat router, replaced so the card reads the
// conversation the test seeds into the store.
const realChatSync = await import("../../../hooks/useChatSync");
mock.module("../../../hooks/useChatSync", () => ({ ...realChatSync, useChannelMessagesSync: () => ({}) }));
const openChat = mock(() => {});
mock.module("../../../hooks/useOpenDm", () => ({
  useOpenDm: () => () => {},
  useOpenChatPath: () => openChat,
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { FaceMessages } = await import("../FaceMessages");
const { useInboxStore } = await import("../../../store/inboxStore");
const { dmKeyFor } = await import("@codecast/shared/chat");
const { activeTeamIdOf } = await import("../../../lib/activeTeam");

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const ME = "u-me";
const ANN = "u-ann";
const DM = "chatchannels:dm-ann";

test("a new line scrolls the card's messages to the bottom, even once the card holds its full 30", async () => {
  const now = Date.now();
  const line = (i: number) => ({ _id: `m${i}`, channel_id: DM, user_id: i % 2 ? ANN : ME, content: `line ${i}`, created_at: now - 100_000 + i });
  const lines: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) lines[`m${i}`] = line(i);
  useInboxStore.setState({ currentUser: { _id: ME, name: "Me" }, chatReads: {} } as any);
  useInboxStore.setState({
    chatChannels: { [DM]: { _id: DM, kind: "dm", dm_key: dmKeyFor(activeTeamIdOf(useInboxStore.getState()) ?? "", [ME, ANN]) } },
    chatMessages: lines,
  } as any);
  const host = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  root = createRoot(host);
  const leave = mock(() => {});
  await act(async () => root!.render(<FaceMessages memberId={ANN} name="Ann" focus={false} onLeave={leave} />));
  const list = host.querySelector(".fc-list")!;
  let top = 0;
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 900 });
  Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  await act(async () => {
    useInboxStore.setState({ chatMessages: { ...lines, m30: line(30) } } as any);
  });
  expect(host.querySelectorAll(".fc-row")).toHaveLength(30);
  expect(Array.from(host.querySelectorAll(".fc-text")).at(-1)?.textContent).toBe("line 30");
  expect(top).toBe(900);
  const bubbles = host.querySelectorAll<HTMLButtonElement>("button.fc-msg");
  expect(bubbles).toHaveLength(30);
  for (const index of [0, 1, 29]) {
    await act(async () => bubbles[index].click());
    expect(openChat).toHaveBeenLastCalledWith(`/chat/${DM}?m=m${index + 1}`);
  }
  expect(leave).toHaveBeenCalledTimes(3);
  host.remove();
});
