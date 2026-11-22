import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const toasts: string[] = [];
const record = (kind: string) => (msg: any) => { toasts.push(`${kind}:${String(msg)}`); return 1; };
mock.module("sonner", () => ({
  toast: Object.assign(record("toast"), { error: record("error"), info: record("info"), success: record("success"), warning: record("warning"), dismiss: () => {}, loading: record("loading"), custom: record("custom"), promise: (p: any) => p }),
  Toaster: () => null,
}));
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";
import { formatPendingComments } from "../../lib/quoteFormat";

// ct-98130: with quotes waiting in the batch and nothing typed, the composer
// offers fork and send next to the batch (the button, its keys, and the
// placeholder's words), and ⌘⇧Enter sends the quotes into a new branch: the
// fork gets the same text a plain send would make, the parent gets nothing.

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const PARENT_ID = "jx70000000000000000000000parent0";
const FORK_REAL_ID = "jx70000000000000000000000forkrea";
const FORK_STUB = "fork_stub_quotes";
const QUOTES = [
  { quote: "The retry loop backs off exponentially.", body: "" },
  { quote: "We cap the queue at 500 items.", body: "Why 500?" },
];

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 20) => { await act(async () => { await tick(ms); }); };
const flushUntil = async (ready: () => boolean, budgetMs = 3_000) => {
  const deadline = Date.now() + budgetMs;
  while (!ready() && Date.now() < deadline) await flush(20);
  return ready();
};

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"));
  const props = propsKey ? (el as any)[propsKey] : null;
  props?.onChange?.({ target: el, currentTarget: el, nativeEvent: new w.Event("input") });
}

beforeEach(() => {
  toasts.length = 0;
  useInboxStore.setState({
    sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, pendingSessionCreates: {}, reviewComments: {},
    currentSessionId: null, currentUser: { _id: "user_fork_test", name: "Tester" } as any,
  } as any);
  QUOTES.forEach((q, i) => useInboxStore.getState().addReviewComment(PARENT_ID, {
    id: `q${i}`, messageId: "msg_a1", blockIndex: i, quote: q.quote, body: q.body, createdAt: 1000 + i,
  }));
});

async function mount(hosted = false) {
  const calls: Array<{ action: string; args: any[] }> = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: any[]) => { calls.push({ action, args }); return undefined; });
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onForkTail = async () => {
    let resolve!: (id: string) => void;
    const ready = new Promise<string>((r) => { resolve = r; });
    useInboxStore.getState().trackSessionCreate(FORK_STUB, ready);
    setTimeout(() => resolve(FORK_REAL_ID), 30);
    return FORK_STUB;
  };
  await act(() => root.render(
    <ConvexProvider client={fakeConvex()}>
      <MessageInput conversationId={PARENT_ID} status="active" agentType="claude_code" agentStatus={"idle" as any} isSessionReady
        hostedConversation={hosted} onForkTail={onForkTail} />
    </ConvexProvider>,
  ));
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  return { calls, container, textarea, unmount: async () => { await act(() => root.unmount()); container.remove(); } };
}

test("the quote batch offers fork and send: button, keys and placeholder", async () => {
  const { container, textarea, unmount } = await mount();
  expect(container.querySelector('button[aria-label="Fork and send"]')).not.toBeNull();
  expect(container.querySelector("[data-fork-quotes-keys]")?.querySelectorAll("kbd, span > *").length).toBeGreaterThan(0);
  expect(textarea.placeholder).toContain("Send 2 quotes as-is, fork and send them");
  await act(() => { setNativeValue(textarea, "a reply"); });
  await flush();
  // Once words are typed the plain offer is gone; the button stays.
  expect(container.querySelector("[data-fork-quotes-keys]")).toBeNull();
  expect(container.querySelector('button[aria-label="Fork and send"]')).not.toBeNull();
  await unmount();
}, 30_000);

test("⌘⇧Enter with quotes waiting sends them and the reply into the fork, not the parent", async () => {
  const { calls, textarea, unmount } = await mount();
  await act(() => { setNativeValue(textarea, "Take this in a branch."); });
  await flush();
  await act(() => { textarea.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); });
  await flushUntil(() => calls.some((c) => c.action === "sendMessage"));
  const sends = calls.filter((c) => c.action === "sendMessage");
  expect(toasts.filter((t) => t.startsWith("error:"))).toEqual([]);
  expect(sends).toHaveLength(1);
  expect(sends[0].args[0]).toBe(FORK_REAL_ID);
  expect(sends[0].args[1]).toBe(`${formatPendingComments(QUOTES)}\n\nTake this in a branch.`);
  expect(useInboxStore.getState().pendingMessages[PARENT_ID] ?? []).toHaveLength(0);
  expect(useInboxStore.getState().getReviewComments(PARENT_ID)).toHaveLength(0);
  await unmount();
}, 30_000);

test("a hosted conversation is not offered fork and send", async () => {
  const { container, textarea, unmount } = await mount(true);
  expect(container.querySelector('button[aria-label="Fork and send"]')).toBeNull();
  expect(textarea.placeholder).not.toContain("fork");
  await unmount();
}, 30_000);
