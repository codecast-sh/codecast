import { beforeEach, describe, expect, it } from "bun:test";
import { selectColdLoad, selectSyncing, selectSyncSummary } from "./SyncStatusChip";
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
    useInboxStore.setState({ liveLoading: {}, syncProgress: {}, syncLogLag: {}, sessions: {}, tasks: {}, docs: {} } as any);
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

// With the sync log owning catch-up (sync-log-migration.md), a warm cache is
// complete once each scope's cursor reaches its head. The pill must reflect
// THAT, and treat a live first-load as "syncing" only into a cold collection.
describe("sync log era semantics", () => {
  const warm = { sessions: { a: {} }, tasks: { t: {} }, docs: { d: {} } };

  it("does not light for a live first-load into a warm cache", () => {
    expect(selectSyncing({ ...warm, liveLoading: { sessions: true, tasks: true, docs: true } })).toBe(false);
  });

  it("lights for a live first-load into a cold collection only", () => {
    expect(selectSyncing({ ...warm, sessions: {}, liveLoading: { sessions: true, tasks: true } })).toBe(true);
    expect(selectSyncSummary({ ...warm, sessions: {}, liveLoading: { sessions: true, tasks: true } }))
      .toEqual({ settled: 0, total: 1 }); // tasks is warm, not counted
  });

  it("lights while any scope's log cursor is behind its head, and settles at 0", () => {
    expect(selectSyncing({ ...warm, liveLoading: {}, syncLogLag: { "user:u": 12 } })).toBe(true);
    expect(selectSyncSummary({ ...warm, liveLoading: {}, syncLogLag: { "user:u": 12, "team:t": 0 } }))
      .toEqual({ settled: 1, total: 2 });
    expect(selectSyncing({ ...warm, liveLoading: {}, syncLogLag: { "user:u": 0, "team:t": 0 } })).toBe(false);
  });

  it("setSyncLogLag drives the chip through the store", () => {
    useInboxStore.setState({ sessions: { a: {} }, tasks: { t: {} }, docs: { d: {} } } as any);
    const store = useInboxStore.getState();
    store.setLiveLoading("sessions", true); // warm → ignored
    expect(selectSyncing(useInboxStore.getState())).toBe(false);
    store.setSyncLogLag("user:u", 3);
    expect(selectSyncing(useInboxStore.getState())).toBe(true);
    store.setSyncLogLag("user:u", 0);
    expect(selectSyncing(useInboxStore.getState())).toBe(false);
  });
});

// The dot itself shows only for a cold first load; a warm-cache log replay
// (`syncing` true for the sub-second it takes) must not light it. That replay
// happens on every incoming change and is the sync working, not news.
describe("selectColdLoad (what the dot shows without a stall)", () => {
  const warm = { sessions: { a: {} }, tasks: { t: {} }, docs: { d: {} } };

  it("lights for a live first-load into an empty collection", () => {
    expect(selectColdLoad({ ...warm, sessions: {}, liveLoading: { sessions: true } })).toBe(true);
  });

  it("stays dark for a log replay on a warm cache even though syncing is true", () => {
    const replaying = { ...warm, liveLoading: {}, syncLogLag: { "user:u": 2 } };
    expect(selectSyncing(replaying)).toBe(true);
    expect(selectColdLoad(replaying)).toBe(false);
  });

  it("stays dark for a live refresh into a warm collection", () => {
    expect(selectColdLoad({ ...warm, liveLoading: { sessions: true, docs: true } })).toBe(false);
  });
});
