// A read capability for one vault, used in place of the daemon's loopback
// bearer in attachment URLs.
//
// An <img> or <video> tag can set no headers, so an attachment URL has to carry
// its own proof. It used to carry the full loopback bearer — the same secret
// that spawns shells on /term/ws and writes files through /vault/op. That is
// only a read as long as nothing can read the URL, and something can: an SVG
// opened as a document runs at the daemon's own origin and can read its own
// location. The bytes in a vault are repository content, so that turned an
// attacker's committed file into local command authority.
//
// This capability is what that URL carries now: one vault, reads only, and it
// expires. It authorizes nothing else, and it is checked only on GET
// /vault/file — every other route still wants the full envelope (an allowed
// origin plus the bearer header).
//
// Derived rather than stored: HMAC over the vault id and the expiry, keyed by
// the daemon's loopback token. Nothing to persist, nothing to sweep, and
// rotating the daemon token (`cast daemon rotate-token`) invalidates every
// outstanding capability at once.

import * as crypto from "node:crypto";

/** How long a minted capability lives. Long enough that an open tab does not
 *  lose its images mid-session (the client re-mints on every vault scan), short
 *  enough that a URL left in a history or a referrer stops working. */
export const VAULT_CAP_TTL_MS = 12 * 60 * 60 * 1000;

const VERSION = "v1";
/** 128 bits of tag is far past what a loopback guesser could reach, and it
 *  keeps the URL short enough to read in a log line. */
const MAC_CHARS = 32;

function mac(secret: string, vaultId: string, expiresAt: number): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`vault-read\n${vaultId}\n${expiresAt}`)
    .digest("hex")
    .slice(0, MAC_CHARS);
}

export interface VaultCapability {
  value: string;
  expires_at: number;
}

/** Mint a read capability for one vault. Callers must already have passed the
 *  full request envelope: this hands out authority, it does not check any. */
export function mintVaultCapability(
  secret: string,
  vaultId: string,
  opts: { now?: number; ttlMs?: number } = {},
): VaultCapability {
  const now = opts.now ?? Date.now();
  const expiresAt = now + (opts.ttlMs ?? VAULT_CAP_TTL_MS);
  return { value: `${VERSION}.${expiresAt}.${mac(secret, vaultId, expiresAt)}`, expires_at: expiresAt };
}

/**
 * Does `presented` authorize reading `vaultId` right now? False for anything
 * malformed, expired, minted for another vault, or signed with another secret.
 * An empty daemon secret authorizes nobody — the token loads from disk early in
 * boot, so "not loaded yet" is a state a caller can reach.
 */
export function vaultCapabilityAllows(presented: unknown, secret: string, vaultId: string, now = Date.now()): boolean {
  if (typeof presented !== "string" || !presented || !secret || !vaultId) return false;
  const parts = presented.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const expected = Buffer.from(mac(secret, vaultId, expiresAt));
  const got = Buffer.from(parts[2]!);
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(expected, got);
}

/** A URL with its secrets blanked, for a log line. Both the capability and the
 *  legacy bearer ride in the query string, and the vault routes log the URL of
 *  a request that failed. */
export function redactVaultUrl(url: string): string {
  return url.replace(/([?&](?:token|cap)=)[^&]*/g, "$1<redacted>");
}
