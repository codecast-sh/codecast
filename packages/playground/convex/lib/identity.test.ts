import { describe, expect, test } from "bun:test";
import { SECRET_LENGTH, isSecretShaped, newSecret, randomToken, runtimeToken, runtimeTokenForSecret, sameToken, secretMatches, sha256Hex } from "./identity";

describe("secrets", () => {
  test("a new secret is the right shape and never repeats", () => {
    const a = newSecret();
    expect(a).toHaveLength(SECRET_LENGTH);
    expect(isSecretShaped(a)).toBe(true);
    expect(newSecret()).not.toBe(a);
  });

  test("the stored hash proves exactly its secret", async () => {
    const secret = newSecret();
    const hash = await sha256Hex(secret);
    expect(await secretMatches(hash, secret)).toBe(true);
    expect(await secretMatches(hash, newSecret())).toBe(false);
    expect(await secretMatches(hash, secret.slice(1))).toBe(false);
  });

  test("junk is refused before hashing, including the hash itself", async () => {
    const hash = await sha256Hex(newSecret());
    for (const junk of [undefined, null, 42, "", "x".repeat(SECRET_LENGTH - 1), `${"a".repeat(SECRET_LENGTH - 1)}!`, hash]) {
      expect(await secretMatches(hash, junk)).toBe(false);
    }
  });

  test("sha256Hex matches the standard vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("randomToken", () => {
  test("draws only from the alphabet, at the asked length", () => {
    const t = randomToken(500, "xyz");
    expect(t).toHaveLength(500);
    expect(t).toMatch(/^[xyz]+$/);
    expect(new Set(t).size).toBe(3);
  });
});

describe("runtime tokens", () => {
  test("the shell's token is the one the server derives from the stored hash", async () => {
    const secret = newSecret();
    expect(await runtimeTokenForSecret(secret, "app1")).toBe(await runtimeToken(await sha256Hex(secret), "app1"));
  });

  test("a token opens one app for one visitor", async () => {
    const secret = newSecret();
    const token = await runtimeTokenForSecret(secret, "app1");
    expect(token).not.toBe(await runtimeTokenForSecret(secret, "app2"));
    expect(token).not.toBe(await runtimeTokenForSecret(newSecret(), "app1"));
    expect(token).not.toContain(secret);
  });

  test("sameToken compares exactly", () => {
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abc", "abd")).toBe(false);
    expect(sameToken("abc", "ab")).toBe(false);
  });
});
