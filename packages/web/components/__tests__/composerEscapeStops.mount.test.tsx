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


afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_ID = "jx70000000000000000000000escstop"; // 32 chars => isConvexId
let dispatched: string[] = [];

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

// Escape in an empty composer. While a turn runs the status line reads
// "Esc stop": a double tap stops it once and never opens the branch map (it
// used to cancel the stop and open the map instead). At rest, the double tap
// still opens the map.
// Run: bun test components/__tests__/composerEscapeStops.mount.test.tsx
async function doubleEscape(running: boolean): Promise<{ stops: number; maps: number }> {
  let maps = 0;
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput conversationId={CONV_ID} status="active" agentType="claude_code" agentStatus={running ? undefined : "idle"} isThinking={running} isConversationLive={running}
          onSendEscape={() => { dispatched.push("STOP"); }}
          onOpenNavigator={() => { maps++; }} />
      </ConvexProvider>,
    );
  });
  await act(async () => { key(container, { key: "Escape" }); });
  await act(async () => { key(container, { key: "Escape" }); });
  await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
  await act(async () => { root.unmount(); });
  container.remove();
  return { stops: dispatched.filter((a) => a === "STOP").length, maps };
}

// The textarea's own key handler, called as React would: a dispatched keydown
// trips React's IE input polyfill under jsdom (attachEvent is not a function).
const key = (c: HTMLElement, init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }) => {
  const ta = c.querySelector("[data-composer-field]") as any;
  const props = ta[Object.keys(ta).find((k) => k.startsWith("__reactProps$"))!];
  props.onKeyDown({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...init, preventDefault() {}, stopPropagation() {}, nativeEvent: { isComposing: false }, currentTarget: ta, target: ta });
};


test("a double Escape during a running turn stops it once and opens no map", async () => {
  expect(await doubleEscape(true)).toEqual({ stops: 1, maps: 0 });
});

test("a double Escape at rest opens the branch map and stops nothing", async () => {
  expect(await doubleEscape(false)).toEqual({ stops: 0, maps: 1 });
});
