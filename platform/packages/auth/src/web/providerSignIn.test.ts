import { describe, expect, test } from "bun:test";
import { DEFAULT_OAUTH_PROVIDERS, OAUTH_PROVIDER_BUTTONS, oauthProviderButton } from "./providerSignIn";

describe("provider buttons", () => {
  test("Google is listed but off by default: a deployment offers it only once configured", () => {
    expect(OAUTH_PROVIDER_BUTTONS.map((b) => b.id)).toEqual(["google", "apple", "github"]);
    expect(DEFAULT_OAUTH_PROVIDERS).toEqual(["apple", "github"]);
  });

  test("oauthProviderButton resolves known ids and refuses anything else", () => {
    expect(oauthProviderButton("google")?.label).toBe("Google");
    expect(oauthProviderButton("github")?.label).toBe("GitHub");
    expect(oauthProviderButton("password")).toBeUndefined();
    expect(oauthProviderButton(null)).toBeUndefined();
  });

  test("Google's mark keeps its four brand colors, and its one color path draws the same shape", () => {
    const google = oauthProviderButton("google")!;
    expect(google.iconParts?.map((p) => p.fill)).toEqual(["#4285F4", "#34A853", "#FBBC05", "#EA4335"]);
    expect(google.iconPath).toBe(google.iconParts!.map((p) => p.d).join(""));
  });
});
