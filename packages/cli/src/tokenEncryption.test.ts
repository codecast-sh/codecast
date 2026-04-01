import { describe, it, expect } from "bun:test";
import { encryptToken, decryptToken, isEncryptedToken } from "./tokenEncryption.js";

describe("tokenEncryption", () => {
  const testToken = "cxt_abc123def456_test_token_value";

  it("encrypts and decrypts round-trip", () => {
    const encrypted = encryptToken(testToken);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(testToken);
  });

  it("produces different ciphertext each time (random salt+iv)", () => {
    const a = encryptToken(testToken);
    const b = encryptToken(testToken);
    expect(a).not.toBe(b);
  });

  it("encrypted token starts with enc: prefix", () => {
    const encrypted = encryptToken(testToken);
    expect(encrypted.startsWith("enc:")).toBe(true);
  });

  it("isEncryptedToken detects encrypted values", () => {
    const encrypted = encryptToken(testToken);
    expect(isEncryptedToken(encrypted)).toBe(true);
  });

  it("isEncryptedToken returns false for plaintext", () => {
    expect(isEncryptedToken(testToken)).toBe(false);
    expect(isEncryptedToken("")).toBe(false);
  });

  it("decryptToken passes through plaintext unchanged", () => {
    expect(decryptToken(testToken)).toBe(testToken);
  });

  it("handles empty string token", () => {
    expect(isEncryptedToken("")).toBe(false);
    expect(decryptToken("")).toBe("");
  });

  it("handles unicode in token", () => {
    const unicodeToken = "token_with_émojis_and_日本語";
    const encrypted = encryptToken(unicodeToken);
    expect(decryptToken(encrypted)).toBe(unicodeToken);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptToken(testToken);
    const tampered = encrypted.slice(0, -2) + "AA";
    expect(() => decryptToken(tampered)).toThrow();
  });
});
