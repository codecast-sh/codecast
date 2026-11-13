import { describe, expect, test } from "bun:test";
import { BLOCKED_BANNER_KINDS, classifyApiErrorBanner } from "./apiErrorBanner";

// What the headless SDK writes when a turn ends on authentication_failed, as
// the Union line hosts' daemon logs recorded it on 2026-11-13.
describe("the SDK's authentication failures", () => {
  test.each([
    "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
    "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.",
  ])("park the session on auth: %s", (banner) => {
    expect(classifyApiErrorBanner(banner)).toBe("auth");
    expect(BLOCKED_BANNER_KINDS.has("auth")).toBe(true);
  });

  test("a safety stop behind the lead stays a safety stop", () => {
    expect(classifyApiErrorBanner('Failed to authenticate. API Error: 403 {"error":{"code":"misalignment_policy_violation"}}')).toBe("safety");
  });

  test("a reply that only says it failed to authenticate is no banner", () => {
    expect(classifyApiErrorBanner("Failed to authenticate with GitHub, so the branch is not pushed yet.")).toBeNull();
    expect(classifyApiErrorBanner("Failed to authenticate: the deploy key is missing on this host.")).toBeNull();
  });
});
