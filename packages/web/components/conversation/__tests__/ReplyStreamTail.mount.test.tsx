import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// The live reply at the end of a conversation: each push grows the text in
// the trailing assistant block and re-renders that block alone, and the block
// draws nothing once the real message is in the conversation.

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
const { replyStreamOpen } = await import("../../../lib/replyStreamHandoff");
const { ReplyStreamTail } = await import("../ReplyStreamTail");

const CONV = "c_reply_stream_mount";
const client = offlineConvexClient();

afterAll(() => {
  useInboxStore.getState().dropRows("replyStreams", [CONV]);
  closeDomWindow(dom);
  restoreGlobals();
});

let parentRenders = 0;
// Stands in for ConversationView: it subscribes only to whether a reply is
// open (the boolean that keeps its tail row drawn) and renders the tail.
function Parent() {
  parentRenders++;
  const open = useInboxStore((s) => replyStreamOpen(s as any, CONV));
  return (
    <div data-open={open ? "" : undefined}>
      <ReplyStreamTail conversationId={CONV} density="full" prevAssistantAt={null} agentType="claude_code" />
    </div>
  );
}

// Incoming data reaches subscribers after a short fold window
// (store/syncTransaction); flushing it inside act commits what re-rendered.
const settle = async () => flushSyncPublishes();
const startedAt = Date.now();
const push = (seq: number, text: string) =>
  act(async () => {
    useInboxStore.getState().syncTable("replyStreams", [
      { _id: CONV, conversation_id: CONV, message_id: "hook-1", text, seq, started_at: startedAt, updated_at: Date.now(), received_at: Date.now() },
    ]);
    await settle();
  });

test("pushes grow the block without re-rendering what holds it, and the landed message takes its place", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={client}>
        <MemoryRouter><Parent /></MemoryRouter>
      </ConvexProvider>,
    );
  });
  const block = () => container.querySelector('[data-cc-message="assistant"]');
  expect(block()).toBeNull();

  await push(1, "First paragraph of the reply.");
  expect(block()?.textContent).toContain("First paragraph of the reply.");
  const afterOpen = parentRenders;

  await push(2, "First paragraph of the reply.\n\nSecond paragraph.");
  expect(block()?.textContent).toContain("Second paragraph.");
  await push(3, "First paragraph of the reply.\n\nSecond paragraph.\n\nThird paragraph.");
  expect(block()?.textContent).toContain("Third paragraph.");
  expect(parentRenders).toBe(afterOpen);

  // None of the per-message actions of a message that does not exist yet.
  expect(block()?.querySelector("[data-cc-assistant-message-toolbar]")).toBeNull();
  expect(block()?.getAttribute("id")).toBeNull();

  await act(async () => {
    useInboxStore.getState().setMessages(CONV, [
      { _id: "u1", role: "user", content: "Explain it", timestamp: startedAt - 2_000 },
      { _id: "m1", role: "assistant", content: "First paragraph of the reply.\n\nSecond paragraph.\n\nThird paragraph.\n\nLast one.", timestamp: startedAt + 3_000 },
    ] as any);
    await settle();
  });
  expect(block()).toBeNull();
  expect(container.querySelector("[data-open]")).toBeNull();
  await act(async () => { root.unmount(); });
});
