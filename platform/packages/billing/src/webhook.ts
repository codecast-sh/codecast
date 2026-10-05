// Stripe webhook signatures (the Stripe-Signature header) with Web Crypto.
// The header is `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`: each v1 is the
// HMAC-SHA256 of `<t>.<raw body>` under the endpoint's signing secret, one per
// secret while a rotation overlaps. A match proves Stripe sent these bytes; the
// timestamp bounds how long a captured delivery can be replayed.
import { timingSafeEqual } from "@platform/crypto/hex";
import { hmacSha256Hex } from "@platform/crypto/hmac_sha256";
import type { StripeEvent } from "./events";

/** Stripe's own libraries accept a delivery for five minutes. */
export const DEFAULT_TOLERANCE_SEC = 300;

export type WebhookFailure =
  /** No signing secret configured: nothing can be verified. */
  | "no_secret"
  | "no_header"
  /** The header has no timestamp or no v1 signature. */
  | "bad_header"
  /** No v1 signature matches: a tampered body or a wrong secret. */
  | "bad_signature"
  /** Signed, but outside the tolerance: a replay or a badly skewed clock. */
  | "stale"
  /** Signed and fresh, but not a JSON event. */
  | "bad_payload";

export type WebhookResult = { ok: true; event: StripeEvent } | { ok: false; reason: WebhookFailure };

export interface VerifyOptions {
  toleranceSec?: number;
  /** The clock, in milliseconds; Date.now() when absent. */
  now?: number;
}

/** The timestamp and v1 signatures of a Stripe-Signature header. */
export function parseSignatureHeader(header: string): { timestamp: number | null; signatures: string[] } {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value.toLowerCase());
  }
  return { timestamp, signatures };
}

/** Checks a delivery against its Stripe-Signature header and returns the
 *  parsed event. `payload` must be the raw body exactly as received: parsing
 *  and re-serializing it changes the bytes the signature covers. Fails closed
 *  and never throws. */
export async function verifyWebhook(
  payload: string,
  header: string | null | undefined,
  secret: string | null | undefined,
  options: VerifyOptions = {},
): Promise<WebhookResult> {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "no_header" };
  const { timestamp, signatures } = parseSignatureHeader(header);
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "bad_header" };

  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  if (!signatures.some((signature) => timingSafeEqual(signature, expected))) return { ok: false, reason: "bad_signature" };

  const tolerance = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - timestamp) > tolerance) return { ok: false, reason: "stale" };

  try {
    const event = JSON.parse(payload) as StripeEvent;
    if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data) return { ok: false, reason: "bad_payload" };
    return { ok: true, event };
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
}

/** A Stripe-Signature header for `payload`, as Stripe would send it. For
 *  tests of a webhook endpoint; `timestampSec` defaults to now. */
export async function signWebhook(payload: string, secret: string, timestampSec = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestampSec},v1=${await hmacSha256Hex(secret, `${timestampSec}.${payload}`)}`;
}
