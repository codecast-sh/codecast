import { describe, expect, test } from "bun:test";
import { isNonTabRoute, healTabPaths } from "../tabRoutes";
import { shouldAttemptHandoff, shouldAttemptPreBootHandoff } from "../desktopHandoff";

const context = { isDesktop: false, initialized: true, hasUsedDesktop: true, preferBrowser: false, isTopWindow: true, foreground: true, host: "codecast.sh", freshNavigation: true, path: "/slack/connect", search: "", skippedUrl: null, agentDriven: false };

describe("Slack callback routing", () => {
  test.each(["/slack/connect", "/slack/connect/"])("keeps %s outside tabs and desktop handoff before and after boot", (path) => {
    for (const search of ["", "?code=c&state=s", "?state=s", "?error=access_denied&state=s"]) {
      expect(isNonTabRoute(path + search)).toBe(true);
      expect(shouldAttemptHandoff({ ...context, path, search })).toBe(false);
      expect(shouldAttemptPreBootHandoff({ ...context, path, search, mirror: "1", isDesktopShell: false })).toBe(false);
    }
  });

  test("removes callback URLs from old persisted tabs", () => {
    expect(healTabPaths([{ path: "/slack/connect?state=old" }])[0].path).toBe("/inbox");
  });
});
