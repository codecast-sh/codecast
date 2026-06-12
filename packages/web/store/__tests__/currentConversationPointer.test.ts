import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { stripStalePointerFromReplay } from "../mutativeMiddleware";

// "Where the user is" lives in two places (see recordCurrentConversationPointer):
//  - lastFocusedConversationId — THIS client's own position, persisted locally,
//    never synced. The boot-restore source of truth.
//  - clientState.current_conversation_id — the per-user synced pointer, raced
//    by every client (other devices, agent-driven tabs). Consulted only by
//    clients with no local history.
// These tests pin the guards that keep restore un-poisonable:
//  1. Only a focused, non-palette client may move either value.
//  2. A clientState server sync NEVER navigates — restore is selection-only,
//     via hydration (own position) or the sessions-sync fallback.
//  3. The sessions-sync fallback prefers the client's own position and falls
//     back to the top of the inbox — never to the synced pointer — once the
//     client has any history of its own.
//  4. Outbox replays never re-push a stale pointer.
// Regression for the "desktop app keeps switching into a random session" bug
// (ct-36620 round 1, ct-36951 round 2 — round 1 gated the server-sync pull but
// the IDB-hydration restore path was the live door).

const session = (id: string): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 0,
  is_idle: true,
  has_pending: false,
});

function resetStore() {
  useInboxStore.setState({
    sessions: { convA: session("convA"), convB: session("convB") },
    conversations: {},
    clientState: { current_conversation_id: "convB" },
    clientStateInitialized: true,
    currentSessionId: null,
    lastFocusedConversationId: null,
    pendingNavigateId: null,
    viewingDismissedId: null,
    showMySessions: false,
    pending: {},
  });
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
});

describe("conversation position foreground write gate", () => {
  beforeEach(resetStore);

  it("moves both the synced pointer and the local position from a focused client", () => {
    (globalThis as any).document = { hasFocus: () => true };
    useInboxStore.getState().setCurrentSession("convA");
    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBe("convA");
    expect(s.clientState.current_conversation_id).toBe("convA");
    expect(s.lastFocusedConversationId).toBe("convA");
  });

  it("navigates locally but moves NEITHER value from an unfocused client", () => {
    (globalThis as any).document = { hasFocus: () => false };
    useInboxStore.getState().setCurrentSession("convA");
    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBe("convA");
    expect(s.clientState.current_conversation_id).toBe("convB");
    expect(s.lastFocusedConversationId).toBeNull();
  });

  it("never moves either value from the palette popup window", () => {
    (globalThis as any).document = { hasFocus: () => true };
    (globalThis as any).window = { location: { pathname: "/palette", search: "" } };
    useInboxStore.getState().setCurrentSession("convA");
    const s = useInboxStore.getState();
    expect(s.clientState.current_conversation_id).toBe("convB");
    expect(s.lastFocusedConversationId).toBeNull();
  });

  it("writes unconditionally on native (no document)", () => {
    useInboxStore.getState().setCurrentSession("convA");
    const s = useInboxStore.getState();
    expect(s.clientState.current_conversation_id).toBe("convA");
    expect(s.lastFocusedConversationId).toBe("convA");
  });
});

describe("clientState server sync never navigates", () => {
  beforeEach(() => {
    resetStore();
    useInboxStore.setState({
      clientStateInitialized: false,
      clientState: {},
      sessions: {},
    });
  });

  const firstSync = () =>
    useInboxStore.getState().syncTable("clientState", { current_conversation_id: "convZ" });

  it("does not navigate on a first sync at the app root (no URL — native shape)", () => {
    firstSync();
    const s = useInboxStore.getState();
    expect(s.pendingNavigateId).toBeNull();
    expect(s.currentSessionId).toBeNull();
  });

  it("does not navigate on a first sync on /inbox", () => {
    (globalThis as any).window = { location: { pathname: "/inbox", search: "" } };
    firstSync();
    expect(useInboxStore.getState().pendingNavigateId).toBeNull();
  });

  it("does not navigate on later (initialized) syncs", () => {
    useInboxStore.setState({ clientStateInitialized: true });
    firstSync();
    expect(useInboxStore.getState().pendingNavigateId).toBeNull();
  });
});

describe("sessions-sync restore fallback", () => {
  beforeEach(() => {
    resetStore();
    useInboxStore.setState({ sessions: {} });
  });

  const syncSessions = () =>
    useInboxStore.getState().syncTable("sessions", [
      { ...session("convA"), updated_at: 10 },
      { ...session("convB"), updated_at: 5 },
    ]);

  it("restores this client's own position when it exists", () => {
    useInboxStore.setState({ lastFocusedConversationId: "convB" });
    syncSessions();
    expect(useInboxStore.getState().currentSessionId).toBe("convB");
  });

  it("falls back to the synced pointer only on a client with no history", () => {
    useInboxStore.setState({
      lastFocusedConversationId: null,
      clientState: { current_conversation_id: "convB" },
    });
    syncSessions();
    expect(useInboxStore.getState().currentSessionId).toBe("convB");
  });

  it("a client with history whose position is gone falls to the inbox top, NEVER the synced pointer", () => {
    useInboxStore.setState({
      lastFocusedConversationId: "convGone",
      clientState: { current_conversation_id: "convB" },
    });
    syncSessions();
    // convA sorts first (most recent), convB is what a poisoned pointer says.
    expect(useInboxStore.getState().currentSessionId).toBe("convA");
  });

  it("never overrides an existing selection", () => {
    useInboxStore.setState({
      currentSessionId: "convA",
      lastFocusedConversationId: "convB",
    });
    syncSessions();
    expect(useInboxStore.getState().currentSessionId).toBe("convA");
  });
});

describe("stripStalePointerFromReplay (outbox boot replay)", () => {
  it("drops a stale pointer but keeps sibling clientState fields", () => {
    const out = stripStalePointerFromReplay({
      client_state: { _: { current_conversation_id: "convOld", show_dismissed: true } },
    });
    expect(out).toEqual({ client_state: { _: { show_dismissed: true } } });
  });

  it("drops the whole patch when the pointer was its only content", () => {
    const out = stripStalePointerFromReplay({
      client_state: { _: { current_conversation_id: "convOld" } },
    });
    expect(out).toBeUndefined();
  });

  it("keeps other tables when the pointer patch empties out", () => {
    const out = stripStalePointerFromReplay({
      client_state: { _: { current_conversation_id: "convOld" } },
      conversations: { c1: { inbox_dismissed_at: null } },
    });
    expect(out).toEqual({ conversations: { c1: { inbox_dismissed_at: null } } });
  });

  it("passes through patches that don't touch the pointer", () => {
    const patches = { conversations: { c1: { title: "x" } } };
    expect(stripStalePointerFromReplay(patches)).toBe(patches);
    expect(stripStalePointerFromReplay(undefined)).toBeUndefined();
  });
});
