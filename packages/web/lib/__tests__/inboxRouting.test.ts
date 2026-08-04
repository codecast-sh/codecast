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
  it("promotes to the stage (leave) on plain pages with no working surface", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: false, isOnInboxPage: false, isOnConversationPage: false,
    })).toBe("leave");
  });

  // The stage's second pane: a task/doc already owns the stage, so a clicked
  // session opens BESIDE it rather than replacing the page.
  it("opens beside the page on a working surface (tasks/docs/plans)", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: false, isOnInboxPage: false, isOnConversationPage: false, isOnWorkingPage: true,
    })).toBe("companion");
  });

  // Precedence: the inbox IS conversations — never open a companion there.
  it("keeps in-place selection on the inbox even if a working flag leaks in", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: false, isOnInboxPage: true, isOnConversationPage: false, isOnWorkingPage: true,
    })).toBe("inboxInPlace");
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
