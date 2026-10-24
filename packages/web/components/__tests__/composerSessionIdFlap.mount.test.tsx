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
// Same entry as composerGateSendBatch: closes the messageMarkdown cycle lazily.
import "../chat/ChatMessage";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// ConversationView keys the composer by `session_id || _id`, so a session id
// that goes away and comes back remounts it twice. Words typed while it was
// away must survive the second remount.
// Run: bun test components/__tests__/composerSessionIdFlap.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).action = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

beforeEach(() => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, reviewComments: {}, currentSessionId: null, currentUser: { _id: "user_flap_test", name: "Tester" } as any } as any);
});

function type(container: HTMLElement, text: string) {
  const textarea = container.querySelector("textarea")!;
  const props = (textarea as any)[Object.keys(textarea).find((k) => k.startsWith("__reactProps"))!];
  for (const ch of text) {
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, textarea.value + ch);
    props.onChange?.({ target: textarea, currentTarget: textarea, nativeEvent: new w.Event("input") });
  }
}

test("words typed while the session id was unset survive its return", async () => {
  const convId = "jx70000000000000000000000flap01".padEnd(32, "x");
  const sessionId = "5d8d74d7-3c4d-4caf-9ef0-3c64122a9726";
  const client = fakeConvex();
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  const render = (sid: string | undefined) => root.render(
    <ConvexProvider client={client}>
      <MessageInput key={sid || convId} conversationId={convId} sessionId={sid} status="active" agentType="claude_code" />
    </ConvexProvider>,
  );

  await act(async () => { render(sessionId); });
  await act(async () => { type(container, "fix the"); });
  await act(async () => { render(undefined); });
  await act(async () => { type(container, " login bug"); });
  await act(async () => { render(sessionId); });

  expect(container.querySelector("textarea")!.value).toBe("fix the login bug");
  await act(async () => { root.unmount(); });
  container.remove();
});
