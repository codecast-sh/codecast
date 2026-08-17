/**
 * Carrying logins to a browser on another machine.
 *
 * Two things here are worth pinning. The domain walk decides which cookies a
 * site is allowed to receive, so getting it wrong either withholds a login or
 * hands one site's session to another. And the decryption has to fail closed:
 * a wrong key produces bytes, not an error, so anything that looks like a
 * successful decrypt but is not must be rejected rather than injected.
 */

import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { cookieHostKeys, decryptCookieValue, OWN_LOGIN_REASON, provisionCredentials, provisionLocalLogins } from "./credentials.js";

/** Encrypt like Chrome does on macOS, to test the reverse. */
function chromeEncrypt(plaintext: string, key: Buffer, withDomainHash = false): Buffer {
  const body = withDomainHash
    ? Buffer.concat([crypto.randomBytes(32), Buffer.from(plaintext, "utf-8")])
    : Buffer.from(plaintext, "utf-8");
  const padLen = 16 - (body.length % 16);
  const padded = Buffer.concat([body, Buffer.alloc(padLen, padLen)]);
  const c = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  c.setAutoPadding(false);
  return Buffer.concat([Buffer.from("v10"), c.update(padded), c.final()]);
}

const keyFrom = (secret: string) => crypto.pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");

describe("cookieHostKeys", () => {
  test("asks for the site's own cookies and its parent domain's", () => {
    // A cookie set on `.github.com` is sent to `github.com`, so both forms of
    // both names have to be requested or the session is missed.
    expect(cookieHostKeys("github.com").sort()).toEqual([".github.com", "github.com"]);
  });

  test("walks up through subdomains", () => {
    // gist.github.com must receive cookies set on `.github.com`.
    expect(cookieHostKeys("gist.github.com")).toContain(".github.com");
    expect(cookieHostKeys("gist.github.com")).toContain("gist.github.com");
  });

  test("stops before the public suffix", () => {
    // Asking for `.com` cookies would be asking for every site's session.
    expect(cookieHostKeys("a.b.example.com")).not.toContain(".com");
    expect(cookieHostKeys("a.b.example.com")).not.toContain("com");
  });

  test("never returns an unrelated site", () => {
    const keys = cookieHostKeys("evil-github.com");
    expect(keys).not.toContain("github.com");
    expect(keys).not.toContain(".github.com");
  });

  test("is case-insensitive and tolerates a leading dot", () => {
    expect(cookieHostKeys(".GitHub.com").sort()).toEqual(cookieHostKeys("github.com").sort());
  });

  test("leaves an IP address alone", () => {
    // Splitting 192.168.1.4 on dots would produce nonsense parent "domains".
    expect(cookieHostKeys("192.168.1.4")).toEqual(["192.168.1.4"]);
  });

  test("returns something usable for a single label", () => {
    expect(cookieHostKeys("localhost")).toEqual(["localhost"]);
  });
});

describe("decryptCookieValue", () => {
  const key = keyFrom("this-machines-secret");

  test("recovers the value", () => {
    const blob = chromeEncrypt("session-token-abc123", key);
    expect(decryptCookieValue(blob, key)).toBe("session-token-abc123");
  });

  test("strips the domain hash newer Chrome prepends", () => {
    // Without this the value carries 32 bytes of binary and the site rejects it.
    const blob = chromeEncrypt("session-token-abc123", key, true);
    expect(decryptCookieValue(blob, key)).toBe("session-token-abc123");
  });

  test("returns null for a key from a different machine", () => {
    // The whole reason a copied profile is signed out. AES gives back bytes
    // rather than an error, so this must be caught by inspecting them —
    // injecting the garbage would look like a login that silently fails.
    const blob = chromeEncrypt("session-token-abc123", key);
    expect(decryptCookieValue(blob, keyFrom("another-machines-secret"))).toBeNull();
  });

  test("ignores a blob that is not v10", () => {
    expect(decryptCookieValue(Buffer.from("plain text value"), key)).toBeNull();
  });

  test("survives a truncated blob rather than throwing", () => {
    const blob = chromeEncrypt("value", key).subarray(0, 8);
    expect(decryptCookieValue(blob, key)).toBeNull();
  });

  test("handles a value long enough to span several blocks", () => {
    const long = "j".repeat(500);
    expect(decryptCookieValue(chromeEncrypt(long, key), key)).toBe(long);
  });
});

describe("own-login hosts are never carried", () => {
  // Neither call may reach a browser or a cookie store for these hosts: the
  // refusal has to come before any I/O, or a Google session gets shared and
  // both browsers are signed out (profile.ts). A dead port and a fake page
  // would throw if either path got that far.
  test("the local carry refuses Google before touching anything", async () => {
    const r = await provisionLocalLogins(1, "https://ads.google.com/aw/overview", { profileDir: "Default" });
    expect(r).toEqual({ injected: 0, host: "ads.google.com", reason: OWN_LOGIN_REASON });
  });
  test("the remote carry refuses Google before touching anything", async () => {
    const page = { conn: { send: () => { throw new Error("must not be called"); } } } as any;
    const r = await provisionCredentials(page, "https://mail.google.com/mail/u/0/", "/nonexistent");
    expect(r).toEqual({ injected: 0, host: "mail.google.com", reason: OWN_LOGIN_REASON });
  });
});
