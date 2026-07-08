import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { _resetViewNavForTests, declareViewNav, getNavLog, hasViewNavigated } from "../viewNav";

// The view-motion guard (viewNav.ts + mutativeMiddleware): "which conversation
// is the user looking at" may only change through a write that declares a
// source. An undeclared change to ANOTHER conversation is reverted and logged
// — both through store actions (patch inspection) and raw setState (wrapper).
// Machine selection ("adopt") is boot-only. Regression for the recurring
// "desktop randomly jumps to another session" class (ct-37102, round 3).

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
  _resetViewNavForTests();
  declareViewNav("gesture");
  useInboxStore.setState({
    sessions: { convA: session("convA"), convB: session("convB") },
    conversations: {},
    clientState: {},
    clientStateInitialized: true,
    currentSessionId: "convA",
    lastFocusedConversationId: null,
    pendingNavigateId: null,
    viewingDismissedId: null,
    showMySessions: false,
    pending: {},
  });
  _resetViewNavForTests(); // the seed write above must not count as a view motion
}

beforeEach(resetStore);
afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
});

describe("raw setState writes", () => {
  it("drops an undeclared jump to another conversation and logs it", () => {
    useInboxStore.setState({ currentSessionId: "convB" });
    expect(useInboxStore.getState().currentSessionId).toBe("convA");
    const last = getNavLog().at(-1)!;
    expect(last.blocked).toBeTruthy();
    expect(last.to).toBe("convB");
  });

  it("drops an undeclared pendingNavigateId and keeps sibling keys", () => {
    useInboxStore.setState({ pendingNavigateId: "convB", showMySessions: true } as any);
    const s = useInboxStore.getState();
    expect(s.pendingNavigateId).toBeNull();
    expect(s.showMySessions).toBe(true);
  });

  it("allows clearing to null without a declared source", () => {
    useInboxStore.setState({ currentSessionId: null });
    expect(useInboxStore.getState().currentSessionId).toBeNull();
  });

  it("applies a declared write", () => {
    declareViewNav("boot-restore");
    useInboxStore.setState({ currentSessionId: "convB" });
    expect(useInboxStore.getState().currentSessionId).toBe("convB");
    expect(hasViewNavigated()).toBe(true);
  });

  it("a declared token is one-shot — the next undeclared write is still blocked", () => {
    declareViewNav("gesture");
    useInboxStore.setState({ currentSessionId: "convB" });
    useInboxStore.setState({ currentSessionId: "convA" });
    expect(useInboxStore.getState().currentSessionId).toBe("convB");
  });
});

describe("store actions", () => {
  it("setCurrentSession (gesture) applies and is audited", () => {
    useInboxStore.getState().setCurrentSession("convB");
    expect(useInboxStore.getState().currentSessionId).toBe("convB");
    const last = getNavLog().at(-1)!;
    expect(last.source).toBe("gesture");
    expect(last.blocked).toBeUndefined();
  });

  it("requestNavigate sets target + scroll target atomically", () => {
    useInboxStore.getState().requestNavigate("convZ", { scrollToMessageId: "m1" });
    const s = useInboxStore.getState();
    expect(s.pendingNavigateId).toBe("convZ");
    expect(s.pendingScrollToMessageId).toBe("m1");
  });
});

describe("adopt is boot-only", () => {
  it("adopts when there is no view and hydration is done", () => {
    useInboxStore.setState({ currentSessionId: null });
    useInboxStore.getState().setCurrentSession("convB", "adopt");
    expect(useInboxStore.getState().currentSessionId).toBe("convB");
  });

  it("is rejected before hydration", () => {
    useInboxStore.setState({ currentSessionId: null, clientStateInitialized: false });
    useInboxStore.getState().setCurrentSession("convB", "adopt");
    expect(useInboxStore.getState().currentSessionId).toBeNull();
  });

  it("is rejected once any view has been shown (mid-session null must stay empty)", () => {
    useInboxStore.getState().setCurrentSession("convB"); // a real gesture happened
    useInboxStore.setState({ currentSessionId: null }); // e.g. background stub discard
    useInboxStore.getState().setCurrentSession("convA", "adopt");
    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBeNull();
    expect(getNavLog().at(-1)!.blocked).toContain("adopt");
  });

  it("the sessions-sync fallback no longer adopts after a view existed", () => {
    useInboxStore.getState().setCurrentSession("convB");
    useInboxStore.setState({ currentSessionId: null });
    useInboxStore.getState().syncTable("sessions", [
      { ...session("convA"), updated_at: 10 },
      { ...session("convB"), updated_at: 5 },
    ]);
    expect(useInboxStore.getState().currentSessionId).toBeNull();
  });
});
