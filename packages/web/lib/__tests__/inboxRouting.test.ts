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
      isOnSettingsPage: false, isOnInboxPage: false,
    })).toBe("leave");
  });

  // A working page (tasks/docs/plans) is no different: a click takes the
  // conversation to the stage. Side by side is a drag, never a click.
  it("leaves the page on a working surface too", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: false, isOnInboxPage: false,
    })).toBe("leave");
  });

  it("selects in place on the inbox", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: false, isOnInboxPage: true,
    })).toBe("inboxInPlace");
  });

  // Regression: in Settings the tab-aware pathname reports the carried "/inbox"
  // tab, so isOnInboxPage is spuriously true. Settings must still win and leave
  // the page — otherwise clicking a session selects in place and you stay stuck
  // in Settings (the reported bug).
  it("leaves Settings even when isOnInboxPage is spuriously true", () => {
    expect(resolveSessionSelectKind({
      isOnSettingsPage: true, isOnInboxPage: true,
    })).toBe("leave");
  });
});
