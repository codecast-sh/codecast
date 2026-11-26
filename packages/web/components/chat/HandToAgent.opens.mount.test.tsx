import assert from "node:assert/strict";
import { afterAll, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { ChatMessageView } from "./chatTypes";

// ct-102011: after a person hands a chat thread to an agent and presses Start
// agent, the app must open the session it just started. HandToAgentReview
// hands the new session's id to onClose; both callers (a message's "Hand to
// agent" menu item and the composer's "Hand to agent" send) must act on it.
// Cancelling the review must navigate nowhere.

const STUB = "stub-hand-session-1";
const DEVICE = { device_id: "dev1", online: true, label: "macOS box", hostname: "box" };

const realMachines = { ...(await import("../../hooks/useSessionMachines")) };
mock.module("../../hooks/useSessionMachines", () => ({ ...realMachines, useSessionMachines: () => [DEVICE] }));
const realLocal = { ...(await import("../../hooks/useLocalDeviceId")) };
mock.module("../../hooks/useLocalDeviceId", () => ({ ...realLocal, useLocalDeviceId: () => DEVICE.device_id }));
const realPicker = { ...(await import("../ProjectPathPicker")) };
const React0 = await import("react");
mock.module("../ProjectPathPicker", () => ({ ...realPicker, ProjectPathPicker: ({ value, onChange }: any) => {
  React0.useEffect(() => { if (!value) onChange("/home/me/repo"); }, [value, onChange]);
  return null;
} }));

// One window for the file: React and Radix bind to the first window's event
// classes, so a fresh JSDOM per test makes every later dispatch throw.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://local.codecast.sh/chat/c1", pretendToBeVisual: true });
const w = dom.window as any;
const restoreGlobals = replaceGlobals({
  window: w, document: w.document, navigator: w.navigator, localStorage: w.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
  DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter,
  requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

async function harness() {
  document.body.innerHTML = '<div id="root"></div>';
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useInboxStore } = await import("../../store/inboxStore");
  const st = useInboxStore.getState() as any;
  const saved = {
    handThreadToAgent: st.handThreadToAgent, requestNavigate: st.requestNavigate, navigateToSession: st.navigateToSession,
    defaultNewSessionPath: st.clientState?.ui?.default_new_session_path,
  };
  const started: any[] = [];
  const navigated: string[] = [];
  useInboxStore.setState({
    handThreadToAgent: (o: any) => { started.push(o); return STUB; },
    requestNavigate: (id: string) => { navigated.push(id); },
    navigateToSession: (id: string) => { navigated.push(id); },
    chatChannels: { ...st.chatChannels, c1: { _id: "c1", name: "general", kind: "channel", team_id: "t1" } },
  } as any);
  const root = createRoot(document.getElementById("root")!);
  const confirm = () => document.querySelector<HTMLButtonElement>("[data-switch-confirm]");
  const startAgent = async () => {
    const button = confirm();
    assert.ok(button, "the Start agent review opened");
    assert.equal(button!.disabled, false, `Start agent is pressable (${button!.title})`);
    await React.act(async () => button!.click());
  };
  const cleanup = async () => {
    await React.act(async () => root.unmount());
    useInboxStore.setState({ handThreadToAgent: saved.handThreadToAgent, requestNavigate: saved.requestNavigate, navigateToSession: saved.navigateToSession } as any);
    document.body.innerHTML = "";
  };
  return { React, root, started, navigated, confirm, startAgent, cleanup, useInboxStore };
}

const message: ChatMessageView = {
  id: "k17abcdefghijklmnopqrstuvwxyz123", // a Convex-shaped id, so the hand action is offered
  author: { id: "u1", name: "Ashot" },
  content: "can an agent look at the deploy page?",
  createdAt: Date.UTC(2026, 10, 25, 23, 10),
};

async function openMessageReview(h: Awaited<ReturnType<typeof harness>>) {
  const { ChatMessage } = await import("./ChatMessage");
  await h.React.act(async () =>
    h.root.render(<ChatMessage message={message} channelId="c1" now={message.createdAt} onReact={() => {}} />),
  );
  const more = document.querySelector<HTMLButtonElement>('button[title="More"]');
  assert.ok(more, "message actions rendered");
  await h.React.act(async () => more!.click());
  const hand = document.querySelector<HTMLButtonElement>("[data-hand-to-agent]");
  assert.ok(hand, "Hand to agent offered on the message");
  await h.React.act(async () => hand!.click());
}

test("Start agent from a message's Hand to agent opens the new session", async () => {
  const h = await harness();
  try {
    await openMessageReview(h);
    await h.startAgent();
    assert.equal(h.started.length, 1, "the agent was started");
    assert.equal(h.confirm(), null, "the review closed");
    assert.deepEqual(h.navigated, [STUB], "pressing Start agent opens the session it just started");
  } finally {
    await h.cleanup();
  }
}, 120_000);

test("cancelling a message's Hand to agent review navigates nowhere", async () => {
  const h = await harness();
  try {
    await openMessageReview(h);
    assert.ok(h.confirm(), "review open");
    await h.React.act(async () => {
      document.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(h.confirm(), null, "the review closed");
    assert.equal(h.started.length, 0);
    assert.deepEqual(h.navigated, []);
  } finally {
    await h.cleanup();
  }
}, 120_000);

test("Start agent from the composer's Hand to agent opens the new session", async () => {
  const h = await harness();
  const React = h.React;
  const realTyping = { ...(await import("../../hooks/useChatTyping")) };
  mock.module("../../hooks/useChatTyping", () => ({ ...realTyping, useTypingReporter: () => ({ stop() {}, onTyping() {} }), useTypingMembers: () => [] }));
  const realSlack = { ...(await import("../../hooks/useChannelSlackLink")) };
  mock.module("../../hooks/useChannelSlackLink", () => ({ ...realSlack, useChannelSlackLink: () => null }));
  const realConnect = { ...(await import("../../hooks/useSlackConnect")) };
  mock.module("../../hooks/useSlackConnect", () => ({ ...realConnect, useSlackConnect: () => ({ busy: false, started: false, error: null, connect() {} }) }));
  const realWalkie = { ...(await import("../calls/WalkiePtt")) };
  mock.module("../calls/WalkiePtt", () => ({ ...realWalkie, WalkiePttButton: () => null }));
  const realPopover = { ...(await import("../ui/popover")) };
  mock.module("../ui/popover", () => ({ ...realPopover, Popover: ({ children }: any) => <div>{children}</div>, PopoverTrigger: ({ children }: any) => children, PopoverContent: ({ children }: any) => <div>{children}</div> }));
  const realInput = { ...(await import("../MessageInput")) };
  mock.module("../MessageInput", () => ({ ...realInput, MessageInput: ({ onGateSend, composerFoot }: any) => (
    <><button type="button" data-send onClick={() => onGateSend("please take this", [])}>Send</button>{composerFoot}</>
  ) }));
  const realChat = { ...(await import("../../store/chatSlice")) };
  mock.module("../../store/chatSlice", () => ({ ...realChat, sentChatMessageId: () => Promise.resolve(message.id) }));
  try {
    const { ChatComposer } = await import("./ChatComposer");
    await React.act(async () =>
      h.root.render(<ChatComposer channelId="c1" teamId="t1" placeholder="Message #general" onSend={() => "client-1"} />),
    );
    const handChoice = document.querySelector<HTMLInputElement>("[data-hand-choice] input");
    assert.ok(handChoice, "Hand to agent offered in the composer");
    await React.act(async () => handChoice!.click());
    await React.act(async () => document.querySelector<HTMLButtonElement>("[data-send]")!.click());
    await h.startAgent();
    assert.equal(h.started.length, 1, "the agent was started");
    assert.equal(h.confirm(), null, "the review closed");
    assert.deepEqual(h.navigated, [STUB], "pressing Start agent opens the session it just started");
  } finally {
    await h.cleanup();
  }
}, 120_000);
