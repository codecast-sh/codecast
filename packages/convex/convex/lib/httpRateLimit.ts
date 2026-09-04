// Rate limiting for HTTP routes that no one has signed in to.
//
// The counter itself is ipRateLimit.bumpWindow; these are the two ways an
// unauthenticated route uses it, and they differ in what they do when the
// limiter itself fails.

import { internal } from "../_generated/api";

/** The caller's address as the proxy mesh reports it. */
export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function tooManyRequests(retryAfterMs: number, extraHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

/**
 * Limit by an arbitrary key. Returns a 429 to short-circuit the route, or null.
 *
 * `failClosed` decides the limiter's own bad day. Sign-in style routes fail
 * open, because a limiter blip locking the fleet out is worse than the abuse.
 * Routes where heavy contention on one counter row IS what the flood looks like
 * fail closed instead, and answer 503.
 */
export async function keyRateLimited(
  ctx: any,
  key: string,
  max: number,
  windowMs: number,
  failClosed = false,
): Promise<Response | null> {
  try {
    const res = await ctx.runMutation(internal.ipRateLimit.bump, { key, max, window_ms: windowMs });
    if (!res.ok) return tooManyRequests(res.retry_after_ms ?? windowMs, {});
  } catch {
    if (!failClosed) return null;
    return new Response(JSON.stringify({ error: "Temporarily unavailable — please retry." }), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "5",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  return null;
}

/** Limit by the caller's IP. Fails open. */
export async function ipRateLimited(
  ctx: any,
  request: Request,
  name: string,
  max: number,
  windowMs: number,
): Promise<Response | null> {
  return await keyRateLimited(ctx, `${name}:${clientIp(request)}`, max, windowMs, false);
}
