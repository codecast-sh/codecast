import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import {
  HYDRATION_CRITICAL_KEYS,
  META_STORE_KEYS,
  isPersistedClientStoreKey,
} from "../clientSyncRegistry";

// Regression: Ctrl+Enter queued messages used to live only in MessageInput's
// React state, so navigating away or reloading silently dropped them. They now
// live in the store and persist to IDB exactly like drafts — a queued user
// message must never be lost.

describe("queued messages persistence contract", () => {
  it("is a persisted meta key (written to IDB, survives reload) — like drafts", () => {
    expect(isPersistedClientStoreKey("queuedMessages")).toBe(true);
    expect(META_STORE_KEYS).toContain("queuedMessages");
    // Drafts hydrate in the critical pass so the composer shows them on first
    // paint; the queue must be there just as immediately when a conv reopens.
    expect(HYDRATION_CRITICAL_KEYS).toContain("queuedMessages");
    expect(HYDRATION_CRITICAL_KEYS).toContain("drafts");
  });
});

describe("queued messages store API", () => {
  beforeEach(() => {
    useInboxStore.setState({ queuedMessages: {} });
  });

  it("round-trips a queued message by conversation id", () => {
    const s = useInboxStore.getState();
    expect(s.getQueuedMessages("conv1")).toEqual([]);

    s.setQueuedMessagesFor("conv1", ["first", "second"]);
    expect(useInboxStore.getState().getQueuedMessages("conv1")).toEqual(["first", "second"]);
    // Isolated per conversation.
    expect(useInboxStore.getState().getQueuedMessages("conv2")).toEqual([]);
  });

  it("draining the last message removes the entry (no stale empty queue)", () => {
    const s = useInboxStore.getState();
    s.setQueuedMessagesFor("conv1", ["only"]);
    // Mirrors the drain: prev.slice(1) → []
    s.setQueuedMessagesFor("conv1", []);
    expect(useInboxStore.getState().getQueuedMessages("conv1")).toEqual([]);
    expect(useInboxStore.getState().queuedMessages).not.toHaveProperty("conv1");
  });
});
