// REPLYING FROM THE CARD KEEPS YOU WHERE YOU ARE (ct-101375). A click on a
// line in a teammate's face card must not send the whole page to chat, and the
// ↵ beside the reply box must either send the reply or not be drawn at all:
// a key picture that looks pressable and does nothing is a dead end.
import type { Root } from "react-dom/client";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const realChatSync = await import("../../../hooks/useChatSync");
mock.module("../../../hooks/useChatSync", () => ({ ...realChatSync, useChannelMessagesSync: () => ({}) }));
const openChat = mock((_path: string) => {});
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
  HTMLInputElement: dom.window.HTMLInputElement,
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
  openChat.mockClear();
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const ME = "u-me";
const ANN = "u-ann";
const DM = "chatchannels:dm-ann";

async function mountDm() {
  const now = Date.now();
  useInboxStore.setState({ currentUser: { _id: ME, name: "Me" }, chatReads: {} } as any);
  useInboxStore.setState({
    chatChannels: { [DM]: { _id: DM, kind: "dm", dm_key: dmKeyFor(activeTeamIdOf(useInboxStore.getState()) ?? "", [ME, ANN]) } },
    chatMessages: {
      a: { _id: "a", channel_id: DM, user_id: ANN, content: "from ann", created_at: now - 3000 },
      b: { _id: "b", channel_id: DM, user_id: ME, content: "from me", created_at: now - 1000 },
    },
  } as any);
  const sent: unknown[][] = [];
  useInboxStore.setState({ sendChatMessage: (...args: unknown[]) => void sent.push(args) } as any);
  const host = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  root = createRoot(host);
  const leave = mock(() => {});
  await act(async () => root!.render(<FaceMessages memberId={ANN} name="Ann" focus={false} onLeave={leave} />));
  return { host, leave, sent };
}

test("clicking a message line in the card leaves the page where it is", async () => {
  const { host, leave } = await mountDm();
  const lines = host.querySelectorAll<HTMLElement>(".fc-msg");
  expect(lines.length).toBe(2);
  for (const line of Array.from(lines)) {
    await act(async () => line.click());
  }
  expect(leave).not.toHaveBeenCalled();
  expect(openChat).not.toHaveBeenCalled();
  host.remove();
});

test("the ↵ beside the reply box sends the reply, or is not drawn at all", async () => {
  const { host, sent } = await mountDm();
  const reply = host.querySelector(".fc-reply")!;
  const sendButton = reply.querySelector<HTMLButtonElement>("button[aria-label*='end' i]");
  if (!sendButton) {
    // Removing it is allowed; an inert key picture is not.
    expect(reply.textContent ?? "").not.toContain("↵");
    host.remove();
    return;
  }
  const input = reply.querySelector<HTMLInputElement>("input")!;
  await act(async () => sendButton.click());
  expect(sent).toHaveLength(0);
  input.value = "on my way";
  await act(async () => sendButton.click());
  expect(sent).toEqual([[DM, "on my way"]]);
  expect(input.value).toBe("");
  expect(openChat).not.toHaveBeenCalled();
  host.remove();
});
