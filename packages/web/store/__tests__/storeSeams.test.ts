import { afterEach, describe, expect, it } from "bun:test";
import {
  __createInboxStoreForTests,
  __inboxStoreSimSlots,
  computeInboxMembership,
  freshInboxData,
} from "../inboxStore";
import { __gestureBridgeSimSlots, gestureSourceToken } from "../gestureBridge";
import { __syncTransactionIdleForTests, resetSyncTransactionForTests, syncTransaction } from "../syncTransaction";
import { __viewNavSimSlots, _resetViewNavForTests, consumeViewNav, declareViewNav } from "../viewNav";

// The seams the multiplayer sim stands on (docs/architecture/multiplayer-sim-harness.md,
// unit U2). Each window gets its own store instance and its own copy of the
// module bindings that belong to a window; these tests pin that the seams
// really separate them.

function dataOf(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([, v]) => typeof v !== "function"));
}

describe("store instances", () => {
  it("keep their dispatch binding in their own closure", () => {
    const a = __createInboxStoreForTests().getState() as any;
    const b = __createInboxStoreForTests().getState() as any;
    expect(a._isDispatchWired()).toBe(false);
    expect(b._isDispatchWired()).toBe(false);
    a._setDispatch(async () => null);
    expect(a._isDispatchWired()).toBe(true);
    expect(b._isDispatchWired()).toBe(false);
    a._clearRuntimeBindings();
    expect(a._isDispatchWired()).toBe(false);
  });

  it("start from the same data floor freshInboxData() hands out", () => {
    const fresh = freshInboxData();
    expect(fresh).toEqual(dataOf(__createInboxStoreForTests().getInitialState() as any));
    // Every call is a new, unaliased copy.
    const again = freshInboxData();
    expect(again).toEqual(fresh);
    expect(again.sessions).not.toBe(fresh.sessions);
    expect(again.clientState).not.toBe(fresh.clientState);
  });
});

describe("window slots", () => {
  const inbox = __inboxStoreSimSlots();
  const gesture = __gestureBridgeSimSlots();
  const nav = __viewNavSimSlots();

  afterEach(() => {
    inbox.set(inbox.fresh());
    _resetViewNavForTests();
    resetSyncTransactionForTests();
  });

  it("round-trip the inbox store's window bindings as detached snapshots", () => {
    const base = inbox.get();
    const snap = {
      ...inbox.fresh(),
      _heldOverlayFacts: { mine: { s1: { agent_status: "working" } } },
      recentlyRequestedPendingMessages: new Map([["c1", 5]]),
      _userMsgsProbed: new Set(["conv"]),
      hydrationEpoch: 7,
    };
    inbox.set(snap);
    const got = inbox.get();
    expect(got).toEqual(snap);
    // Neither side aliases the live bindings.
    expect(got._heldOverlayFacts).not.toBe(snap._heldOverlayFacts);
    expect(got._heldOverlayFacts.mine).not.toBe(snap._heldOverlayFacts.mine);
    got.recentlyRequestedPendingMessages.set("c2", 9);
    expect(inbox.get().recentlyRequestedPendingMessages.has("c2")).toBe(false);
    inbox.set(base);
    expect(inbox.get()).toEqual(base);
  });

  it("resetMemos drops the derived memos", () => {
    const sessions = {};
    const first = computeInboxMembership(sessions, 1);
    expect(computeInboxMembership(sessions, 1)).toBe(first);
    inbox.resetMemos();
    const after = computeInboxMembership(sessions, 1);
    expect(after).not.toBe(first);
    expect(after).toEqual(first);
  });

  it("swap the gesture bridge identity", () => {
    const own = gestureSourceToken();
    const saved = gesture.get();
    expect(saved).toEqual({ sourceToken: own });
    gesture.set({ sourceToken: "window-b" });
    expect(gestureSourceToken()).toBe("window-b");
    gesture.set(saved);
    expect(gestureSourceToken()).toBe(own);
  });

  it("swap the view-nav intent token and counter", () => {
    declareViewNav("gesture");
    const saved = nav.get();
    expect(saved).toEqual({ pendingSource: "gesture", appliedNavCount: 0 });
    nav.set({ pendingSource: null, appliedNavCount: 3 });
    expect(consumeViewNav()).toBeNull();
    expect(nav.get().appliedNavCount).toBe(3);
    nav.set(saved);
    expect(consumeViewNav()).toBe("gesture");
  });

  it("report a sync transaction as busy only while one is open", () => {
    expect(__syncTransactionIdleForTests()).toBe(true);
    expect(syncTransaction(() => __syncTransactionIdleForTests())).toBe(false);
    expect(__syncTransactionIdleForTests()).toBe(true);
  });
});
