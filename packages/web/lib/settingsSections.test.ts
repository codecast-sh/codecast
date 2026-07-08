import { describe, it, expect } from "vitest";
import { settingsSectionForPath } from "./settingsSections";

describe("settingsSectionForPath", () => {
  it("maps every section URL to its modal section", () => {
    expect(settingsSectionForPath("/settings")).toEqual({ section: "general", search: "" });
    expect(settingsSectionForPath("/settings/profile")?.section).toBe("general");
    expect(settingsSectionForPath("/settings/accounts")?.section).toBe("accounts");
    expect(settingsSectionForPath("/settings/notifications")?.section).toBe("notifications");
    expect(settingsSectionForPath("/settings/team")?.section).toBe("team");
    expect(settingsSectionForPath("/settings/sync")?.section).toBe("sync");
    expect(settingsSectionForPath("/settings/integrations/github-app")?.section).toBe("integrations");
    expect(settingsSectionForPath("/settings/agents")?.section).toBe("agents");
    expect(settingsSectionForPath("/settings/claude-accounts")?.section).toBe("claude-accounts");
    expect(settingsSectionForPath("/settings/cli")?.section).toBe("cli");
    expect(settingsSectionForPath("/settings/devices")?.section).toBe("devices");
    expect(settingsSectionForPath("/settings/desktop")?.section).toBe("desktop");
  });

  it("carries the query string (OAuth returns, team-setup handoff)", () => {
    expect(settingsSectionForPath("/settings/sync?teamSetup=1&teamId=abc")).toEqual({
      section: "sync",
      search: "teamSetup=1&teamId=abc",
    });
    expect(settingsSectionForPath("/settings/accounts?error=denied")).toEqual({
      section: "accounts",
      search: "error=denied",
    });
  });

  it("ignores trailing slashes and hashes", () => {
    expect(settingsSectionForPath("/settings/")?.section).toBe("general");
    expect(settingsSectionForPath("/settings/team/#x")?.section).toBe("team");
  });

  it("leaves flow pages as real routes", () => {
    expect(settingsSectionForPath("/settings/team/create")).toBeNull();
    expect(settingsSectionForPath("/settings/team/join")).toBeNull();
    expect(settingsSectionForPath("/settings/accounts/link-github")).toBeNull();
  });

  it("returns null for non-settings paths", () => {
    expect(settingsSectionForPath("/inbox")).toBeNull();
    expect(settingsSectionForPath("/")).toBeNull();
    expect(settingsSectionForPath("/settingsfoo")).toBeNull();
  });
});
