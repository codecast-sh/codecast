// Direct APNs for VoIP pushes (PushKit). The Expo push service has no VoIP
// channel, so ring pushes that must wake a KILLED app and put up the
// lock-screen call UI go straight to Apple, signed with an APNs Auth Key
// (.p8, ES256 — one key works for every app on the team, never expires).
//
// Env (set via `npx convex env set`):
//   APNS_KEY_ID      — the 10-char key id from the developer portal
//   APNS_TEAM_ID     — the Apple team id
//   APNS_AUTH_KEY    — the .p8 contents (PEM, newlines as \n or literal)
//   APNS_ENV         — "production" | "sandbox" (default production; VoIP
//                      pushes to a TestFlight/App Store build use production,
//                      to an Xcode debug build use sandbox)
//
// The payload contract is expo-callkit-telecom's: `{ incomingCall: {...} }`,
// parsed natively before JS runs so cold-start rings need no app-side glue.
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  CALL_INVITE_TTL_MS,
  CALL_PUSH_TYPE_RING,
} from "@codecast/shared/contracts";

const BUNDLE_ID = "com.ashotp.codecast";

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

// APNs provider token: ES256 JWT, valid 20–60 min. Minted per send (cheap;
// Convex actions are short-lived so caching across invocations buys nothing).
async function mintApnsJwt(keyId: string, teamId: string, pem: string): Promise<string> {
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
    enc.encode(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })),
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

async function sendVoip(
  ctx: any,
  args: { token: string; payload: Record<string, unknown>; user_id: any },
): Promise<{ ok: boolean; status: number; reason?: string }> {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const pem = process.env.APNS_AUTH_KEY;
  if (!keyId || !teamId || !pem) return { ok: false, status: 0, reason: "APNS not configured" };
  const host =
    (process.env.APNS_ENV ?? "production") === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  const jwt = await mintApnsJwt(keyId, teamId, pem);
  const res = await fetch(`${host}/3/device/${args.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": `${BUNDLE_ID}.voip`,
      "apns-push-type": "voip",
      "apns-priority": "10",
      // A ring that can't be delivered inside the invite TTL is worthless —
      // and a late VoIP push MUST still report a CallKit call (Apple kills
      // apps that swallow one), so never let a dead ring arrive minutes later.
      "apns-expiration": String(Math.floor((Date.now() + CALL_INVITE_TTL_MS) / 1000)),
      "content-type": "application/json",
    },
    body: JSON.stringify(args.payload),
  });
  if (res.status === 200) return { ok: true, status: 200 };
  let reason: string | undefined;
  try {
    reason = (await res.json())?.reason;
  } catch {}
  // Token is dead (app removed / token rotated): clear it so we stop trying.
  if (args.user_id && (res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered")) {
    await ctx.runMutation(internal.apnsVoip.clearDeadVoipToken, {
      user_id: args.user_id,
      voip_push_token: args.token,
    });
  }
  console.error("APNs VoIP push failed:", res.status, reason);
  return { ok: false, status: res.status, reason };
}

// Ring a phone through CallKit. Payload shape = expo-callkit-telecom's
// IncomingCallEvent under `incomingCall`; `serverCallId` is our invite id and
// `metadata` carries what the app needs to join.
export const sendVoipRing = internalAction({
  args: {
    voip_push_token: v.string(),
    user_id: v.id("users"),
    invite_id: v.string(),
    room_key: v.string(),
    caller_id: v.string(),
    caller_name: v.string(),
    caller_image: v.optional(v.string()),
    anchor_title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return sendVoip(ctx, {
      token: args.voip_push_token,
      user_id: args.user_id,
      payload: {
        incomingCall: {
          eventId: `${args.invite_id}:${Date.now()}`,
          serverCallId: args.invite_id,
          hasVideo: false,
          startedAt: new Date().toISOString(),
          caller: {
            id: args.caller_id,
            displayName: args.caller_name,
            ...(args.caller_image ? { avatarUrl: args.caller_image } : {}),
          },
          metadata: {
            type: CALL_PUSH_TYPE_RING,
            invite_id: args.invite_id,
            room_key: args.room_key,
            ...(args.anchor_title ? { anchor_title: args.anchor_title } : {}),
          },
        },
      },
    });
  },
});

// The token APNs declared dead — cleared only if the user still carries THAT
// token, so a re-registration that raced the failure is never wiped.
export const clearDeadVoipToken = internalMutation({
  args: { user_id: v.id("users"), voip_push_token: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.user_id);
    if (user?.voip_push_token === args.voip_push_token) {
      await ctx.db.patch(args.user_id, { voip_push_token: undefined });
    }
  },
});

// Config probe: sends a VoIP push to a bogus token. APNs validates the
// provider JWT before the token, so `BadDeviceToken` (400) proves the key,
// team id and key id are right; `InvalidProviderToken` (403) means they are
// not. Never touches a real device.
export const probeApnsConfig = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!apnsConfigured()) return { ok: false, reason: "APNS env not set" };
    const bogus = "00".repeat(32);
    const r = await sendVoip(ctx, {
      token: bogus,
      user_id: undefined,
      payload: { incomingCall: { eventId: "probe", serverCallId: "probe", hasVideo: false, caller: { id: "probe", displayName: "probe" } } },
    });
    return { ...r, verdict: r.reason === "BadDeviceToken" ? "KEY OK (auth accepted, token rejected as expected)" : r.reason };
  },
});
