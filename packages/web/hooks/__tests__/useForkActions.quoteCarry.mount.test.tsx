// ct-98130: a person sends a reply carrying quotes, then decides it belongs in
// a new branch. Forking from that sent reply (or from the assistant message it
// answered) must reopen the reply in the fork the way it was built: each quote
// back in the fork's quote batch as its own item, with its note, and only the
// typed words in the composer. Today the fork refills the box with the whole
// sent text, quotes flattened into blockquotes, or (forking from the assistant
// message) with nothing at all.

import type { Root } from "react-dom/client";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FORK_ID = "fork_stub_quote_carry";
const forkedFrom: string[] = [];
const realFork = { ...(await import("../../store/beginLocalFork")) };
mock.module("../../store/beginLocalFork", () => ({
  ...realFork,
  beginLocalFork: (_conv: any, messageUuid: string) => {
    forkedFrom.push(messageUuid);
    return { forkSessionId: FORK_ID, conversationId: FORK_ID, ready: Promise.resolve(FORK_ID) };
  },
}));

const { createRoot } = await import("react-dom/client");
const { useForkActions } = await import("../useForkActions");
const { useInboxStore } = await import("../../store/inboxStore");
const { formatPendingComments } = await import("../../lib/quoteFormat");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const PARENT_ID = "jx70000000000000000000000parent0";
const QUOTES = [
  { quote: "The retry loop backs off exponentially.", body: "" },
  { quote: "We cap the queue at 500 items.", body: "Why 500? Measure it first." },
  { quote: "Errors are logged and dropped.", body: "" },
];
const REPLY = "Let's take the other approach in a separate branch.";
const SENT = `${formatPendingComments(QUOTES)}\n\n${REPLY}`;

const timeline = [
  { type: "message", data: { message_uuid: "u0", role: "user", content: "Plan the retry work." } },
  { type: "message", data: { message_uuid: "a1", role: "assistant", content: "The retry loop backs off exponentially.\n\nWe cap the queue at 500 items.\n\nErrors are logged and dropped." } },
  { type: "message", data: { message_uuid: "u2", role: "user", content: SENT } },
];

beforeEach(() => {
  forkedFrom.length = 0;
  useInboxStore.setState({ reviewComments: {} } as any);
});

async function forkFrom(messageUuid: string) {
  const populated: string[] = [];
  let api: ReturnType<typeof useForkActions> | null = null;
  function Probe() {
    api = useForkActions({
      injectSession: () => {},
      conversation: { _id: PARENT_ID, agent_type: "claude_code", messages: timeline.map((t) => t.data) } as any,
      addOptimisticFork: () => {},
      currentUser: { _id: "user_fork_test" },
      hasMoreAbove: false,
      convCommand: async () => ({}),
      timelineRef: { current: timeline },
      populateInputRef: { current: (text: string) => { populated.push(text); } },
      addOptimisticMsg: () => "client",
      sendInlineMessage: () => {},
    });
    return null;
  }
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => root.render(<Probe />));
  await act(async () => { await api!.handleForkFromMessage(messageUuid); });
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
  await act(async () => root.unmount());
  container.remove();
  const forkBatch = useInboxStore.getState().getReviewComments(FORK_ID);
  return { populated, forkBatch };
}

function expectReplyRebuiltInFork(populated: string[], forkBatch: readonly any[]) {
  // The fork's quote batch holds each quote again, as its own item, with its note.
  expect(forkBatch.map((c) => ({ quote: c.quote.trim(), body: c.body.trim() }))).toEqual(QUOTES);
  // Only the typed words go in the box; the quotes are not flattened into it.
  expect(populated.at(-1)).toBe(REPLY);
  // The parent's batch gains nothing.
  expect(useInboxStore.getState().getReviewComments(PARENT_ID)).toHaveLength(0);
}

test("forking from a sent reply reopens its quotes as quote items in the fork", async () => {
  const { populated, forkBatch } = await forkFrom("u2");
  expect(forkedFrom).toEqual(["a1"]);
  expectReplyRebuiltInFork(populated, forkBatch);
}, 15_000);

test("forking from the assistant message just above the reply carries the reply and its quotes", async () => {
  const { populated, forkBatch } = await forkFrom("a1");
  expect(forkedFrom).toEqual(["a1"]);
  expectReplyRebuiltInFork(populated, forkBatch);
}, 15_000);
