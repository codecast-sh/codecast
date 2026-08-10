import { beforeEach, describe, expect, it } from "bun:test";
import { openConversationAsCompanion, resolveLinkedSessionOpen } from "../useOpenLinkedSession";
import { resolveSessionSelectKind } from "../../lib/inboxRouting";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { companionId } from "../../store/workspace";
import { declareViewNav } from "../../store/viewNav";

const kindFor = (surface: Partial<Parameters<typeof resolveSessionSelectKind>[0]>) =>
  resolveSessionSelectKind({
    isOnSettingsPage: false,
    isOnInboxPage: false,
    isOnConversationPage: false,
    ...surface,
  });

describe("resolveLinkedSessionOpen", () => {
  // Regression: workflow-widget agent rows inside an inbox conversation were a
  // dead click -- the hook always called openSidePanel, but the side-column
  // conversation peek doesn't render on the inbox page (DashboardLayout gates
  // showConversationColumn on !isOnInboxPage), so nothing opened.
  it("selects in place on the inbox page instead of peeking", () => {
    expect(resolveLinkedSessionOpen(kindFor({ isOnInboxPage: true }), false)).toBe("select");
  });

  it("routes to the conversation page from a full conversation page", () => {
    // A stale sidePanelSessionId is actively cleared on conversation pages, so
    // a peek there is also a dead end; the universal /conversation/<id> target
    // works for both owners (redirect into inbox) and guests (viewer).
    expect(resolveLinkedSessionOpen(kindFor({ isOnConversationPage: true }), false)).toBe("route");
  });

  it("routes to the stage from pages with no working surface", () => {
    expect(resolveLinkedSessionOpen(kindFor({}), false)).toBe("route");
  });

  it("opens beside the page from a task/doc (the stage's second pane)", () => {
    expect(resolveLinkedSessionOpen(kindFor({ isOnWorkingPage: true }), false)).toBe("companion");
  });

  it("still routes on narrow viewports from a working page (no room to split)", () => {
    expect(resolveLinkedSessionOpen(kindFor({ isOnWorkingPage: true }), true)).toBe("route");
  });

  it("routes on narrow viewports regardless of surface", () => {
    expect(resolveLinkedSessionOpen(kindFor({}), true)).toBe("route");
    expect(resolveLinkedSessionOpen(kindFor({ isOnInboxPage: true }), true)).toBe("route");
  });

  it("routes from Settings, where selecting a session means leaving", () => {
    expect(resolveLinkedSessionOpen(kindFor({ isOnSettingsPage: true, isOnInboxPage: true }), false)).toBe("route");
  });
});

describe("openConversationAsCompanion", () => {
  const session = (id: string, extra?: Partial<InboxSession>): InboxSession => ({
    _id: id,
    session_id: `s-${id}`,
    updated_at: Date.now(),
    agent_type: "claude_code",
    message_count: 1,
    is_idle: true,
    has_pending: false,
    ...extra,
  });

  beforeEach(() => {
    declareViewNav("gesture");
    useInboxStore.setState({
      sessions: { a: session("a"), b: session("b"), hidden: session("hidden", { inbox_stashed_at: Date.now() }) },
      currentSessionId: "a",
      viewingDismissedId: null,
    } as any);
  });

  // Regression: clicking a task's linked session only called wsShow, so
  // DashboardLayout's mirror effect (companion follows the ATTENDED
  // conversation) snapped the pane straight back to the previous session.
  // The gesture must move the attended pointer along with the pane.
  it("shows the pane AND moves the attended pointer", () => {
    openConversationAsCompanion("b");
    const s = useInboxStore.getState();
    expect(companionId(s.workspace as any)).toBe("b");
    expect(s.currentSessionId).toBe("b");
  });

  it("attends a hidden session via the dismissed peek", () => {
    openConversationAsCompanion("hidden");
    const s = useInboxStore.getState();
    expect(companionId(s.workspace as any)).toBe("hidden");
    // navigateToSession never resurrects a hidden session; the peek pointer is
    // what the layout's mirror must read first or the click is dead.
    expect(s.viewingDismissedId).toBe("hidden");
    expect(s.viewingDismissedId ?? s.currentSessionId).toBe("hidden");
  });
});
