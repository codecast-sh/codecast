// The replay player's capability (docs/architecture/external-data.md X5,
// "Playing a replay"; contracts/replayPlayer.ts). The player lives on its own
// origin and holds no codecast session, so it reads a replay through a
// capability minted here after the viewer's access check: a short-lived,
// tamper-proof token naming one replay and the person it was minted for.
//
//   <base64url json {v, r, u, exp}>.<hex HMAC-SHA256>
//
// Only Convex signs and only Convex verifies (the manifest route); the worker
// and the page pass the token along and never need the key. The key is
// derived from the replays bucket's own secret with a fixed label, so it
// exists wherever replays do and rotates with that token; a rotation only
// kills capabilities that live ten minutes anyway. The manifest route checks
// the named person can still read the replay, so a removal takes effect on
// the next load, not after the token lapses.
import { timingSafeEqual } from "@platform/crypto/hex";
import { hmacSha256Hex } from "./hmac";
import { REPLAY_CAP_TTL_MS } from "@codecast/shared/contracts/replayPlayer";

const LABEL = "codecast replay player capability v1";

export interface ReplayCapPayload {
  v: 1;
  /** The replay's _id. */
  r: string;
  /** Who it was minted for: the manifest re-checks their access. */
  u: string;
  /** Epoch ms after which it opens nothing. */
  exp: number;
}

/** The signing key, or null where replays are not configured (no capability can be minted or opened). */
export async function replayCapKey(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const root = env.REPLAYS_R2_SECRET_ACCESS_KEY;
  return root ? await hmacSha256Hex(root, LABEL) : null;
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

export async function mintReplayCap(key: string, p: { replay_id: string; user_id: string; now: number; ttl_ms?: number }): Promise<{ cap: string; expires_at: number }> {
  const exp = p.now + (p.ttl_ms ?? REPLAY_CAP_TTL_MS);
  const body = b64url(JSON.stringify({ v: 1, r: p.replay_id, u: p.user_id, exp } satisfies ReplayCapPayload));
  return { cap: `${body}.${await hmacSha256Hex(key, body)}`, expires_at: exp };
}

/** The payload of a capability this key signed and that has not lapsed, else null. An empty key opens nothing. */
export async function openReplayCap(key: string | null, cap: string | null | undefined, now: number): Promise<ReplayCapPayload | null> {
  if (!key || !cap || cap.length > 1024) return null;
  const dot = cap.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = cap.slice(0, dot);
  if (!timingSafeEqual(cap.slice(dot + 1), await hmacSha256Hex(key, body))) return null;
  try {
    const p = JSON.parse(unb64url(body));
    if (p?.v !== 1 || typeof p.r !== "string" || typeof p.u !== "string" || typeof p.exp !== "number") return null;
    return p.exp > now ? (p as ReplayCapPayload) : null;
  } catch {
    return null;
  }
}
