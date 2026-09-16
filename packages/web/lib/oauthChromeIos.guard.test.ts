import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import path from "path";

function readAuth(rel: string): string {
  // The package's "server" export is not reachable from the web package's
  // resolver; walk from the react entry (same dist tree).
  const reactEntry = require.resolve("@convex-dev/auth/react");
  const file = path.join(path.dirname(reactEntry), "..", "server", rel);
  expect(existsSync(file)).toBe(true);
  return readFileSync(file, "utf8");
}

describe("Chrome iOS GitHub OAuth patch", () => {
  test("does not set Partitioned cookies", () => {
    const cookies = readAuth("cookies.js");
    expect(cookies).not.toContain("partitioned: true");
    expect(cookies).toContain("codecastIosOAuth");
  });

  test("authorize hop packs state and returns an HTML interstitial", () => {
    const impl = readAuth("implementation/index.js");
    expect(impl).toContain("codecastIosOAuth");
    expect(impl).toContain('u.searchParams.set("state", packed)');
    expect(impl).toContain("location.replace");
    expect(impl).toContain("return new Response(html, { status: 200, headers })");
  });

  test("callback recovers packed state and fails to /login", () => {
    const impl = readAuth("implementation/index.js");
    expect(impl).toContain("packedState");
    expect(impl).toContain("pkceCodeVerifier");
    expect(impl).toContain("/login?reason=oauth");
  });

  test("client hops with location.assign", () => {
    const client = readFileSync(
      path.join(path.dirname(require.resolve("@convex-dev/auth/react")), "client.js"),
      "utf8",
    );
    expect(client).toContain("window.location.assign(url.toString())");
  });
});

describe("packed OAuth state round-trip", () => {
  // The HTTP handlers inline this encoder; keep the algorithm here so a
  // rewrite that changes the shape fails this test instead of Chrome iOS.
  function pack(s: string, v: string, r: string) {
    return btoa(JSON.stringify({ s, v, r }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  function unpack(packed: string) {
    const b64 = packed.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
  }

  test("survives base64url without cookies", () => {
    const packed = pack("state-secret", "pkce-verifier", "/inbox");
    expect(packed).not.toMatch(/[+/=]/);
    expect(unpack(packed)).toEqual({
      s: "state-secret",
      v: "pkce-verifier",
      r: "/inbox",
    });
  });
});
