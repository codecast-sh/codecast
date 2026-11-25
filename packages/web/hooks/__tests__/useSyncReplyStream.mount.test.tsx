import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// The reply-stream feeder files each answer under the conversation it answers.
// A coalesced apply runs after its window, by which time the view may show
// another conversation; an answer for A must then neither create nor delete
// B's row.

// pretendToBeVisual: the document reads as visible, as an open tab does.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
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
let authSettled = true;
const realAuth = { ...(await import("../useServerAuthSettled")) };
mock.module("../useServerAuthSettled", () => ({ ...realAuth, useServerAuthSettled: () => authSettled, useServerIdentityLost: () => false }));
// The lease renewal (replyStreams.watch): every call's conversation, in order.
let watched: string[] = [];
const realConvexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...realConvexReact,
  useMutation: () => async (args: { conversation_id: string }) => { watched.push(args.conversation_id); return null; },
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { flushSyncPublishes } = await import("../../store/syncTransaction");
const { useSyncReplyStream, createReplyStreamWatcher } = await import("../useSyncReplyStream");
const { REPLY_STREAM_WATCH_RENEW_MS } = await import("@codecast/shared/contracts");

const A = "jx7" + "a".repeat(29);
const B = "jx7" + "b".repeat(29);

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});
beforeEach(() => {
  answers = {};
  watched = [];
  authSettled = true;
  useInboxStore.getState().dropRows("replyStreams", [A, B]);
});

function Feeder({ conversationId, on = true }: { conversationId: string; on?: boolean }) {
  useSyncReplyStream(conversationId, on);
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

// --- The lease (replyStreams.watch) -----------------------------------------

test("the lease is taken once on mount, only when the feeder is live", async () => {
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(<Feeder conversationId={A} />); });
  expect(watched).toEqual([A]);
  await act(async () => { root.unmount(); });

  watched = [];
  const off = createRoot(document.createElement("div"));
  await act(async () => { off.render(<Feeder conversationId={A} on={false} />); });
  expect(watched).toEqual([]);
  await act(async () => { off.unmount(); });

  authSettled = false;
  const early = createRoot(document.createElement("div"));
  await act(async () => { early.render(<Feeder conversationId={A} />); });
  expect(watched).toEqual([]);
  // Settling starts it.
  authSettled = true;
  await act(async () => { early.render(<Feeder conversationId={A} />); });
  expect(watched).toEqual([A]);
  await act(async () => { early.unmount(); });

  watched = [];
  const stub = createRoot(document.createElement("div"));
  await act(async () => { stub.render(<Feeder conversationId="temp_session_123" />); });
  expect(watched).toEqual([]);
  await act(async () => { stub.unmount(); });
});

test("a switch takes the new conversation's lease at once and drops the old one's", async () => {
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(<Feeder conversationId={A} />); });
  await act(async () => { root.render(<Feeder conversationId={B} />); });
  expect(watched).toEqual([A, B]);
  // A renewal later (the tab shown again after a renew interval): B only.
  const realNow = Date.now;
  let shift = REPLY_STREAM_WATCH_RENEW_MS;
  Date.now = () => realNow() + shift;
  try {
    await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
    expect(watched).toEqual([A, B, B]);
    // Unmounted: nothing renews any more.
    await act(async () => { root.unmount(); });
    shift = 3 * REPLY_STREAM_WATCH_RENEW_MS;
    await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
    expect(watched).toEqual([A, B, B]);
  } finally {
    Date.now = realNow;
  }
});

// The timing, with an injected clock and timers.
function fakeClock() {
  let now = 1_000_000;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    pending: () => timers.size,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

test("renewed every renew interval while visible; nothing while hidden; at once on becoming visible", () => {
  const clock = fakeClock();
  let visible = true;
  const sent: number[] = [];
  const w = createReplyStreamWatcher({ ...clock, visible: () => visible, send: async () => { sent.push(clock.now()); } });
  w.start();
  expect(sent).toEqual([1_000_000]);
  clock.advance(REPLY_STREAM_WATCH_RENEW_MS - 1);
  expect(sent.length).toBe(1);
  clock.advance(1);
  expect(sent).toEqual([1_000_000, 1_000_000 + REPLY_STREAM_WATCH_RENEW_MS]);
  visible = false;
  clock.advance(5 * REPLY_STREAM_WATCH_RENEW_MS);
  expect(sent.length).toBe(2);
  // Back on screen: the last renewal is old, so at once.
  visible = true;
  w.visibilityChanged();
  expect(sent.length).toBe(3);
  expect(sent[2]).toBe(clock.now());
  // ... and the clock restarts from there.
  clock.advance(REPLY_STREAM_WATCH_RENEW_MS - 1);
  expect(sent.length).toBe(3);
  clock.advance(1);
  expect(sent.length).toBe(4);
  // Visible again soon after a renewal: nothing extra.
  w.visibilityChanged();
  expect(sent.length).toBe(4);
  w.stop();
  expect(clock.pending()).toBe(0);
  clock.advance(10 * REPLY_STREAM_WATCH_RENEW_MS);
  expect(sent.length).toBe(4);
});

test("a hidden page takes no lease on start, and takes it when it shows", () => {
  const clock = fakeClock();
  let visible = false;
  let sent = 0;
  const w = createReplyStreamWatcher({ ...clock, visible: () => visible, send: async () => { sent++; } });
  w.start();
  expect(sent).toBe(0);
  visible = true;
  w.visibilityChanged();
  expect(sent).toBe(1);
  w.stop();
});

test("a failing renewal is silent and the next one still fires", async () => {
  const clock = fakeClock();
  let calls = 0;
  const w = createReplyStreamWatcher({
    ...clock,
    visible: () => true,
    send: () => { calls++; return calls === 1 ? Promise.reject(new Error("Could not find public function for 'replyStreams:watch'")) : Promise.resolve(null); },
  });
  w.start();
  await Promise.resolve();
  expect(calls).toBe(1);
  // Not retried in a tight loop: only on the next interval.
  clock.advance(REPLY_STREAM_WATCH_RENEW_MS - 1);
  expect(calls).toBe(1);
  clock.advance(1);
  expect(calls).toBe(2);
  // A synchronous throw is as silent.
  const t = createReplyStreamWatcher({ ...clock, visible: () => true, send: () => { throw new Error("boom"); } });
  expect(() => t.start()).not.toThrow();
  w.stop();
  t.stop();
});
