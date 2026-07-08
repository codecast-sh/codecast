import { describe, expect, it } from "bun:test";
import { evictInactiveMessages, MAX_IN_MEMORY_CONVERSATIONS } from "../inboxStore";

// A minimal stand-in for the mutative draft evictInactiveMessages operates on.
// Every loaded conversation ALSO gets a session row — that's the never-prune
// condition that used to defeat the LRU. _lastViewedAt[i] = i, so higher index
// == more recently viewed.
function makeDraft(loadedCount: number, opts: Record<string, any> = {}) {
  const messages: Record<string, any[]> = {};
  const pagination: Record<string, any> = {};
  const userMessages: Record<string, any[]> = {};
  const sessions: Record<string, any> = {};
  const _lastViewedAt: Record<string, number> = {};
  for (let i = 0; i < loadedCount; i++) {
    const id = `conv-${i}`;
    messages[id] = [{ _id: `m-${i}`, role: "user", content: "hi", timestamp: i }];
    pagination[id] = {};
    userMessages[id] = [];
    sessions[id] = { _id: id };
    _lastViewedAt[id] = i;
  }
  return {
    messages,
    pagination,
    userMessages,
    sessions,
    _lastViewedAt,
    pendingMessages: {} as Record<string, any[]>,
    currentSessionId: null,
    sidePanelSessionId: null,
    viewingDismissedId: null,
    currentConversation: null,
    liveInboxIds: new Set<string>(),
    ...opts,
  };
}

describe("evictInactiveMessages", () => {
  it("does nothing at or below the cap", () => {
    const d = makeDraft(MAX_IN_MEMORY_CONVERSATIONS);
    evictInactiveMessages(d, "conv-0");
    expect(Object.keys(d.messages).length).toBe(MAX_IN_MEMORY_CONVERSATIONS);
  });

  it("caps memory even when every conversation also has a session row (the regression)", () => {
    // Pre-fix, the keep-set absorbed all of draft.sessions, so nothing was ever
    // evicted and the store grew without bound. The cap must hold regardless.
    const d = makeDraft(MAX_IN_MEMORY_CONVERSATIONS + 50);
    evictInactiveMessages(d, "conv-0");
    expect(Object.keys(d.messages).length).toBe(MAX_IN_MEMORY_CONVERSATIONS);
  });

  it("evicts least-recently-viewed first, dropping pagination and userMessages in lockstep", () => {
    const d = makeDraft(MAX_IN_MEMORY_CONVERSATIONS + 10);
    evictInactiveMessages(d, "zzz-not-loaded");
    // conv-0..conv-9 are the oldest-viewed → evicted; the newest stay.
    for (let i = 0; i < 10; i++) {
      expect(d.messages[`conv-${i}`]).toBeUndefined();
      expect(d.pagination[`conv-${i}`]).toBeUndefined();
      expect(d.userMessages[`conv-${i}`]).toBeUndefined();
    }
    expect(d.messages[`conv-${MAX_IN_MEMORY_CONVERSATIONS + 9}`]).toBeDefined();
    expect(Object.keys(d.messages).length).toBe(MAX_IN_MEMORY_CONVERSATIONS);
  });

  it("never evicts the on-screen, live, or pending-send conversations", () => {
    const d = makeDraft(MAX_IN_MEMORY_CONVERSATIONS + 5, {
      currentSessionId: "conv-0", // oldest-viewed but on screen
      liveInboxIds: new Set(["conv-1"]), // oldest-viewed but a live agent
    });
    d.pendingMessages["conv-2"] = [{ _id: "p", role: "user", content: "x", timestamp: 0 }];
    evictInactiveMessages(d, "conv-3"); // activeConvId

    expect(d.messages["conv-0"]).toBeDefined(); // protected: current session
    expect(d.messages["conv-1"]).toBeDefined(); // protected: live inbox
    expect(d.messages["conv-2"]).toBeDefined(); // protected: pending send
    expect(d.messages["conv-3"]).toBeDefined(); // protected: active conv
    expect(Object.keys(d.messages).length).toBe(MAX_IN_MEMORY_CONVERSATIONS);
  });
});
