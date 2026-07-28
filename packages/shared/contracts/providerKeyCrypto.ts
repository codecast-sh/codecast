// The wire contract for sending a provider API key from the web to the user's
// daemon WITHOUT Convex ever seeing plaintext (pl-207, Phase 3).
//
// The daemon holds an ECDH P-256 keypair and publishes only its PUBLIC key (not a
// secret) via the heartbeat. The web generates an ephemeral P-256 keypair, does
// ECDH against the daemon's public key, derives an AES-256-GCM key with HKDF-SHA256,
// and encrypts the API key. It sends { epk, iv, ct } (the ephemeral public key, the
// GCM nonce, and ciphertext-with-tag) in a routed daemon_command. The daemon does
// the same ECDH with its private key, derives the same AES key, and decrypts. Convex
// stores only the public key and the ciphertext command, whose payload is SCRUBBED
// (args cleared) the instant the daemon acks it or the command's 5-min TTL expires
// — never the plaintext key and never the AES key.
//
// Both sides MUST agree on these parameters exactly; the web uses the browser's
// SubtleCrypto and the daemon uses node:crypto, and they interoperate only if the
// curve, KDF, salt, info, and cipher match. This module is the single source of
// truth for them, imported by both.

/** NIST P-256 / prime256v1 — the one curve SubtleCrypto and node both speak with
 *  raw-uncompressed public keys and a 32-byte ECDH shared secret. */
export const PROVIDER_KEY_ECDH_CURVE = "P-256" as const;
export const PROVIDER_KEY_ECDH_NAMED_CURVE = "prime256v1" as const; // node's name for P-256

/** HKDF-SHA256 with an empty salt and this info string derives the AES key from the
 *  ECDH shared secret. The info string domain-separates this use of the shared key. */
export const PROVIDER_KEY_HKDF_HASH = "SHA-256" as const;
export const PROVIDER_KEY_HKDF_INFO = "codecast-provider-key-v1";

/** AES-256-GCM with a 12-byte nonce; the 16-byte auth tag is APPENDED to the
 *  ciphertext (SubtleCrypto's convention), so the daemon splits it off before
 *  verifying. */
export const PROVIDER_KEY_AES_ALGO = "AES-GCM" as const;
export const PROVIDER_KEY_AES_KEY_BITS = 256;
export const PROVIDER_KEY_GCM_IV_BYTES = 12;
export const PROVIDER_KEY_GCM_TAG_BYTES = 16;

/** The encrypted payload carried in the daemon_command args (all base64). */
export interface EncryptedProviderKeyPayload {
  /** Provider id (see PROVIDER_KEYS) the key is for. */
  provider: string;
  /** The web's ephemeral ECDH public key, raw/uncompressed (65 bytes), base64. */
  epk: string;
  /** AES-GCM nonce (12 bytes), base64. */
  iv: string;
  /** Ciphertext with the GCM tag appended, base64. */
  ct: string;
}

/** Command kinds the web enqueues; the daemon dispatches on these. */
export type ProviderKeyCommand =
  | { op: "set"; payload: EncryptedProviderKeyPayload }
  | { op: "remove"; provider: string };
