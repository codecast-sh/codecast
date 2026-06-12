import { test, expect, describe } from "bun:test";
import {
  buildDesktopDeepLink,
  parseDesktopDeepLinkPath,
  isHandoffEligiblePath,
  shouldAttemptHandoff,
  type HandoffContext,
} from "./desktop";

// A context that passes every gate; each test overrides one field to prove that
// field is load-bearing.
const PASSING: HandoffContext = {
  isDesktop: false,
  initialized: true,
  hasUsedDesktop: true,
  preferBrowser: false,
  isTopWindow: true,
  foreground: true,
  host: "codecast.sh",
  freshNavigation: true,
  path: "/conversation/jx7c89",
  search: "",
};

describe("buildDesktopDeepLink", () => {
  test("nests the route under the 'open' host", () => {
    expect(buildDesktopDeepLink("/conversation/jx7c89")).toBe("codecast://open/conversation/jx7c89");
  });

  test("preserves the query string", () => {
    expect(buildDesktopDeepLink("/tasks/ct-1?tab=files")).toBe("codecast://open/tasks/ct-1?tab=files");
  });

  test("tolerates a path missing its leading slash", () => {
    expect(buildDesktopDeepLink("plans/pl-9")).toBe("codecast://open/plans/pl-9");
  });
});

describe("parseDesktopDeepLinkPath", () => {
  test("round-trips a built link, keeping the full path", () => {
    const link = buildDesktopDeepLink("/conversation/jx7c89");
    expect(parseDesktopDeepLinkPath(link)).toBe("/conversation/jx7c89");
  });

  test("round-trips a link with a query string", () => {
    const link = buildDesktopDeepLink("/tasks/ct-1?tab=files");
    expect(parseDesktopDeepLinkPath(link)).toBe("/tasks/ct-1?tab=files");
  });

  // The bug the 'open' host guards against: a bare scheme parses the first
  // segment as the host. We still recover it rather than dropping it.
  test("recovers the legacy host-as-segment shape", () => {
    expect(parseDesktopDeepLinkPath("codecast://conversation/jx7c89")).toBe("/conversation/jx7c89");
  });

  test("handles a triple-slash (empty host) link", () => {
    expect(parseDesktopDeepLinkPath("codecast:///conversation/jx7c89")).toBe("/conversation/jx7c89");
  });

  test("returns null when there's no navigable path", () => {
    expect(parseDesktopDeepLinkPath("codecast://open")).toBeNull();
    expect(parseDesktopDeepLinkPath("codecast://open/")).toBeNull();
  });

  test("returns null for an unparseable url", () => {
    expect(parseDesktopDeepLinkPath("not a url")).toBeNull();
  });
});

describe("isHandoffEligiblePath", () => {
  test("allows content routes", () => {
    expect(isHandoffEligiblePath("/conversation/jx7c89")).toBe(true);
    expect(isHandoffEligiblePath("/tasks/ct-1")).toBe(true);
    expect(isHandoffEligiblePath("/")).toBe(true);
  });

  test("blocks auth, share, palette, download and api routes", () => {
    expect(isHandoffEligiblePath("/login")).toBe(false);
    expect(isHandoffEligiblePath("/auth/callback")).toBe(false);
    expect(isHandoffEligiblePath("/oauth/github")).toBe(false);
    expect(isHandoffEligiblePath("/share/abc")).toBe(false);
    expect(isHandoffEligiblePath("/palette")).toBe(false);
    expect(isHandoffEligiblePath("/download/mac")).toBe(false);
    expect(isHandoffEligiblePath("/api/x")).toBe(false);
  });
});

describe("shouldAttemptHandoff", () => {
  test("fires for a fresh deep link when the user owns the app", () => {
    expect(shouldAttemptHandoff(PASSING)).toBe(true);
  });

  test("never fires inside the desktop app itself", () => {
    expect(shouldAttemptHandoff({ ...PASSING, isDesktop: true })).toBe(false);
  });

  test("waits for synced prefs to load", () => {
    expect(shouldAttemptHandoff({ ...PASSING, initialized: false })).toBe(false);
  });

  test("requires that the user has used the desktop app", () => {
    expect(shouldAttemptHandoff({ ...PASSING, hasUsedDesktop: false })).toBe(false);
  });

  test("respects a remembered 'stay in browser' choice", () => {
    expect(shouldAttemptHandoff({ ...PASSING, preferBrowser: true })).toBe(false);
  });

  test("ignores non-top-level (iframe) windows", () => {
    expect(shouldAttemptHandoff({ ...PASSING, isTopWindow: false })).toBe(false);
  });

  test("stays inert in background / unfocused tabs (the agent-tab jump fix)", () => {
    expect(shouldAttemptHandoff({ ...PASSING, foreground: false })).toBe(false);
  });

  test("fires only on the production host — never local dev (agent tabs live there) or foreign hosts", () => {
    expect(shouldAttemptHandoff({ ...PASSING, host: "codecast.sh" })).toBe(true);
    expect(shouldAttemptHandoff({ ...PASSING, host: "www.codecast.sh" })).toBe(true);
    expect(shouldAttemptHandoff({ ...PASSING, host: "local.codecast.sh" })).toBe(false);
    expect(shouldAttemptHandoff({ ...PASSING, host: "localhost:5173" })).toBe(false);
    expect(shouldAttemptHandoff({ ...PASSING, host: "127.0.0.1:5173" })).toBe(false);
    expect(shouldAttemptHandoff({ ...PASSING, host: "evil.example.com" })).toBe(false);
  });

  test("respects reload / back-forward (only fires on fresh navigation)", () => {
    expect(shouldAttemptHandoff({ ...PASSING, freshNavigation: false })).toBe(false);
  });

  test("skips auth/share/etc. paths", () => {
    expect(shouldAttemptHandoff({ ...PASSING, path: "/share/abc" })).toBe(false);
    expect(shouldAttemptHandoff({ ...PASSING, path: "/login" })).toBe(false);
  });

  test("skips oauth callbacks carrying code + state", () => {
    expect(shouldAttemptHandoff({ ...PASSING, path: "/", search: "?code=abc&state=xyz" })).toBe(false);
  });
});
