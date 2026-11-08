import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
// See composerGateSendBatch.mount.test.tsx: entering from ChatMessage closes a module cycle.
import "../chat/ChatMessage";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// `/btw <question>` in a conversation's composer is a side question
// (onSideQuestion): no way out of the box (Enter, ⌘↵ queue, ⇧Esc stop and
// send) may hand it to the agent, and pasted images stay in the draft.
// Run: bun test components/__tests__/composerSideQuestion.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_ID = "jx70000000000000000000000sideqst"; // 32 chars => isConvexId
let dispatched: string[] = [];
let probe: string | undefined;

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

beforeEach(() => {
  dispatched = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string) => { dispatched.push(action); return undefined; });
  useInboxStore.setState({ sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, reviewComments: {}, currentSessionId: null, currentUser: { _id: "user_btw_test", name: "Tester" } as any } as any);
});

async function press(text: string, act_: (container: HTMLElement) => void): Promise<string[]> {
  const asked: string[] = [];
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  const populate: { current: ((text: string) => void) | null } = { current: null };
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput conversationId={CONV_ID} status="active" agentType="claude_code" isThinking isConversationLive onPopulateInput={populate as any}
          onSendEscape={() => { dispatched.push("STOP"); }}
          onSideQuestion={(q) => { asked.push(q); return null; }} />
      </ConvexProvider>,
    );
  });
  await act(async () => { populate.current!(text); });
  await act(async () => { act_(container); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await act(async () => { root.unmount(); });
  container.remove();
  return asked;
}

const sent = () => [...(useInboxStore.getState().pendingMessages[CONV_ID] ?? []), ...dispatched.filter((a) => /send|queue|stop/i.test(a))];
// The textarea's own key handler, called as React would: a dispatched keydown
// trips React's IE input polyfill under jsdom (attachEvent is not a function).
const key = (c: HTMLElement, init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }) => {
  const ta = c.querySelector("[data-composer-field]") as any;
  const props = ta[Object.keys(ta).find((k) => k.startsWith("__reactProps$"))!];
  props.onKeyDown({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...init, preventDefault() {}, stopPropagation() {}, nativeEvent: { isComposing: false }, currentTarget: ta, target: ta });
};

test("Enter asks the side question and sends nothing", async () => {
  const asked = await press("/btw why 8 retries?", (c) => c.querySelector("form")!.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })));
  expect(asked).toEqual(["why 8 retries?"]);
  expect(sent()).toEqual([]);
});

test("⌘↵ (queue) asks it instead of queueing it", async () => {
  const asked = await press("/btw why 8 retries?", (c) => key(c, { key: "Enter", metaKey: true, ctrlKey: true }));
  expect(asked).toEqual(["why 8 retries?"]);
  expect(sent()).toEqual([]);
});

test("⇧Esc (stop and send) asks it and stops nothing", async () => {
  const asked = await press("/btw why 8 retries?", (c) => key(c, { key: "Escape", shiftKey: true }));
  expect(asked).toEqual(["why 8 retries?"]);
  expect(sent()).toEqual([]);
});

test("a /btw that does not open the message is for the agent", async () => {
  const asked = await press("check this /btw thing", (c) => c.querySelector("form")!.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })));
  expect(asked).toEqual([]);
});

test("pasted images stay in the draft after a side question", async () => {
  const image = { storageId: "st_btw_1", name: "shot.png", type: "image/png", previewUrl: "blob:b" };
  useInboxStore.setState({ drafts: { [CONV_ID]: { draft_message: "/btw what is this?", draft_image_storage_ids: [image] } } } as any);
  const asked = await press("/btw what is this?", (c) => { probe = (c.querySelector("[data-composer-field]") as any)?.value; c.querySelector("form")!.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); });
  expect(probe).toBe("/btw what is this?");
  expect(asked).toEqual(["what is this?"]);
  const draft = useInboxStore.getState().drafts[CONV_ID] as any;
  expect(draft?.draft_image_storage_ids?.[0]?.storageId).toBe("st_btw_1");
  expect(draft?.draft_message ?? null).toBeNull();
});
