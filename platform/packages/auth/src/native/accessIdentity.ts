import type { AccessIdentity } from "./authTrust";

/**
 * Parse the principal out of a Convex Auth JWT without verifying it. The
 * device uses this only to decide what may render from its own cache; the
 * server is what authorizes anything.
 */
export function parseAccessIdentity(token: string | null): AccessIdentity | null {
  if (!token || typeof atob !== 'function') return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const decode = (value: string) => JSON.parse(atob(
      value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='),
    ));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== 'RS256' || payload.aud !== 'convex' ||
      typeof payload.iss !== 'string' || typeof payload.sub !== 'string') return null;
    const [principalId, sessionId, ...extra] = payload.sub.split('|');
    if (!principalId || !sessionId || extra.length > 0) return null;
    return { principalId, subject: payload.sub };
  } catch {
    return null;
  }
}
