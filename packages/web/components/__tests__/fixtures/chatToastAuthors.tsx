import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { replaceGlobals } from "../../../test-helpers/globals";
import { realInboxStore, restoreInboxStoreAfterAll } from "../mockInboxStore";
import type { ChatToastData } from "../../../components/chat/ChatToast";

restoreInboxStoreAfterAll();
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const restore = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { dom.window.close(); restore(); });
document.hasFocus = () => true;
const useInboxStore = create<any>(() => ({}));
mock.module("../../../store/inboxStore", () => ({
  ...realInboxStore,
  useInboxStore,
  useTrackedStore: () => useInboxStore(),
}));
const router = { push() {} };
mock.module("next/navigation", () => ({ useRouter: () => router }));
mock.module("../../../lib/sounds", () => ({ soundChatMessage() {} }));
type ToastElement = React.ReactElement<{ data: ChatToastData }>;
const toasts: Array<() => ToastElement> = [];
mock.module("sonner", () => ({ toast: { custom: (render: () => ToastElement) => toasts.push(render) } }));
const { useChatToasts } = await import("../../../hooks/useChatToasts");
const { markChatRailLive } = await import("../../../lib/chatLive");
markChatRailLive();

const aivery = { name: "Aivery", avatar_url: "https://a/aivery.png", is_bot: true };
const cases = [
  { label: "unopened channel", rail: aivery, full: undefined, name: "Aivery", avatar: aivery.avatar_url, agent: false },
  { label: "loaded message with an older rail", rail: undefined, full: aivery, name: "Aivery", avatar: aivery.avatar_url, agent: false },
  { label: "loaded sender takes precedence", rail: { name: "Old name" }, full: aivery, name: "Aivery", avatar: aivery.avatar_url, agent: false },
  { label: "partial cached message", rail: aivery, full: {}, name: "Aivery", avatar: aivery.avatar_url, agent: false },
  { label: "Slack sender without an avatar", rail: { name: "Aivery" }, full: undefined, name: "Aivery", avatar: undefined, agent: false },
  { label: "ordinary teammate", rail: undefined, full: undefined, name: "Dana", avatar: "https://a/dana.png", agent: false },
  { label: "codecast agent", rail: undefined, full: undefined, name: "Anchor", avatar: undefined, agent: true },
];

for (const c of cases) test(c.label, async () => {
  const userId = c.name === "Dana" ? "dana" : c.name === "Anchor" ? "anchor" : "bridge";
  const channelId = `channel-${c.label}`;
  const last = { _id: "previous", user_id: userId, created_at: Date.now(), preview: "Confirmed, thank you.", external_author: c.rail };
  const row = { channel_id: channelId, last_message: last, unread: 0, unread_mentions: 0, notify_level: "all", joined: true, sort_at: Date.now() };
  useInboxStore.setState({
    currentUser: { _id: "viewer" },
    chatRail: [row],
    chatMessages: {},
    chatChannels: { [channelId]: { name: "team", kind: "channel" } },
    teamMembers: [
      { _id: "bridge", name: "Union (Slack)", is_bot: true, image: "https://a/bridge.png" },
      { _id: "dana", name: "Dana", image: "https://a/dana.png" },
      { _id: "anchor", name: "Anchor", is_bot: true },
    ],
    clientState: { ui: {} },
  });
  toasts.length = 0;
  function Probe() { useChatToasts(); return null; }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(toasts).toHaveLength(0);
    await act(async () => useInboxStore.setState({
      chatRail: [{ ...row, last_message: { ...last, _id: "arrival" }, unread: 1 }],
      chatMessages: c.full ? { arrival: { ...last, _id: "arrival", content: last.preview, external_author: "name" in c.full ? c.full : undefined } } : {},
    }));
    expect(toasts).toHaveLength(1);
    const popup = toasts[0]();
    expect(popup.props.data.authorName).toBe(c.name);
    expect(popup.props.data.authorAvatarUrl).toBe(c.avatar);
    expect(popup.props.data.authorIsAgent).toBe(c.agent);
    await act(async () => root.render(popup));
    expect(host.querySelector(".ch-toast-author")?.textContent).toBe(c.name);
    expect(host.textContent).not.toContain("Union (Slack)");
    expect(host.querySelector(".ch-toast-preview")?.textContent).toBe("Confirmed, thank you.");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

// A huddle's digest is written under its scribe's account because the
// transcript is theirs. The card names the huddle and wears the call badge,
// whether only the rail says it is a call or the full row is already cached.
for (const where of ["rail", "cached row"] as const) test(`huddle digest from the ${where} names the huddle, not its scribe`, async () => {
  const channelId = `dm-huddle-${where}`;
  const content = "**Team member out sick** · 1 min huddle with Cam and Ashot\n\nTesting issue noted.";
  const last = { _id: "before", user_id: "cam", created_at: Date.now(), preview: "Earlier line" };
  const row = { channel_id: channelId, last_message: last, unread: 0, unread_mentions: 0, notify_level: "all", joined: true, sort_at: Date.now() };
  useInboxStore.setState({
    currentUser: { _id: "viewer" },
    chatRail: [row],
    chatMessages: {},
    chatChannels: { [channelId]: { name: "", kind: "dm", dm_key: "team:cam:viewer" } },
    teamMembers: [{ _id: "cam", name: "Cam", image: "https://a/cam.png" }],
    clientState: { ui: {} },
  });
  toasts.length = 0;
  function Probe() { useChatToasts(); return null; }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    const digest = { _id: "digest", user_id: "cam", created_at: Date.now(), preview: "Team member out sick · 1 min huddle with Cam and Ashot" };
    await act(async () => useInboxStore.setState({
      chatRail: [{ ...row, last_message: where === "rail" ? { ...digest, call: true } : digest }],
      chatMessages: where === "rail" ? {} : { digest: { ...digest, channel_id: channelId, content, call: { transcript_id: "t1" } } },
    }));
    expect(toasts).toHaveLength(1);
    const popup = toasts[0]();
    expect(popup.props.data.isCall).toBe(true);
    expect(popup.props.data.authorName).toBe("Huddle");
    expect(popup.props.data.authorAvatarUrl).toBeUndefined();
    await act(async () => root.render(popup));
    expect(host.querySelector(".ch-toast-author")?.textContent).toBe("Huddle");
    expect(host.querySelector(".ch-toast-call")).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".ch-toast-preview")?.textContent).toContain("1 min huddle with Cam and Ashot");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
