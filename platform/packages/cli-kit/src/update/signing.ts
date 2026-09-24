// Detached Ed25519 signatures over the exact bytes of a release manifest.
//
// The publisher signs latest.json with a private key that never leaves the
// release pipeline and uploads the signature beside it as latest.json.sig.
// The client pins the public keys it trusts, by key id, in its own binary,
// so the trust anchor is the client the human already has rather than the
// host the manifest came from. Rotation is a second signature: the pipeline
// signs with both keys while clients that pin only the old one are still in
// the field, and a client that knows either key accepts the manifest.
//
// Rollout is governed by the policy's `required` flag. With `required: false`
// a manifest with no signature is accepted, which is how every client works
// today, while a signature by a pinned key that does not verify is refused
// because it is evidence of tampering. `required: true` refuses an unsigned
// manifest and is safe only once no client in the field predates the pinned
// key. A policy with no keys skips signature handling entirely and adds no
// request.

import { createPublicKey, createPrivateKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";

export interface ManifestSigningPolicy {
  /** Key id to Ed25519 public key: base64 of the 32 raw bytes. */
  keys: Record<string, string>;
  /** Refuse a manifest that no pinned key vouches for. */
  required: boolean;
}

/** The body of latest.json.sig. Several signatures so a key can rotate. */
export interface ManifestSignatureFile {
  signatures: Array<{ keyId: string; alg: "ed25519"; sig: string }>;
}

export type SignatureFailure = "missing" | "unavailable" | "malformed" | "unknown_key" | "invalid";

export type SignatureVerdict =
  | { ok: true; verified: true; keyId: string }
  | { ok: true; verified: false }
  | { ok: false; reason: SignatureFailure };

/** A verdict that let the manifest through: verified by a pinned key, or unsigned under a policy that allows it. */
export type SignatureAccepted = Extract<SignatureVerdict, { ok: true }>;

const MAX_SIGNATURE_FILE_BYTES = 16 * 1024;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** DER prefix of an Ed25519 SubjectPublicKeyInfo, ahead of the 32 key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function publicKeyFromBase64(raw: string): KeyObject {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
}

export function isManifestSignatureFile(value: unknown): value is ManifestSignatureFile {
  if (!value || typeof value !== "object") return false;
  const sigs = (value as Record<string, unknown>).signatures;
  if (!Array.isArray(sigs) || sigs.length === 0 || sigs.length > 8) return false;
  return sigs.every((s) => {
    if (!s || typeof s !== "object") return false;
    const e = s as Record<string, unknown>;
    return typeof e.keyId === "string" && KEY_ID.test(e.keyId) && e.alg === "ed25519" && typeof e.sig === "string" && e.sig.length <= 128;
  });
}

/** Verify signature bytes against one pinned key. Pure; used by the updater and the release tooling's self check. */
export function verifyDetached(manifestBytes: Uint8Array, sigBase64: string, publicKeyBase64: string): boolean {
  try {
    const sig = Buffer.from(sigBase64, "base64");
    if (sig.length !== 64) return false;
    return nodeVerify(null, manifestBytes, publicKeyFromBase64(publicKeyBase64), sig);
  } catch {
    return false;
  }
}

/**
 * Fetch latest.json.sig and judge the manifest bytes against the policy.
 * Never throws: every outcome is a verdict the updater turns into an error
 * string or accepts.
 */
export async function verifyManifestSignature(input: {
  manifestBytes: Uint8Array;
  signatureUrl: string;
  policy: ManifestSigningPolicy | undefined;
  fetch: typeof fetch;
}): Promise<SignatureVerdict> {
  const policy = input.policy;
  const keyIds = policy ? Object.keys(policy.keys) : [];
  if (!policy || keyIds.length === 0) return { ok: true, verified: false };
  const unsigned = (reason: SignatureFailure): SignatureVerdict =>
    policy.required ? { ok: false, reason } : { ok: true, verified: false };

  let bytes: Uint8Array;
  try {
    const res = await input.fetch(input.signatureUrl);
    if (res.status === 404) return unsigned("missing");
    if (!res.ok) return unsigned("unavailable");
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return unsigned("unavailable");
  }
  // A signature file that exists but cannot be read is tampering or a broken
  // publish; neither is "unsigned", so it is refused under either policy.
  if (bytes.byteLength > MAX_SIGNATURE_FILE_BYTES) return { ok: false, reason: "malformed" };
  let file: unknown;
  try {
    file = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isManifestSignatureFile(file)) return { ok: false, reason: "malformed" };

  let sawPinned = false;
  for (const entry of file.signatures) {
    const key = policy.keys[entry.keyId];
    if (!key) continue;
    sawPinned = true;
    if (verifyDetached(input.manifestBytes, entry.sig, key)) return { ok: true, verified: true, keyId: entry.keyId };
  }
  // A pinned key signed it and the signature does not match the bytes: the
  // manifest changed after signing. Refused regardless of policy.
  if (sawPinned) return { ok: false, reason: "invalid" };
  // Signed only by keys this client does not know: a rotation this client
  // has not caught up with, or a stranger. Only the strict policy refuses.
  return unsigned("unknown_key");
}

// ── publisher side ──────────────────────────────────────────────────────────
// Used by release tooling and tests. A client never holds a private key.

/** Sign manifest bytes with an Ed25519 private key (PEM, PKCS#8). */
export function signManifest(manifestBytes: Uint8Array, privateKeyPem: string, keyId: string): ManifestSignatureFile["signatures"][number] {
  if (!KEY_ID.test(keyId)) throw new Error("bad key id");
  const sig = nodeSign(null, manifestBytes, createPrivateKey(privateKeyPem));
  return { keyId, alg: "ed25519", sig: sig.toString("base64") };
}

/** The base64 raw form of a public key, as a client pins it. */
export function publicKeyToBase64(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32).toString("base64");
}
