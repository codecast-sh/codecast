import { describe, expect, test } from "bun:test";
import { RUNTIME_TOKEN_TTL_MS, SECRET_LENGTH, isSecretShaped, newSecret, randomToken, runtimeToken, runtimeTokenForSecret, runtimeTokenScope, sameToken, secretMatches, sha256Hex } from "./identity";

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
  const NOW = Date.UTC(2026, 9, 7, 12);

  test("the shell's token is the one the server derives from the stored hash, and holds while fresh", async () => {
    const secret = newSecret();
    const hash = await sha256Hex(secret);
    const token = await runtimeTokenForSecret(secret, "app1", 3, NOW);
    expect(token).toBe(await runtimeToken(hash, "app1", 3, NOW + RUNTIME_TOKEN_TTL_MS));
    expect(await runtimeTokenScope(hash, "app1", token, NOW + 1_000)).toBe("use");
  });

  test("a token opens one app for one visitor", async () => {
    const secret = newSecret();
    const hash = await sha256Hex(secret);
    const token = await runtimeTokenForSecret(secret, "app1", 3, NOW);
    expect(await runtimeTokenScope(hash, "app2", token, NOW)).toBeNull();
    expect(await runtimeTokenScope(await sha256Hex(newSecret()), "app1", token, NOW)).toBeNull();
    expect(token).not.toContain(secret);
  });

  test("a token dies at its expiry and cannot be stretched or forged", async () => {
    const secret = newSecret();
    const hash = await sha256Hex(secret);
    const token = await runtimeTokenForSecret(secret, "app1", 3, NOW);
    expect(await runtimeTokenScope(hash, "app1", token, NOW + RUNTIME_TOKEN_TTL_MS)).toBeNull();
    const [version, expires, mac] = token.split(".");
    expect(await runtimeTokenScope(hash, "app1", `${version}.${Number(expires) + 60_000}.${mac}`, NOW)).toBeNull();
    expect(await runtimeTokenScope(hash, "app1", `4.${expires}.${mac}`, NOW)).toBeNull();
    // One minted with a far expiry is refused even with a valid mac.
    const far = await runtimeToken(hash, "app1", 3, NOW + 10 * RUNTIME_TOKEN_TTL_MS);
    expect(await runtimeTokenScope(hash, "app1", far, NOW)).toBeNull();
    for (const junk of ["", "abc", hash, `${version}.${expires}`]) expect(await runtimeTokenScope(hash, "app1", junk, NOW)).toBeNull();
  });

  test("a watch token only watches, and cannot be turned into one that writes", async () => {
    const secret = newSecret();
    const hash = await sha256Hex(secret);
    const watch = await runtimeTokenForSecret(secret, "app1", 3, NOW, "watch");
    expect(await runtimeTokenScope(hash, "app1", watch, NOW)).toBe("watch");
    expect(await runtimeTokenScope(hash, "app1", watch.slice(1), NOW)).toBeNull();
    const use = await runtimeTokenForSecret(secret, "app1", 3, NOW);
    expect(await runtimeTokenScope(hash, "app1", `w${use}`, NOW)).toBeNull();
  });

  test("sameToken compares exactly", () => {
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abc", "abd")).toBe(false);
    expect(sameToken("abc", "ab")).toBe(false);
  });
});
