/**
 * ct-101558: a teammate's agent posts a message in a chat; the viewer opens
 * "Hand to agent" on it to give it to their own agent. The review must offer an
 * enabled "Start agent" (a new session of the viewer's that answers in the
 * thread), whether or not the viewer's store holds the teammate's session.
 * The block is right only for a thread someone deliberately handed (bound) to
 * another person's session.
 */
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import { replaceGlobals } from "../../../test-helpers/globals";

const ME = "user_me";
const TEAMMATE = "user_teammate";
const MACHINE = { device_id: "dev1", label: "macOS MacBook.local", display_name: "MacBook", platform: "darwin", online: true };

const realMachines = { ...(await import("../../../hooks/useSessionMachines")) };
mock.module("../../../hooks/useSessionMachines", () => ({ ...realMachines, useSessionMachines: () => [MACHINE] }));
const realLocal = { ...(await import("../../../hooks/useLocalDeviceId")) };
mock.module("../../../hooks/useLocalDeviceId", () => ({ ...realLocal, useLocalDeviceId: () => "dev1" }));
const realPinned = { ...(await import("../../../hooks/usePinnedAgents")) };
mock.module("../../../hooks/usePinnedAgents", () => ({ ...realPinned, useDefaultAgentType: () => "claude_code" }));
const realPicker = { ...(await import("../../ProjectPathPicker")) };
mock.module("../../ProjectPathPicker", () => ({ ...realPicker, ProjectPathPicker: ({ value }: { value: string }) => <span data-folder>{value}</span> }));

async function mount() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/", pretendToBeVisual: true });
  const w = dom.window as any;
  const restore = replaceGlobals({
    window: w, document: w.document, navigator: w.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
    DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useInboxStore } = await import("../../../store/inboxStore");
  const { HandToAgentReview } = await import("../HandToAgent");
  const root = createRoot(w.document.getElementById("root"));
  const q = (sel: string) => w.document.querySelector(sel) as HTMLButtonElement | null;
  const tick = () => React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const done = async () => { await React.act(async () => root.unmount()); await tick(); restore(); };
  return { React, root, q, done, useInboxStore, HandToAgentReview };
}

async function reviewFor(withTeammateSession: boolean, rootOverride: Record<string, unknown> = {}) {
  const m = await mount();
  const s = m.useInboxStore.getState() as any;
  m.useInboxStore.setState({
    currentUser: { ...(s.currentUser ?? {}), _id: ME },
    currentConversation: { ...(s.currentConversation ?? {}), projectPath: "/Users/me/src/app" },
    chatChannels: { ...s.chatChannels, chan1: { _id: "chan1", kind: "dm", name: "dm", team_id: "team1" } },
    chatMessages: {
      ...s.chatMessages,
      root1: { _id: "root1", channel_id: "chan1", user_id: TEAMMATE, origin: "agent", origin_session_id: "sess_teammate", content: "Hi Jason. Here are two codecast account bugs I hit today…", created_at: 1, ...rootOverride },
    },
    sessions: withTeammateSession
      ? { ...s.sessions, sess_teammate: { _id: "sess_teammate", user_id: TEAMMATE, short_id: "jx7team" } }
      : s.sessions,
  } as any);
  await m.React.act(async () => m.root.render(
    <m.HandToAgentReview channelId="chan1" rootKey="root1" message="handle this" onClose={() => {}} />,
  ));
  await m.React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return m;
}

for (const loaded of [false, true]) {
  test(`a teammate's agent-posted message can be handed to my own agent (teammate's session ${loaded ? "in" : "not in"} my store)`, async () => {
    const m = await reviewFor(loaded);
    try {
      const confirm = m.q("[data-switch-confirm]");
      assert.ok(confirm, "the review renders its confirm button");
      assert.equal(confirm!.textContent?.includes("Handed to someone else's session"), false,
        `the review blocks with "${confirm!.textContent}" — a teammate's agent posting a message is not a deliberate hand of the thread`);
      assert.equal(confirm!.disabled, false, "Start agent is enabled");
      assert.match(confirm!.textContent ?? "", /Start agent/);
    } finally { await m.done(); }
  }, 120_000);
}

// Guards: they pass today and must keep passing after the fix.
test("guard: a teammate's own (human) message opens an enabled Start agent with this fixture", async () => {
  const m = await reviewFor(false, { origin: undefined, origin_session_id: undefined });
  try {
    const confirm = m.q("[data-switch-confirm]")!;
    assert.equal(confirm.disabled, false, `blocked with "${confirm.textContent}"`);
    assert.match(confirm.textContent ?? "", /Start agent/);
  } finally { await m.done(); }
}, 120_000);

test("guard: a thread someone deliberately handed to a teammate's session stays blocked", async () => {
  const m = await reviewFor(true, { origin: undefined, origin_session_id: undefined, bound_session_id: "sess_teammate" });
  try {
    const confirm = m.q("[data-switch-confirm]")!;
    assert.equal(confirm.disabled, true);
    assert.match(confirm.textContent ?? "", /Handed to someone else's session/);
  } finally { await m.done(); }
}, 120_000);
