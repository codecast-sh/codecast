import { describe, expect, it } from "bun:test";
import { isInboxRoute, isInboxSessionView, resolveSessionSelectKind } from "../inboxRouting";

describe("inboxRouting", () => {
  it("detects real inbox routes", () => {
    expect(isInboxRoute("/inbox")).toBe(true);
    expect(isInboxRoute("/inbox/team")).toBe(true);
    expect(isInboxRoute("/conversation/abc")).toBe(false);
  });

  it("keeps inbox-backed conversation views separate from real inbox routes", () => {
    expect(isInboxRoute("/conversation/abc")).toBe(false);
    expect(isInboxSessionView("/conversation/abc", "inbox")).toBe(true);
    expect(isInboxSessionView("/conversation/abc", "sessions")).toBe(false);
  });
});

describe("resolveSessionSelectKind", () => {
  it("opens a peek column on plain working pages", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: false, isOnInboxPage: false, isOnConversationPage: false,
    })).toBe("peekPanel");
  });

  it("selects in place on the inbox", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: false, isOnInboxPage: true, isOnConversationPage: false,
    })).toBe("inboxInPlace");
  });

  it("leaves the page on a conversation view", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: false, isOnInboxPage: false, isOnConversationPage: true,
    })).toBe("leave");
  });

  // Regression: in Settings the tab-aware pathname reports the carried "/inbox"
  // tab, so isOnInboxPage is spuriously true. Settings must still win and leave
  // the page — otherwise clicking a session selects in place and you stay stuck
  // in Settings (the reported bug).
  it("leaves Settings even when isOnInboxPage is spuriously true", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: true, isOnInboxPage: true, isOnConversationPage: false,
    })).toBe("leave");
  });
});
