// The embed's scroll-to request (org-staffing.md S41): a `jump` with a
// message id reaches useConversationMessages and the layout as the target;
// one with a timestamp alone calls jumpToTimestamp once per nonce, and its
// `find` is resolved to the card's row in the window the hook returns, for
// the layout only; a message sent from the embed ends the request and jumps
// to the live tail; `since` is gone from the props.
// Run: bun test --timeout 240000 components/anchor/AnchorConversation.jump.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;

const hookCalls: unknown[][] = [];
const jumps: number[] = [];
const ends: number[] = [];
const noop = () => {};
// The window the hook holds; a test swaps it for one with the card's message.
let windowMessages: { _id: string; role: string; content: string }[] = [];
// Whether the hook holds a window around a target or the live tail.
let targetMode = false;
mock.module("../../hooks/useConversationMessages", () => ({
  useConversationMessages: (...args: unknown[]) => {
    hookCalls.push(args);
    return { conversation: { _id: args[0], messages: windowMessages }, hasMoreAbove: false, hasMoreBelow: false, isLoadingOlder: false, isLoadingNewer: false, loadOlder: noop, loadNewer: noop, jumpToStart: noop, jumpToEnd: () => { ends.push(1); }, jumpToTimestamp: (ts: number) => { jumps.push(ts); }, targetMode };
  },
}));
// The layout keeps its latest props, so a test can settle the target the way the view does.
let layoutProps: any = null;
mock.module("../ConversationDiffLayout", () => ({
  ConversationDiffLayout: (props: any) => { layoutProps = props; return h("div", { "data-layout": true, "data-target": props.targetMessageId ?? "", "data-nonce": props.targetNonce ?? "" }); },
}));
mock.module("../../hooks/useSeedOwnership", () => ({ useSeedOwnership: noop }));
mock.module("../../hooks/useSyncOrgTree", () => ({ useSyncOrgTree: () => ({ tree: null, ready: true, missing: false, refused: false, retry: noop }) }));
mock.module("../ProjectPathPicker", () => ({ ProjectPathPicker: () => null }));
mock.module("sonner", () => ({ toast: { success: noop, error: noop } }));

const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { AnchorConversation } = await import("./AnchorConversation");

// The `since` cut has no successor: the props type must not carry it.
type Props = React.ComponentProps<typeof AnchorConversation>;
const noSince: "since" extends keyof Props ? never : true = true;
void noSince;

const root = createRoot(document.getElementById("root")!);
const render = async (jump: Props["jump"]) => { await act(async () => { root.render(h(AnchorConversation, { conversationId: "conv-1", hideHeader: true, jump })); }); };
const layout = () => document.querySelector<HTMLElement>("[data-layout]")!;
const rootMode = () => layout().parentElement!.getAttribute("data-conv-target-mode");

test("a jump to a message reaches the hook as the target and nonce, and the layout", async () => {
  await render({ messageId: "m2", nonce: 1 });
  expect(hookCalls.at(-1)).toEqual(["conv-1", "m2", undefined, undefined, 1]);
  expect(layout().dataset.target).toBe("m2");
  expect(layout().dataset.nonce).toBe("1");
  expect(jumps).toEqual([]);
});

test("a jump to a time calls jumpToTimestamp once, and again only on a new nonce", async () => {
  await render({ timestamp: 5, nonce: 2 });
  expect(jumps).toEqual([5]);
  expect(hookCalls.at(-1)).toEqual(["conv-1", undefined, undefined, undefined, 2]);
  expect(layout().dataset.target).toBe("");
  await render({ timestamp: 5, nonce: 2 });
  expect(jumps).toEqual([5]);
  await render({ timestamp: 7, nonce: 3 });
  expect(jumps).toEqual([5, 7]);
  await render(null);
  expect(jumps).toEqual([5, 7]);
  expect(hookCalls.at(-1)).toEqual(["conv-1", undefined, undefined, undefined, undefined]);
});

test("a timestamp jump's `find` lands the layout on the card's row once the window holds it, under the same nonce, without re-arming the hook", async () => {
  windowMessages = [{ _id: "m1", role: "assistant", content: "Here is the review." }];
  await render({ timestamp: 9, find: "op-7", nonce: 4 });
  expect(jumps).toEqual([5, 7, 9]);
  expect(layout().dataset.target).toBe("");
  windowMessages = [...windowMessages, { _id: "m2", role: "assistant", content: "op-7" }, { _id: "m3", role: "user", content: "op-7 looks fine" }];
  await render({ timestamp: 9, find: "op-7", nonce: 4 });
  expect(layout().dataset.target).toBe("m2");
  expect(layout().dataset.nonce).toBe("4");
  expect(hookCalls.at(-1)).toEqual(["conv-1", undefined, undefined, undefined, 4]);
  expect(jumps).toEqual([5, 7, 9]);
});

test("a message sent from the embed ends the request and jumps to the live tail; the next nonce arms again", async () => {
  windowMessages = [];
  await render({ messageId: "m2", nonce: 5 });
  expect(layout().dataset.target).toBe("m2");
  // The send: a pending row of this conversation appears in the store.
  await act(async () => { useInboxStore.setState({ pendingMessages: { "conv-1": [{ _id: "pending-1", role: "user", content: "Approve it", timestamp: 1 }] } } as any); });
  expect(ends).toEqual([1]);
  expect(layout().dataset.target).toBe("");
  expect(hookCalls.at(-1)).toEqual(["conv-1", undefined, undefined, undefined, undefined]);
  // The same request stays ended across re-renders; a new one arms.
  await render({ messageId: "m2", nonce: 5 });
  expect(layout().dataset.target).toBe("");
  await render({ messageId: "m2", nonce: 6 });
  expect(layout().dataset.target).toBe("m2");
  expect(ends).toEqual([1]);
});

test("the request's onSettled runs once when the view settles its nonce, never for another nonce or a replaced request", async () => {
  windowMessages = [];
  const settled: number[] = [];
  await render({ messageId: "m2", nonce: 7, onSettled: () => settled.push(7) });
  expect(typeof layoutProps.onTargetSettled).toBe("function");
  // A settle of an older request, still finishing on the previous row: nothing.
  await act(async () => { layoutProps.onTargetSettled("m1", 6); });
  expect(settled).toEqual([]);
  await act(async () => { layoutProps.onTargetSettled("m2", 7); });
  expect(settled).toEqual([7]);
  // The layout can settle the same target again (its window re-rendered): once per nonce.
  await act(async () => { layoutProps.onTargetSettled("m2", 7); });
  expect(settled).toEqual([7]);
  // The next request has its own.
  await render({ messageId: "m2", nonce: 8, onSettled: () => settled.push(8) });
  await act(async () => { layoutProps.onTargetSettled("m2", 7); });
  expect(settled).toEqual([7]);
  await act(async () => { layoutProps.onTargetSettled("m2", 8); });
  expect(settled).toEqual([7, 8]);
});

test("the root says whether the thread is live or a window around a target", async () => {
  targetMode = false;
  await render({ messageId: "m2", nonce: 9 });
  expect(rootMode()).toBe("live");
  targetMode = true;
  await render({ messageId: "m2", nonce: 10 });
  expect(rootMode()).toBe("target");
  targetMode = false;
});
