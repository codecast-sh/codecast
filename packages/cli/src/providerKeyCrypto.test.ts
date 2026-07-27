import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getProviderKeyPublicKey,
  decryptProviderKeyPayload,
  encryptProviderKeyForTest,
  applyProviderKeyCommand,
} from "./providerKeyCrypto";
import { readProviderKeyStore } from "./providerKeyStore";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pkc-test-"));
}

describe("provider-key web→daemon crypto", () => {
  it("publishes a raw-uncompressed P-256 public key (65 bytes), stable across calls, private key 0600", () => {
    const dir = tmpDir();
    try {
      const pub = getProviderKeyPublicKey(dir);
      expect(Buffer.from(pub, "base64").length).toBe(65); // 0x04 + 32 + 32
      expect(getProviderKeyPublicKey(dir)).toBe(pub); // persisted, stable
      expect((fs.statSync(path.join(dir, ".provider-key-ecdh")).mode & 0o777).toString(8)).toBe("600");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a key sealed to the device's public key (this IS the web→daemon path)", () => {
    const dir = tmpDir();
    try {
      const pub = getProviderKeyPublicKey(dir);
      const payload = encryptProviderKeyForTest(pub, "openrouter", "sk-or-v1-secret-xyz");
      expect(payload.provider).toBe("openrouter");
      expect(decryptProviderKeyPayload(dir, payload)).toBe("sk-or-v1-secret-xyz");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a tampered ciphertext (GCM auth tag), so a mutated command can't inject a key", () => {
    const dir = tmpDir();
    try {
      const pub = getProviderKeyPublicKey(dir);
      const payload = encryptProviderKeyForTest(pub, "openrouter", "sk-or-real");
      const tampered = { ...payload, ct: Buffer.from("garbage-ciphertext-bytes-here!!").toString("base64") };
      expect(() => decryptProviderKeyPayload(dir, tampered)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies a full web→daemon command: encrypt → command args → decrypt → store (set and remove)", () => {
    const dir = tmpDir();
    try {
      const pub = getProviderKeyPublicKey(dir);
      // The exact args the convex mutation builds for op:"set".
      const setArgs = JSON.stringify({ op: "set", payload: encryptProviderKeyForTest(pub, "openrouter", "sk-or-live-key") });
      const setRes = applyProviderKeyCommand(dir, setArgs);
      expect(setRes.ok).toBe(true);
      expect(readProviderKeyStore(dir)).toEqual({ openrouter: "sk-or-live-key" });
      // op:"remove" (no encryption).
      const rmRes = applyProviderKeyCommand(dir, JSON.stringify({ op: "remove", provider: "openrouter" }));
      expect(rmRes.ok).toBe(true);
      expect(readProviderKeyStore(dir)).toEqual({});
      // A payload sealed to a different device fails to apply, store untouched.
      const otherDir = tmpDir();
      const forOther = JSON.stringify({ op: "set", payload: encryptProviderKeyForTest(getProviderKeyPublicKey(otherDir), "openai", "sk-x") });
      expect(applyProviderKeyCommand(dir, forOther).ok).toBe(false);
      expect(readProviderKeyStore(dir)).toEqual({});
      fs.rmSync(otherDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the REAL web module (SubtleCrypto) round-trips against the daemon decrypt", async () => {
    // Import the actual web encrypt (not a node re-impl) so a one-sided change to
    // either crypto module breaks this test instead of silently breaking prod.
    const { encryptProviderKey } = await import("../../web/lib/providerKeyCrypto");
    const dir = tmpDir();
    try {
      const pub = getProviderKeyPublicKey(dir);
      const payload = await encryptProviderKey(pub, "openrouter", "sk-or-web-module-interop");
      expect(decryptProviderKeyPayload(dir, payload)).toBe("sk-or-web-module-interop");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a payload sealed to a DIFFERENT device does not decrypt here", () => {
    const a = tmpDir();
    const b = tmpDir();
    try {
      const pubB = getProviderKeyPublicKey(b);
      const forB = encryptProviderKeyForTest(pubB, "openai", "sk-for-b");
      // Device A (different private key) can't recover it.
      expect(() => decryptProviderKeyPayload(a, forB)).toThrow();
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});
