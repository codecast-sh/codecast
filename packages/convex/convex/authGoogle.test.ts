// Google sign-in is env gated: prod has no Google OAuth client today, and a
// provider registered without one would offer a button whose redirect fails.
// The config must register Google only when both AUTH_GOOGLE_ID and
// AUTH_GOOGLE_SECRET are set, and signInProviders must tell the web the same.
import { afterEach, describe, expect, test } from "bun:test";
import { codecastAuthConfig, googleSignInConfigured, signInProviders } from "./auth";

const saved = { id: process.env.AUTH_GOOGLE_ID, secret: process.env.AUTH_GOOGLE_SECRET };
afterEach(() => {
  for (const [key, value] of [["AUTH_GOOGLE_ID", saved.id], ["AUTH_GOOGLE_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setGoogleEnv(id: string | undefined, secret: string | undefined) {
  if (id === undefined) delete process.env.AUTH_GOOGLE_ID;
  else process.env.AUTH_GOOGLE_ID = id;
  if (secret === undefined) delete process.env.AUTH_GOOGLE_SECRET;
  else process.env.AUTH_GOOGLE_SECRET = secret;
}

// convexAuth materializes a provider by merging its `options` over it; read
// the id the same way.
const providerIds = () =>
  (codecastAuthConfig().providers as any[]).map((p) => p.options?.id ?? p.id);

describe("Google sign-in gate", () => {
  test("without the env, Google is not registered and the web is told so", async () => {
    setGoogleEnv(undefined, undefined);
    expect(googleSignInConfigured()).toBe(false);
    expect(providerIds()).not.toContain("google");
    expect(providerIds()).toEqual(["github", "apple", "apple-native", "desktop-relay", "password"]);
    expect(await (signInProviders as any)._handler({}, {})).toEqual({ google: false });
  });

  test("half the env is no env: an id without a secret registers nothing", () => {
    setGoogleEnv("client.apps.googleusercontent.com", undefined);
    expect(googleSignInConfigured()).toBe(false);
    expect(providerIds()).not.toContain("google");
    setGoogleEnv(undefined, "secret");
    expect(providerIds()).not.toContain("google");
  });

  test("with both set, Google is registered (basic profile scope) and offered", async () => {
    setGoogleEnv("client.apps.googleusercontent.com", "secret");
    expect(googleSignInConfigured()).toBe(true);
    const ids = providerIds();
    expect(ids[0]).toBe("google");
    expect(ids.slice(1)).toEqual(["github", "apple", "apple-native", "desktop-relay", "password"]);
    const google = (codecastAuthConfig().providers as any[])[0];
    // Sign-in never asks for mail or calendar; those are the connector's grants.
    const scope = google.options?.authorization?.params?.scope ?? google.authorization?.params?.scope ?? "";
    expect(scope).not.toContain("gmail");
    expect(scope).not.toContain("calendar");
    expect(await (signInProviders as any)._handler({}, {})).toEqual({ google: true });
  });
});
