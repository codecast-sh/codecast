import { afterEach, describe, expect, it } from "bun:test";
import { __createInboxStoreForTests, __inboxStoreWindowBindings, useInboxStore } from "../inboxStore";
import { __gestureBridgeSimSlots, gestureSourceToken } from "../gestureBridge";
import { __syncTransactionIdleForTests, resetSyncTransactionForTests, syncTransaction } from "../syncTransaction";
import { __viewNavSimSlots, _resetViewNavForTests, consumeViewNav, declareViewNav } from "../viewNav";
import { freshSlots, restoreSlots, saveSlots } from "./sim/windowSlots";

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

  it("start from the module store's data floor, each with its own copy", () => {
    const a = __createInboxStoreForTests().getInitialState() as any;
    const b = __createInboxStoreForTests().getInitialState() as any;
    expect(dataOf(a)).toEqual(dataOf(useInboxStore.getInitialState() as any));
    expect(a.sessions).not.toBe(b.sessions);
    expect(a.clientState).not.toBe(b.clientState);
  });
});

describe("window slots", () => {
  const INBOX = "store/inboxStore.ts";
  const gesture = __gestureBridgeSimSlots();
  const nav = __viewNavSimSlots();

  afterEach(() => {
    restoreSlots(freshSlots());
    _resetViewNavForTests();
    resetSyncTransactionForTests();
  });

  it("round-trip the inbox store's window bindings as detached snapshots", () => {
    const base = saveSlots();
    const fresh = freshSlots();
    const inbox = {
      ...(fresh[INBOX] as any),
      _heldOverlayFacts: { mine: { s1: { agent_status: "working" } } },
      recentlyRequestedPendingMessages: new Map([["c1", 5]]),
      _userMsgsProbed: new Set(["conv"]),
      deferredDeletedSessions: new Set(["gone"]),
      hydrationEpoch: 7,
    };
    restoreSlots({ ...fresh, [INBOX]: inbox });
    // The store's own bindings took the values: by-value ones through set(), collections refilled in place.
    const live = __inboxStoreWindowBindings.get();
    expect(live.hydrationEpoch).toBe(7);
    expect([...live.deferredDeletedSessions]).toEqual(["gone"]);
    const got = saveSlots()[INBOX] as any;
    expect(got).toEqual(inbox);
    // Neither side aliases the live bindings.
    expect(live._heldOverlayFacts).not.toBe(inbox._heldOverlayFacts);
    expect(got._heldOverlayFacts.mine).not.toBe(live._heldOverlayFacts.mine);
    expect(got.recentlyRequestedPendingMessages).not.toBe(live.recentlyRequestedPendingMessages);
    got.recentlyRequestedPendingMessages.set("c2", 9);
    expect(live.recentlyRequestedPendingMessages.has("c2")).toBe(false);
    restoreSlots(base);
    expect(saveSlots()).toEqual(base);
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
