import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { authStorageNamespace, createLocalAuth } from "./localAuth";

const CONVEX_URL = "https://happy-animal-123.convex.cloud";

// hasStoredAuthToken reads the JWT directly out of localStorage under the key
// @convex-dev/auth writes it to. That layout is the library's internal detail
// (`${JWT_STORAGE_KEY}_${namespace with non-alphanumerics stripped}`), so pin
// it against the installed package source: if an upgrade changes the constant
// or the escaping, this fails loudly instead of offline boot silently
// never authenticating.
describe("localAuth storage key contract", () => {
  test("matches @convex-dev/auth's storage key layout", () => {
    // The package's exports map only exposes the entry point; resolve it and
    // read its sibling client.js, where the storage constants live.
    const entry = require.resolve("@convex-dev/auth/react");
    const source = readFileSync(path.join(path.dirname(entry), "client.js"), "utf8");
    expect(source).toContain('const JWT_STORAGE_KEY = "__convexAuthJWT"');
    expect(source).toContain('const REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken"');
    // useNamespacedStorage: namespace.replace(/[^a-zA-Z0-9]/g, "")
    expect(source).toContain('namespace.replace(/[^a-zA-Z0-9]/g, "")');

    const local = createLocalAuth(CONVEX_URL);
    const expected = `__convexAuthJWT_${CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "")}`;
    expect(local.jwtKey).toBe(expected);
    expect(local.refreshTokenKey).toBe(`__convexAuthRefreshToken_${authStorageNamespace(CONVEX_URL)}`);
  });

  test("default deployment URL derivation", () => {
    // The namespace defaults to the ConvexReactClient address (the app's
    // providers construct it from the same URL constant).
    const local = createLocalAuth(CONVEX_URL);
    expect(local.jwtKey.startsWith("__convexAuthJWT_")).toBe(true);
    expect(local.jwtKey).not.toMatch(/[^a-zA-Z0-9_]/);
    expect(local.keys).toEqual([local.jwtKey, local.refreshTokenKey, local.oauthVerifierKey, local.serverStateKey]);
  });

  test("hasStoredAuthToken is false when localStorage is unavailable", () => {
    expect(createLocalAuth(CONVEX_URL).hasStoredAuthToken()).toBe(false);
  });
});
