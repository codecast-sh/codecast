import { beforeEach, describe, expect, it } from "bun:test";
import { selectSyncing } from "./SyncStatusChip";
import { useInboxStore } from "../store/inboxStore";

// Regression coverage for the header sync chip. The bug: the chip read
// `syncProgress` (the background reconcile crawl that pages EVERY row at a
// throttled pace and runs for minutes), so on every cold load it went
// "syncing" -> "sync slow" and stayed there. The fix routes the chip to
// `liveLoading` — the first-payload state of the live subscriptions — which is
// bounded to a single round-trip per scope.

describe("selectSyncing", () => {
  it("is idle when no scope is loading", () => {
    expect(selectSyncing({ liveLoading: {} })).toBe(false);
    expect(selectSyncing({ liveLoading: { sessions: false, docs: false, tasks: false } })).toBe(false);
  });

  it("spins while any live first-load is still pending", () => {
    expect(selectSyncing({ liveLoading: { sessions: true } })).toBe(true);
    expect(selectSyncing({ liveLoading: { sessions: false, docs: true } })).toBe(true);
  });

  it("ignores the background reconcile crawl (syncProgress)", () => {
    // The reconcile crawl reports loading:true for the whole multi-minute sweep.
    // The chip must NOT reflect it — only the live first-load matters.
    const reconcileRunningButLiveSettled = {
      liveLoading: { sessions: false, docs: false },
      syncProgress: { docs: { loading: true, loaded: 115 } },
    };
    expect(selectSyncing(reconcileRunningButLiveSettled)).toBe(false);
  });
});

describe("setLiveLoading + chip wiring", () => {
  beforeEach(() => {
    useInboxStore.setState({ liveLoading: {}, syncProgress: {} });
  });

  it("lights the chip on cold open and clears it once live loads land", () => {
    const store = useInboxStore.getState();

    // Cold open: live subscriptions haven't delivered yet.
    store.setLiveLoading("sessions", true);
    store.setLiveLoading("docs", true);
    expect(selectSyncing(useInboxStore.getState())).toBe(true);

    // First payloads arrive.
    store.setLiveLoading("sessions", false);
    expect(selectSyncing(useInboxStore.getState())).toBe(true); // docs still pending
    store.setLiveLoading("docs", false);
    expect(selectSyncing(useInboxStore.getState())).toBe(false);
  });

  it("stays cleared while the reconcile crawl keeps streaming pages in", () => {
    const store = useInboxStore.getState();
    store.setLiveLoading("sessions", false);
    store.setLiveLoading("docs", false);

    // Simulate the reconcile crawl advancing across many pages (what kept the
    // old chip stuck): syncProgress churns but the chip stays dark.
    for (const loaded of [0, 9, 34, 115]) {
      useInboxStore.setState({ syncProgress: { docs: { loading: true, loaded } } });
      expect(selectSyncing(useInboxStore.getState())).toBe(false);
    }
  });
});
