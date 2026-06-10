import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";

// The cross-device "continue where you left off" pointer
// (clientState.current_conversation_id) is one per-user value synced to every
// client. These tests pin the two guards that keep it meaningful:
//  1. Only a focused client may move it — an unfocused tab (vite-reloaded,
//     agent/automation-driven) navigating locally must not repoint every other
//     client, and the palette popup must never write it at all.
//  2. The boot-time restore pull only fires for a client that booted with no
//     position of its own (app root, no ?s=) — a reload on /conversation/<x>
//     or /tasks must stay put instead of teleporting into whatever
//     conversation another client last opened.
// Regression for the "desktop app keeps switching into a random agent
// session" bug (ct-36620).

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
    pendingNavigateId: null,
    viewingDismissedId: null,
    pending: {},
  });
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
});

describe("current_conversation_id foreground write gate", () => {
  beforeEach(resetStore);

  it("moves the pointer from a focused client", () => {
    (globalThis as any).document = { hasFocus: () => true };
    useInboxStore.getState().setCurrentSession("convA");
    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBe("convA");
    expect(s.clientState.current_conversation_id).toBe("convA");
  });

  it("navigates locally but does NOT move the pointer from an unfocused client", () => {
    (globalThis as any).document = { hasFocus: () => false };
    useInboxStore.getState().setCurrentSession("convA");
    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBe("convA");
    expect(s.clientState.current_conversation_id).toBe("convB");
  });

  it("never moves the pointer from the palette popup window", () => {
    (globalThis as any).document = { hasFocus: () => true };
    (globalThis as any).window = { location: { pathname: "/palette", search: "" } };
    useInboxStore.getState().setCurrentSession("convA");
    expect(useInboxStore.getState().clientState.current_conversation_id).toBe("convB");
  });

  it("writes unconditionally on native (no document)", () => {
    useInboxStore.getState().setCurrentSession("convA");
    expect(useInboxStore.getState().clientState.current_conversation_id).toBe("convA");
  });
});

describe("boot-time restore pull (clientState first sync)", () => {
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

  it("pulls at the app root (no URL — native — counts as root)", () => {
    firstSync();
    expect(useInboxStore.getState().pendingNavigateId).toBe("convZ");
  });

  it("pulls on a bare /inbox boot", () => {
    (globalThis as any).window = { location: { pathname: "/inbox", search: "" } };
    firstSync();
    expect(useInboxStore.getState().pendingNavigateId).toBe("convZ");
  });

  it("stays put when the boot URL already targets a session (?s=)", () => {
    (globalThis as any).window = { location: { pathname: "/inbox", search: "?s=convA" } };
    firstSync();
    expect(useInboxStore.getState().pendingNavigateId).toBeNull();
  });

  it("stays put when booted on a conversation page", () => {
    (globalThis as any).window = { location: { pathname: "/conversation/convA", search: "" } };
    firstSync();
    expect(useInboxStore.getState().pendingNavigateId).toBeNull();
  });

  it("stays put on any other surface (e.g. /tasks)", () => {
    (globalThis as any).window = { location: { pathname: "/tasks", search: "" } };
    firstSync();
    expect(useInboxStore.getState().pendingNavigateId).toBeNull();
  });

  it("never pulls on subsequent (initialized) syncs", () => {
    useInboxStore.setState({ clientStateInitialized: true });
    firstSync();
    expect(useInboxStore.getState().pendingNavigateId).toBeNull();
  });
});
