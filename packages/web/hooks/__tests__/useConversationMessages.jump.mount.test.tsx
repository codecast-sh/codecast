// A jump to a message after a jump to a time (the org screen's proposal strip:
// an old proposal whose card is not in the store lands by timestamp, the next
// click lands by message id). The timestamp jump leaves jumpMode "center";
// the message jump must start clean, or its around-window query never runs
// and the thread sits in a loading state (review flow-R2).
// Run: bun test --timeout 240000 hooks/__tests__/useConversationMessages.jump.mount.test.tsx
import { afterAll, expect, mock, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/org", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;

// A convex-shaped id, so the hook believes it can query.
const CONV = "k57abcdefghijklmnopqrstuvwxyz012";
const TARGET_TS = 500;
const msg = (id: string, timestamp: number) => ({ _id: id, role: "assistant", content: id, timestamp });

const convexReal = await import("convex/react");
// The tail snapshot and the warm fetches find an empty conversation.
mock.module("convex/react", () => ({ ...convexReal, useConvex: () => ({ query: async () => ({ page: [], isDone: true, continueCursor: null, messages: [], has_more: false }) }) }));
const { getFunctionName } = await import("convex/server");
// Every query the hook asks: the around-window calls are recorded; the target
// message's timestamp is answered; everything else stays loading.
const aroundArgs: any[] = [];
let aroundAnswer: any = undefined;
mock.module("../useQueryNoThrow", () => ({
  useQueryNoThrow: (fn: any, args: unknown) => {
    const name = getFunctionName(fn);
    if (name === "conversations:getMessagesAroundTimestamp") {
      if (args !== "skip") aroundArgs.push(args);
      return { data: args === "skip" ? undefined : aroundAnswer };
    }
    if (name === "messages:getMessageTimestamp" && args !== "skip") return { data: { timestamp: TARGET_TS } };
    return { data: undefined };
  },
}));
mock.module("../useConvexSync", () => ({ useConvexSync: () => {} }));
let timestampFetch: { resolve: (v: unknown) => void } | null = null;
mock.module("../inboxWarm", () => ({
  WARM_DEEP_ROWS: 50,
  deepenConversation: async () => {},
  fetchOlderPage: async () => {},
  fetchOlderMessages: async () => ({ messages: [] }),
  // The timestamp jump's one-shot fetch: held until the test lets it land.
  fetchMessagesAround: () => new Promise((resolve) => { timestampFetch = { resolve }; }),
}));

const { useConversationMessages } = await import("../useConversationMessages");
const { useInboxStore } = await import("../../store/inboxStore");
// The hook renders from the store: a row for the conversation, or it answers null.
useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [CONV]: { _id: CONV, status: "active", message_count: 10, agent_type: "claude" } } }));
const { act } = React;
const { createRoot } = await import("react-dom/client");

let api_: ReturnType<typeof useConversationMessages> | null = null;
function Probe({ messageId, nonce }: { messageId?: string; nonce?: number }) {
  api_ = useConversationMessages(CONV, messageId, undefined, undefined, nonce);
  return h("div", { "data-loading-older": String(api_.isLoadingOlder), "data-rows": api_.conversation?.messages.length ?? 0, "data-target-mode": String(api_.targetMode) });
}
const root = createRoot(document.getElementById("root")!);
const render = async (p: { messageId?: string; nonce?: number }) => { await act(async () => { root.render(h(Probe, p)); }); };
const probe = () => document.querySelector<HTMLElement>("[data-loading-older]")!;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("a message jump after a timestamp jump fetches its own window and stops loading", async () => {
  await render({});
  expect(aroundArgs).toEqual([]);

  // The strip click on an old proposal: a timestamp jump, which lands.
  await act(async () => { api_!.jumpToTimestamp(100); });
  expect(probe().dataset.loadingOlder).toBe("true");
  await act(async () => { timestampFetch!.resolve({ messages: [msg("old-1", 90), msg("old-2", 110)], has_more_above: true, has_more_below: true }); });
  await flush();
  expect(probe().dataset.loadingOlder).toBe("false");
  expect(probe().dataset.rows).toBe("2");
  expect(aroundArgs).toEqual([]);

  // The next click: a card in the store, so a message jump with a new nonce.
  aroundAnswer = { messages: [msg("m-before", 450), msg("m-target", TARGET_TS), msg("m-after", 550)], has_more_above: true, has_more_below: false };
  await render({ messageId: "m-target", nonce: 2 });
  await flush();
  expect(aroundArgs.length).toBeGreaterThan(0);
  expect(aroundArgs[0]).toMatchObject({ conversation_id: CONV, center_timestamp: TARGET_TS });
  expect(probe().dataset.loadingOlder).toBe("false");
  expect(probe().dataset.rows).toBe("3");
});

test("a timestamp jump still in flight is dropped when a message jump follows", async () => {
  aroundArgs.length = 0;
  await act(async () => { api_!.jumpToTimestamp(200); });
  expect(probe().dataset.loadingOlder).toBe("true");
  const held = timestampFetch!;
  await render({ messageId: "m-target", nonce: 3 });
  await flush();
  expect(probe().dataset.loadingOlder).toBe("false");
  expect(aroundArgs[0]).toMatchObject({ center_timestamp: TARGET_TS });
  expect(probe().dataset.rows).toBe("3");
  // The late window of the dropped jump changes nothing.
  await act(async () => { held.resolve({ messages: [msg("late", 200)], has_more_above: false, has_more_below: false }); });
  await flush();
  expect(probe().dataset.rows).toBe("3");
  expect(probe().dataset.loadingOlder).toBe("false");
});

test("a message jump to a message the loaded tail holds leaves target mode, opens no window, and shows the tail", async () => {
  // The thread is still a window around m-target from the jump before.
  expect(probe().dataset.targetMode).toBe("true");
  aroundArgs.length = 0;
  // The live tail, as the store holds it: the next card's message among it.
  const tail = [msg("t-1", 900), msg("t-card", 910), msg("t-2", 920), msg("t-3", 930)];
  await act(async () => { useInboxStore.setState((s: any) => ({ messages: { ...s.messages, [CONV]: tail } })); });
  await render({ messageId: "t-card", nonce: 4 });
  await flush();
  expect(probe().dataset.targetMode).toBe("false");
  expect(probe().dataset.loadingOlder).toBe("false");
  expect(probe().dataset.rows).toBe("4");
  expect(aroundArgs).toEqual([]);
  expect(api_!.isJumpingToTarget).toBe(false);
  // The same request stays live across re-renders; the target is not re-engaged.
  await render({ messageId: "t-card", nonce: 4 });
  await flush();
  expect(probe().dataset.targetMode).toBe("false");
  expect(aroundArgs).toEqual([]);
});

test("a message outside the loaded tail still opens its window", async () => {
  aroundAnswer = { messages: [msg("m-before", 450), msg("m-target", TARGET_TS), msg("m-after", 550)], has_more_above: true, has_more_below: false };
  await render({ messageId: "m-target", nonce: 5 });
  await flush();
  expect(probe().dataset.targetMode).toBe("true");
  expect(aroundArgs[0]).toMatchObject({ center_timestamp: TARGET_TS });
  expect(probe().dataset.rows).toBe("3");
});
