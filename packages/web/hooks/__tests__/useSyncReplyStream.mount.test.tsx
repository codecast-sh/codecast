import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// The reply-stream feeder files each answer under the conversation it answers.
// A coalesced apply runs after its window, by which time the view may show
// another conversation; an answer for A must then neither create nor delete
// B's row.

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

// The subscription's answer, per test: what useQueryNoThrow hands the feeder
// for the args of the current render.
let answers: Record<string, unknown> = {};
const realQuery = { ...(await import("../useQueryNoThrow")) };
mock.module("../useQueryNoThrow", () => ({
  ...realQuery,
  useQueryNoThrow: (_q: unknown, args: any) => ({ data: args === "skip" ? undefined : answers[args.conversation_id], error: undefined, retry: () => {} }),
}));
const realAuth = { ...(await import("../useServerAuthSettled")) };
mock.module("../useServerAuthSettled", () => ({ ...realAuth, useServerAuthSettled: () => true, useServerIdentityLost: () => false }));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { flushSyncPublishes } = await import("../../store/syncTransaction");
const { useSyncReplyStream } = await import("../useSyncReplyStream");

const A = "jx7" + "a".repeat(29);
const B = "jx7" + "b".repeat(29);

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});
beforeEach(() => {
  answers = {};
  useInboxStore.getState().dropRows("replyStreams", [A, B]);
});

function Feeder({ conversationId }: { conversationId: string }) {
  useSyncReplyStream(conversationId, true);
  return null;
}
const rowFor = (conv: string, text: string, seq = 1) => ({ conversation_id: conv, message_id: `hook-${conv.slice(-1)}`, text, seq, started_at: Date.now(), updated_at: Date.now() });
const streams = () => (useInboxStore.getState() as any).replyStreams as Record<string, any>;
// Past the coalescing window, then let the store tell its subscribers.
const flushApplies = () => act(async () => { await new Promise((r) => setTimeout(r, 250)); flushSyncPublishes(); });

test("an answer for A still pending when the view moves to B lands under A, never B", async () => {
  const root = createRoot(document.createElement("div"));
  answers[A] = rowFor(A, "Reply being written in A");
  await act(async () => { root.render(<Feeder conversationId={A} />); });
  // Switch before A's coalesced apply runs; B has not answered yet.
  await act(async () => { root.render(<Feeder conversationId={B} />); });
  await flushApplies();
  expect(streams()[B]).toBeUndefined();
  expect(streams()[A]?.text).toBe("Reply being written in A");
  await act(async () => { root.unmount(); });
});

test("A's empty answer pending at the switch does not drop B's row", async () => {
  useInboxStore.getState().syncTable("replyStreams", [{ ...rowFor(B, "Reply being written in B"), _id: B, received_at: Date.now() }]);
  const root = createRoot(document.createElement("div"));
  answers[A] = null;
  await act(async () => { root.render(<Feeder conversationId={A} />); });
  await act(async () => { root.render(<Feeder conversationId={B} />); });
  await flushApplies();
  expect(streams()[B]?.text).toBe("Reply being written in B");
  await act(async () => { root.unmount(); });
});

test("B's own empty answer drops B's row, and a row naming another conversation is ignored", async () => {
  useInboxStore.getState().syncTable("replyStreams", [{ ...rowFor(B, "Old reply in B"), _id: B, received_at: Date.now() }]);
  const root = createRoot(document.createElement("div"));
  answers[B] = null;
  await act(async () => { root.render(<Feeder conversationId={B} />); });
  await flushApplies();
  expect(streams()[B]).toBeUndefined();
  answers[B] = rowFor(A, "A's row answered for B");
  await act(async () => { root.render(<Feeder conversationId={B} />); });
  await act(async () => { root.render(<Feeder conversationId={A} />); });
  await act(async () => { root.render(<Feeder conversationId={B} />); });
  await flushApplies();
  expect(streams()[B]).toBeUndefined();
  expect(streams()[A]).toBeUndefined();
  await act(async () => { root.unmount(); });
});

test("the same push seen again keeps its receipt time; a new one is stamped no later than the server's clock allows", async () => {
  const root = createRoot(document.createElement("div"));
  const old = { ...rowFor(A, "Stuck reply"), updated_at: Date.now() - 10 * 60_000 };
  answers[A] = old;
  await act(async () => { root.render(<Feeder conversationId={A} />); });
  await flushApplies();
  const first = streams()[A].received_at;
  expect(first).toBeLessThan(Date.now() - 9 * 60_000);
  // A revisit gets the same row again (a fresh answer object).
  answers[A] = { ...old };
  await act(async () => { root.render(<Feeder conversationId={B} />); });
  await act(async () => { root.render(<Feeder conversationId={A} />); });
  await flushApplies();
  expect(streams()[A].received_at).toBe(first);
  await act(async () => { root.unmount(); });
});
