// HMAC-SHA256 and the constant-time compare that verifying one needs, over
// @platform/crypto (the one implementation Stripe, Slack, Google, Linear,
// Sentry and AWS request signing share). These wrappers keep the ArrayBuffer
// key shape AWS signing chains through, the hex-string compare webhook checks
// call, and the signed OAuth `state` both connectors carry through consent.
import { encodeHex, timingSafeEqual } from "@platform/crypto/hex";
import { hmac_sha256, hmacSha256Hex } from "@platform/crypto/hmac_sha256";
import { encodeUTF8 } from "@platform/crypto/text";

export { hmacSha256Hex };

export const hex = (bytes: ArrayBuffer) => encodeHex(new Uint8Array(bytes));

export async function hmacSha256(key: ArrayBuffer, value: string): Promise<ArrayBuffer> {
  return (await hmac_sha256(new Uint8Array(key), encodeUTF8(value))).buffer as ArrayBuffer;
}

/** Constant-time hex-string compare, so a signature check can't be timing-probed. */
export const timingSafeEqualHex = timingSafeEqual;

/**
 * Whether `signature` is the lowercase hex HMAC-SHA256 of the raw `body`
 * under `secret`, the scheme Linear and Sentry webhooks use. Fails closed: no
 * secret or no signature is never a match. A sender's uppercase hex is
 * folded, since the digest is the same either way.
 */
export async function verifyHmacHex(body: string, signature: string | null | undefined, secret: string | null | undefined): Promise<boolean> {
  if (!secret || !signature) return false;
  return timingSafeEqual(signature.trim().toLowerCase(), await hmacSha256Hex(secret, body));
}

// ── OAuth state ─────────────────────────────────────────────────────────────
// An install or connect `state` names who the grant binds to, so it must be
// tamper-proof: `<base64 json>.<hex hmac>` under the app's client secret, with
// a `ts` checked on the callback so a leaked state expires.

/** The default life of a signed state: long enough for a consent screen. */
export const STATE_MAX_AGE_MS = 5 * 60_000;

export async function signStateWith(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = btoa(JSON.stringify(payload));
  return `${body}.${await hmacSha256Hex(secret, body)}`;
}

/** The payload of a state `signStateWith` made under `secret`, or null when
 *  the signature does not match, the payload is not JSON, or its `ts` is
 *  missing or older than `maxAgeMs`. An empty secret verifies nothing, since
 *  anyone could sign under it. */
export async function verifyStateWith(secret: string, state: string, maxAgeMs = STATE_MAX_AGE_MS): Promise<Record<string, any> | null> {
  if (!secret) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  if (!timingSafeEqual(state.slice(dot + 1), await hmacSha256Hex(secret, body))) return null;
  try {
    const payload = JSON.parse(atob(body));
    // A state with no numeric ts would never expire, defeating the replay window.
    if (typeof payload.ts !== "number" || Date.now() - payload.ts > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}
