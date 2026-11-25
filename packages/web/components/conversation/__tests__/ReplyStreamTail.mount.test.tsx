import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// The block itself: each push grows its text, and nothing on it acts on its
// synthetic message id (no toolbar, no anchor id). Where the block sits, and
// when it shows, is the conversation view's (replyStreamConversation.mount).

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../../test-helpers/offlineConvex");
const { useInboxStore } = await import("../../../store/inboxStore");
const { flushSyncPublishes } = await import("../../../store/syncTransaction");
const { ReplyStreamTail } = await import("../ReplyStreamTail");

const CONV = "c_reply_stream_mount";
const client = offlineConvexClient();

afterAll(() => {
  useInboxStore.getState().dropRows("replyStreams", [CONV]);
  closeDomWindow(dom);
  restoreGlobals();
});

const push = (seq: number, text: string) =>
  act(async () => {
    useInboxStore.getState().syncTable("replyStreams", [
      { _id: CONV, conversation_id: CONV, message_id: "hook-1", text, seq, started_at: Date.now(), updated_at: Date.now(), received_at: Date.now() },
    ]);
    // Incoming data reaches subscribers after a short fold window
    // (store/syncTransaction); flushing it inside act commits the re-render.
    flushSyncPublishes();
  });

test("pushes grow the block, which offers no per-message actions", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={client}>
        <MemoryRouter><ReplyStreamTail conversationId={CONV} density="full" showHeader agentType="claude_code" /></MemoryRouter>
      </ConvexProvider>,
    );
  });
  const block = () => container.querySelector('[data-cc-message="assistant"]');
  expect(block()).toBeNull();
  await push(1, "First paragraph of the reply.");
  expect(block()?.textContent).toContain("First paragraph of the reply.");
  await push(2, "First paragraph of the reply.\n\nSecond paragraph.");
  expect(block()?.textContent).toContain("Second paragraph.");
  expect(block()?.querySelector("[data-cc-assistant-message-toolbar]")).toBeNull();
  expect(block()?.getAttribute("id")).toBeNull();
  expect(block()?.querySelector("[data-cc-message-who]")).not.toBeNull();
  await act(async () => { root.unmount(); });
});
