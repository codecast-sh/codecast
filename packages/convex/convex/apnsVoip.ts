// Direct APNs for VoIP pushes (PushKit). The Expo push service has no VoIP
// channel, so ring pushes that must wake a KILLED app and put up the
// lock-screen call UI go straight to Apple. The JWT and the HTTP send live in
// apns.ts, shared with Live Activity updates; this file owns the VoIP topic,
// the ring TTL and the token hygiene.
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
import { APNS_BUNDLE_ID, apnsTokenIsDead, sendApns } from "./apns";

async function sendVoip(
  ctx: any,
  args: { token: string; payload: Record<string, unknown>; user_id: any },
): Promise<{ ok: boolean; status: number; reason?: string }> {
  const res = await sendApns(ctx, {
    token: args.token,
    topic: `${APNS_BUNDLE_ID}.voip`,
    pushType: "voip",
    priority: 10,
    // A ring that can't be delivered inside the invite TTL is worthless —
    // and a late VoIP push MUST still report a CallKit call (Apple kills
    // apps that swallow one), so never let a dead ring arrive minutes later.
    expiration: Math.floor((Date.now() + CALL_INVITE_TTL_MS) / 1000),
    payload: args.payload,
  });
  if (res.ok) return res;
  // Token is dead (app removed / token rotated): clear it so we stop trying.
  if (args.user_id && apnsTokenIsDead(res)) {
    await ctx.runMutation(internal.apnsVoip.clearDeadVoipToken, {
      user_id: args.user_id,
      voip_push_token: args.token,
    });
  }
  console.error("APNs VoIP push failed:", res.status, res.reason);
  return res;
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
  handler: async (ctx, args): ReturnType<typeof sendVoip> => {
    // The anchor is a session or channel line: content a regulated
    // recipient's ring must not carry to Apple (pushPrivacy.ts).
    const { strip }: { strip: boolean } = await ctx.runQuery(internal.notifications.pushPrivacyFor, { user_id: args.user_id });
    const anchorTitle = strip ? undefined : args.anchor_title;
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
            ...(anchorTitle ? { anchor_title: anchorTitle } : {}),
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

