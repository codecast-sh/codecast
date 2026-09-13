// Direct APNs: the provider JWT and the one HTTP/2 send every push type shares.
//
// The Expo push service covers ordinary notifications. Two things it cannot
// carry go straight to Apple, signed with the team's APNs Auth Key (.p8,
// ES256 — one key for every app on the team, never expires): VoIP rings
// (apnsVoip.ts) and Live Activity updates (liveActivity.ts). This module is
// the shared floor under both; the push-type specifics (topic suffix, headers,
// payload shape) stay with their callers.
//
// Env (set via `npx convex env set`):
//   APNS_KEY_ID      — the 10-char key id from the developer portal
//   APNS_TEAM_ID     — the Apple team id
//   APNS_AUTH_KEY    — the .p8 contents (PEM, newlines as \n or literal)
//   APNS_ENV         — "production" | "sandbox" (default production). A
//                      TestFlight / App Store build talks to production; an
//                      Xcode or EAS development build to sandbox. Callers that
//                      know the device's environment pass it explicitly.

import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

export const APNS_BUNDLE_ID = "com.ashotp.codecast";

export type ApnsEnvironment = "production" | "sandbox";

export type ApnsPushType = "voip" | "liveactivity" | "alert" | "background";

export interface ApnsSendArgs {
  token: string;
  topic: string;
  pushType: ApnsPushType;
  /** 10 = immediately, 5 = power-considerate. */
  priority: 5 | 10;
  /** Unix seconds after which APNs drops an undelivered push. 0 = try once. */
  expiration?: number;
  collapseId?: string;
  environment?: ApnsEnvironment;
  payload: Record<string, unknown>;
}

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  reason?: string;
}

// APNs said this token no longer addresses anything: the app was removed, the
// token rotated, or (Live Activities) the activity ended on the device.
export function apnsTokenIsDead(result: ApnsSendResult): boolean {
  return (
    result.status === 410 ||
    result.reason === "BadDeviceToken" ||
    result.reason === "Unregistered" ||
    result.reason === "ExpiredToken"
  );
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// APNs provider token: ES256 JWT, reused for 50 minutes through the database
// so separate action invocations and concurrent sends share the same token.
export async function mintApnsJwt(keyId: string, teamId: string, pem: string, issuedAt = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = b64url(
    enc.encode(JSON.stringify({ iss: teamId, iat: Math.floor(issuedAt / 1000) })),
  );
  const input = `${header}.${claims}`;
  // WebCrypto ECDSA returns raw r||s (64 bytes) — exactly the JWS form.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(input),
  );
  return `${input}.${b64url(sig)}`;
}

export function apnsConfigured(): boolean {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_AUTH_KEY);
}

export function apnsDefaultEnvironment(): ApnsEnvironment {
  return (process.env.APNS_ENV ?? "production") === "sandbox" ? "sandbox" : "production";
}

export function apnsHost(environment: ApnsEnvironment): string {
  return environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
}

export async function sendApns(ctx: Pick<ActionCtx, "runQuery" | "runMutation">, args: ApnsSendArgs): Promise<ApnsSendResult> {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const pem = process.env.APNS_AUTH_KEY;
  if (!keyId || !teamId || !pem) return { ok: false, status: 0, reason: "APNS not configured" };
  const identity = { key_id: keyId, team_id: teamId };
  let jwt = await ctx.runQuery(internal.apnsProviderToken.get, identity);
  if (!jwt) {
    const issuedAt = Date.now();
    const token = await mintApnsJwt(keyId, teamId, pem, issuedAt);
    jwt = await ctx.runMutation(internal.apnsProviderToken.retain, {
      ...identity,
      token,
      issued_at: issuedAt,
    });
  }
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": args.topic,
    "apns-push-type": args.pushType,
    "apns-priority": String(args.priority),
    "content-type": "application/json",
  };
  if (args.expiration !== undefined) headers["apns-expiration"] = String(args.expiration);
  if (args.collapseId) headers["apns-collapse-id"] = args.collapseId;
  const res = await fetch(`${apnsHost(args.environment ?? apnsDefaultEnvironment())}/3/device/${args.token}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args.payload),
  });
  if (res.status === 200) return { ok: true, status: 200 };
  let reason: string | undefined;
  try {
    reason = (await res.json())?.reason;
  } catch {}
  return { ok: false, status: res.status, reason };
}
