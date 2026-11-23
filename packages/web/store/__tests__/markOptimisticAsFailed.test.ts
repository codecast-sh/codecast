import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

describe("marking a pending send failed", () => {
  beforeEach(() => {
    useInboxStore.setState({ messages: {}, pendingMessages: {}, pagination: {} });
  });

  // The coverage poll re-marks a refused send every minute in every window;
  // each re-mark was a fresh row and a rewrite of its journal row on disk.
  it("marking an already failed send failed again changes nothing", () => {
    const store = useInboxStore.getState();
    const clientId = store.addOptimisticMessage("c1", "retry me");
    store.markOptimisticAsFailed("c1", clientId);
    const before = useInboxStore.getState().pendingMessages;
    store.markOptimisticAsFailed("c1", clientId);
    expect(useInboxStore.getState().pendingMessages).toBe(before);
  });
});
