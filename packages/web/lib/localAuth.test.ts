import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { AUTH_JWT_STORAGE_KEY, CONVEX_URL } from "./localAuth";

// hasStoredAuthToken reads the JWT directly out of localStorage under the key
// @convex-dev/auth writes it to. That layout is the library's internal detail
// (`${JWT_STORAGE_KEY}_${namespace with non-alphanumerics stripped}`), so pin
// it against the installed package source: if an upgrade changes the constant
// or the escaping, this fails loudly instead of offline boot silently
// never authenticating.
describe("localAuth storage key contract", () => {
  test("matches @convex-dev/auth's storage key layout", () => {
    // The package's exports map only exposes the entry point — resolve it and
    // read its sibling client.js, where the storage constants live.
    const entry = require.resolve("@convex-dev/auth/react");
    const source = readFileSync(path.join(path.dirname(entry), "client.js"), "utf8");
    expect(source).toContain('const JWT_STORAGE_KEY = "__convexAuthJWT"');
    // useNamespacedStorage: namespace.replace(/[^a-zA-Z0-9]/g, "")
    expect(source).toContain('namespace.replace(/[^a-zA-Z0-9]/g, "")');

    const expected = `__convexAuthJWT_${CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "")}`;
    expect(AUTH_JWT_STORAGE_KEY).toBe(expected);
  });

  test("default deployment URL derivation", () => {
    // The namespace defaults to the ConvexReactClient address (providers.tsx
    // constructs it from the same CONVEX_URL constant).
    expect(AUTH_JWT_STORAGE_KEY.startsWith("__convexAuthJWT_")).toBe(true);
    expect(AUTH_JWT_STORAGE_KEY).not.toMatch(/[^a-zA-Z0-9_]/);
  });
});
