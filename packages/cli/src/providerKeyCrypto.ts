// Daemon side of the web→daemon provider-key transport (pl-207, Phase 3). Holds a
// persistent ECDH P-256 keypair, publishes the public half (for the heartbeat), and
// decrypts a payload the web sealed to it. node:crypto here must match SubtleCrypto
// on the web — the shared parameters live in @codecast/shared/contracts
// (providerKeyCrypto). See that file for the wire contract.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  PROVIDER_KEY_ECDH_NAMED_CURVE,
  PROVIDER_KEY_HKDF_INFO,
  PROVIDER_KEY_GCM_TAG_BYTES,
  type EncryptedProviderKeyPayload,
} from "@codecast/shared/contracts";
import { readProviderKeyStore, writeProviderKeyStore } from "./providerKeyStore.js";

const PRIV_FILE = ".provider-key-ecdh"; // base64 raw private scalar, 0600

/** Load the device's ECDH object (private key restored), creating and persisting a
 *  fresh keypair on first use. The private key never leaves the 0600 file; only the
 *  public key is ever published. */
function loadOrCreateEcdh(configDir: string): crypto.ECDH {
  const file = path.join(configDir, PRIV_FILE);
  const ecdh = crypto.createECDH(PROVIDER_KEY_ECDH_NAMED_CURVE);
  try {
    const priv = fs.readFileSync(file, "utf-8").trim();
    ecdh.setPrivateKey(Buffer.from(priv, "base64"));
    // Deriving the public key from the private is implicit once set.
    ecdh.getPublicKey();
    return ecdh;
  } catch {
    ecdh.generateKeys();
    try {
      fs.mkdirSync(configDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, ecdh.getPrivateKey().toString("base64") + "\n", { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch {
      // If we can't persist, the in-memory keypair still works for this run; the
      // published pubkey just changes on restart (the web re-reads it each time).
    }
    return ecdh;
  }
}

/** The device's ECDH public key (raw/uncompressed, 65 bytes) as base64 — safe to
 *  publish. The web encrypts to this. Stable across restarts once persisted. */
export function getProviderKeyPublicKey(configDir: string): string {
  return loadOrCreateEcdh(configDir).getPublicKey().toString("base64");
}

function deriveAesKey(sharedSecret: Buffer): Buffer {
  // HKDF-SHA256, empty salt, domain-separating info → 32-byte AES key.
  const out = crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), Buffer.from(PROVIDER_KEY_HKDF_INFO), 32);
  return Buffer.from(out);
}

/** Decrypt a payload the web sealed to this device's public key. Returns the
 *  plaintext API key, or throws if the payload is malformed or the tag fails
 *  (wrong key / tampering). */
export function decryptProviderKeyPayload(configDir: string, payload: EncryptedProviderKeyPayload): string {
  const ecdh = loadOrCreateEcdh(configDir);
  const shared = ecdh.computeSecret(Buffer.from(payload.epk, "base64"));
  const aesKey = deriveAesKey(shared);
  const iv = Buffer.from(payload.iv, "base64");
  const ctWithTag = Buffer.from(payload.ct, "base64");
  const tag = ctWithTag.subarray(ctWithTag.length - PROVIDER_KEY_GCM_TAG_BYTES);
  const ciphertext = ctWithTag.subarray(0, ctWithTag.length - PROVIDER_KEY_GCM_TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv, { authTagLength: PROVIDER_KEY_GCM_TAG_BYTES });
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf-8");
}

/** Encrypt a key to a device public key — the exact operations SubtleCrypto performs
 *  on the web, in node. Not used in production (the web encrypts); it exists so the
 *  round-trip is unit-tested against the real decrypt path with the real parameters. */
export function encryptProviderKeyForTest(devicePublicKeyB64: string, provider: string, apiKey: string): EncryptedProviderKeyPayload {
  const eph = crypto.createECDH(PROVIDER_KEY_ECDH_NAMED_CURVE);
  eph.generateKeys();
  const shared = eph.computeSecret(Buffer.from(devicePublicKeyB64, "base64"));
  const aesKey = deriveAesKey(shared);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(apiKey, "utf-8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    provider,
    epk: eph.getPublicKey().toString("base64"),
    iv: iv.toString("base64"),
    ct: Buffer.concat([ciphertext, tag]).toString("base64"),
  };
}

/** Apply a `set_provider_key` command's args (the JSON the web enqueued) to this
 *  device's key store: for "set" decrypt the sealed payload and store it; for
 *  "remove" drop the provider. The daemon calls this, then fans out to remotes and
 *  heartbeats. Extracted (and pure w.r.t. the store dir) so the full web→daemon path
 *  — encrypt, command args, decrypt, store — is unit-tested end to end. */
export function applyProviderKeyCommand(
  configDir: string,
  argsJson: string | undefined,
): { ok: true; op: "set" | "remove"; provider: string } | { ok: false; error: string } {
  let parsed: any;
  try { parsed = argsJson ? JSON.parse(argsJson) : {}; } catch { return { ok: false, error: "bad JSON args" }; }
  const store = readProviderKeyStore(configDir);
  if (parsed.op === "remove") {
    if (typeof parsed.provider !== "string" || !parsed.provider) return { ok: false, error: "remove without a provider" };
    delete store[parsed.provider];
    writeProviderKeyStore(configDir, store);
    return { ok: true, op: "remove", provider: parsed.provider };
  }
  if (parsed.op === "set" && parsed.payload) {
    let apiKey: string;
    try { apiKey = decryptProviderKeyPayload(configDir, parsed.payload); }
    catch (err) { return { ok: false, error: `decrypt failed: ${err instanceof Error ? err.message : String(err)}` }; }
    const provider = String(parsed.payload.provider ?? "");
    if (!provider || !apiKey) return { ok: false, error: "empty provider or key after decrypt" };
    store[provider] = apiKey;
    writeProviderKeyStore(configDir, store);
    return { ok: true, op: "set", provider };
  }
  return { ok: false, error: `bad args: ${JSON.stringify(parsed).slice(0, 80)}` };
}
