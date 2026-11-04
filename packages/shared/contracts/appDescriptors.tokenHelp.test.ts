import { describe, expect, test } from "bun:test";
import { APP_DESCRIPTORS, tokenCreateUrl } from "./appDescriptors";

describe("tokenCreateUrl: where the person makes the token", () => {
  test("fills the host the person typed, else its default, without a doubled slash", () => {
    const s = APP_DESCRIPTORS.sentry;
    expect(tokenCreateUrl(s.tokenHelp!.createUrl, s.tokenConfig!, {})).toBe("https://sentry.io/settings/account/api/auth-tokens/");
    expect(tokenCreateUrl(s.tokenHelp!.createUrl, s.tokenConfig!, { host: "https://sentry.acme.dev/ " })).toBe("https://sentry.acme.dev/settings/account/api/auth-tokens/");
    const p = APP_DESCRIPTORS.posthog;
    expect(tokenCreateUrl(p.tokenHelp!.createUrl, p.tokenConfig!, { host: "https://eu.posthog.com" })).toBe("https://eu.posthog.com/settings/user-api-keys");
  });
  test("every token-paste vendor that needs a token says where to make it and with which scopes", () => {
    for (const d of Object.values(APP_DESCRIPTORS)) {
      if (d.connectKind !== "token-paste" || d.tokenOptional) continue;
      expect(d.tokenHelp?.scopes.length).toBeGreaterThan(0);
    }
  });
});
