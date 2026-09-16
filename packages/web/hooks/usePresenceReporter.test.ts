import { describe, expect, test } from "bun:test";
import {
  VIEW_BLUR_CLEAR_MS,
  VIEW_THROTTLE_MS,
  createPresenceReporter,
  viewedConversationId,
  type PresenceReport,
} from "./usePresenceReporter";

// The timing rules of the presence reporter, run against a fake clock: a view
// change goes out promptly and throttled, a blurred window stops naming its
// view after the idle threshold, and focus brings it back. The heartbeat gap
// is untouched by any of it.

const CONV_A = "a".repeat(32);
const CONV_B = "b".repeat(32);

function harness(opts: { focused?: boolean; canSend?: boolean } = {}) {
  let now = 1_000_000;
  let focused = opts.focused ?? true;
  let canSend = opts.canSend ?? true;
  let viewing: string | null = null;
  const sent: Array<PresenceReport & { at: number }> = [];
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextTimer = 1;
  const reporter = createPresenceReporter({
    now: () => now,
    send: (r) => sent.push({ ...r, at: now }),
    idleMs: async (floor) => now - floor,
    canSend: () => canSend,
    focused: () => focused,
    viewing: () => viewing,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i !== -1) timers.splice(i, 1);
    },
  });
  // Sends resolve on a microtask (idleMs is async); flush them between steps.
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.fn();
      await settle();
    }
    now = target;
    await settle();
  };
  return {
    reporter,
    sent,
    settle,
    advance,
    setView: async (id: string | null) => {
      viewing = id;
      reporter.viewChanged();
      await settle();
    },
    setFocused: (f: boolean) => {
      focused = f;
    },
    setCanSend: (c: boolean) => {
      canSend = c;
    },
    views: () => sent.map((r) => r.viewing_conversation_id ?? null),
  };
}

describe("createPresenceReporter", () => {
  test("a view change sends promptly, and the heartbeat still names the view", async () => {
    const h = harness();
    h.reporter.heartbeat();
    await h.settle();
    expect(h.views()).toEqual([null]);
    await h.advance(VIEW_THROTTLE_MS + 1);
    await h.setView(CONV_A);
    expect(h.views()).toEqual([null, CONV_A]);
    // The next regular beat carries it too: the id rides every report.
    await h.advance(30_000);
    h.reporter.heartbeat();
    await h.settle();
    expect(h.views()).toEqual([null, CONV_A, CONV_A]);
  });

  test("changes inside the throttle window collapse into one trailing send with the last view", async () => {
    const h = harness();
    await h.setView(CONV_A);
    expect(h.views()).toEqual([CONV_A]);
    await h.advance(500);
    await h.setView(CONV_B);
    await h.advance(500);
    await h.setView(null);
    await h.advance(200);
    await h.setView(CONV_B);
    // Nothing more yet: the throttle holds.
    expect(h.sent.length).toBe(1);
    await h.advance(VIEW_THROTTLE_MS);
    expect(h.views()).toEqual([CONV_A, CONV_B]);
    expect(h.sent[1].at - h.sent[0].at).toBe(VIEW_THROTTLE_MS);
  });

  test("an unchanged view does not send outside the heartbeat", async () => {
    const h = harness();
    await h.setView(CONV_A);
    await h.advance(VIEW_THROTTLE_MS + 1);
    h.reporter.viewChanged();
    await h.settle();
    expect(h.sent.length).toBe(1);
    // A beat inside the 10s gap is dropped, as before.
    h.reporter.heartbeat();
    await h.settle();
    expect(h.sent.length).toBe(1);
  });

  test("blur beyond the idle threshold clears the view; focus restores it", async () => {
    const h = harness();
    await h.setView(CONV_A);
    h.setFocused(false);
    h.reporter.blur();
    // Short blurs (a glance at the terminal) keep the session open.
    await h.advance(VIEW_BLUR_CLEAR_MS - 1000);
    expect(h.views()).toEqual([CONV_A]);
    await h.advance(2000);
    expect(h.views()).toEqual([CONV_A, null]);
    expect(h.sent[1].focused).toBe(false);
    h.setFocused(true);
    h.reporter.focus();
    // The restore honors the same throttle as any view change.
    await h.advance(VIEW_THROTTLE_MS);
    expect(h.views()).toEqual([CONV_A, null, CONV_A]);
    expect(h.sent[2].focused).toBe(true);
  });

  test("a hidden tab sends nothing until it is visible again", async () => {
    const h = harness();
    await h.setView(CONV_A);
    h.setCanSend(false);
    h.reporter.blur();
    await h.advance(VIEW_BLUR_CLEAR_MS + 60_000);
    h.reporter.heartbeat();
    await h.settle();
    expect(h.sent.length).toBe(1);
    h.setCanSend(true);
    h.reporter.focus();
    await h.settle();
    // Focus returned before any send, so the view never left: nothing changed
    // for a teammate and the heartbeat is the only thing owed.
    expect(h.views()).toEqual([CONV_A, CONV_A]);
  });

  test("stop drops pending timers so an unmounted window never reports", async () => {
    const h = harness();
    await h.setView(CONV_A);
    await h.setView(CONV_B); // trailing send armed
    h.reporter.blur();
    h.reporter.stop();
    await h.advance(VIEW_BLUR_CLEAR_MS + VIEW_THROTTLE_MS);
    expect(h.sent.length).toBe(1);
  });
});

describe("viewedConversationId", () => {
  const sessions = { [CONV_A]: { _id: CONV_A }, "stub-1": { _id: "stub-1" }, "jx7abcd": { _id: CONV_B } };
  const base = {
    activeTabId: null as string | null,
    tabs: [] as { id: string; path: string }[],
    currentSessionId: null as string | null,
    viewingDismissedId: null as string | null,
    sessions,
    currentConversation: {} as { source?: string },
  };

  test("the inbox reports the attended conversation, a dismissed one first", () => {
    expect(viewedConversationId({ ...base, currentSessionId: CONV_A }, "/inbox")).toBe(CONV_A);
    expect(viewedConversationId({ ...base, currentSessionId: CONV_A, viewingDismissedId: "jx7abcd" }, "/inbox")).toBe(CONV_B);
  });

  test("an optimistic stub is not a session a teammate could open", () => {
    expect(viewedConversationId({ ...base, currentSessionId: "stub-1" }, "/inbox")).toBeNull();
  });

  test("a conversation page reports the id in its path", () => {
    expect(viewedConversationId(base, `/conversation/${CONV_A}`)).toBe(CONV_A);
    expect(viewedConversationId(base, `/conversation/${CONV_A}/diff?x=1`)).toBe(CONV_A);
    expect(viewedConversationId(base, "/conversation/jx7abcd")).toBeNull();
  });

  test("other pages report nothing, whatever the store still points at", () => {
    expect(viewedConversationId({ ...base, currentSessionId: CONV_A }, "/tasks")).toBeNull();
  });

  test("inside the tab shell the active tab's path decides, not the window location", () => {
    const tabs = [{ id: "t1", path: "/tasks" }, { id: "t2", path: `/inbox?s=${CONV_A}` }];
    expect(viewedConversationId({ ...base, activeTabId: "t1", tabs, currentSessionId: CONV_A }, "/inbox")).toBeNull();
    expect(viewedConversationId({ ...base, activeTabId: "t2", tabs, currentSessionId: CONV_A }, "/tasks")).toBe(CONV_A);
  });
});
