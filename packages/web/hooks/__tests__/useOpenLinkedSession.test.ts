import { describe, expect, it } from "bun:test";
import { resolveLinkedSessionOpen } from "../useOpenLinkedSession";
import { resolveSessionSelectKind } from "../../lib/inboxRouting";

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

  it("keeps the side-column peek on working pages (tasks, docs, workflows)", () => {
    expect(resolveLinkedSessionOpen(kindFor({}), false)).toBe("peek");
  });

  it("routes on narrow viewports regardless of surface", () => {
    expect(resolveLinkedSessionOpen(kindFor({}), true)).toBe("route");
    expect(resolveLinkedSessionOpen(kindFor({ isOnInboxPage: true }), true)).toBe("route");
  });

  it("routes from Settings, where selecting a session means leaving", () => {
    expect(resolveLinkedSessionOpen(kindFor({ isOnSettingsPage: true, isOnInboxPage: true }), false)).toBe("route");
  });
});
