// POST /api/webhooks/slack: an @mention or DM in a mapped channel wakes that
// channel's anchor, and a linked channel mirrors every event (slackSync).
// Verified by Slack's v0 HMAC signature (SLACK_SIGNING_SECRET) with replay
// protection, then deduped by event_id so a Slack retry can't double-wake.
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { hmacSha256Hex, timingSafeEqualHex } from "./hmac";

export const slackWebhook = httpAction(async (ctx, request) => {
  const signature = request.headers.get("X-Slack-Signature");
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const body = await request.text();
  const secret = process.env.SLACK_SIGNING_SECRET;

  if (!secret) {
    console.error("[slack webhook] SLACK_SIGNING_SECRET not configured; refusing");
    return new Response(JSON.stringify({ error: "Webhook not configured" }), { status: 500 });
  }
  if (!signature || !timestamp) {
    return new Response(JSON.stringify({ error: "Missing signature" }), { status: 401 });
  }
  // Replay protection: reject stale timestamps (Slack recommends 5 minutes).
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return new Response(JSON.stringify({ error: "Stale timestamp" }), { status: 401 });
  }
  if (!timingSafeEqualHex(signature, "v0=" + (await hmacSha256Hex(secret, `v0:${timestamp}:${body}`)))) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  const payload = JSON.parse(body);
  // Slack's one-time endpoint verification handshake.
  if (payload.type === "url_verification") {
    return new Response(payload.challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  if (payload.type === "event_callback") {
    const event = payload.event || {};
    const eventId = payload.event_id as string | undefined;
    // Ignore the bot's own posts on both paths, so an anchor reply that happens
    // to @mention the app can't wake it in a loop (each loop has a new event_id,
    // so dedup wouldn't catch it).
    // Channel mirroring first (slackSync): a linked channel takes every event
    // for it, including the mention (the mirrored line's @mention wakes the
    // anchor through chat). "no_link" leaves the event for the anchor path.
    let mirrored = false;
    if (eventId && payload.team_id) {
      const routed = await ctx.runMutation(internal.slackSync.ingestEvent, {
        event_id: eventId,
        workspace: String(payload.team_id),
        event,
        // A user event (a person's DM) names whose behalf it came on.
        authed_users: Array.isArray(payload.authorizations)
          ? payload.authorizations.map((a: any) => String(a?.user_id ?? "")).filter(Boolean)
          : undefined,
      });
      mirrored = routed.status !== "no_link";
    }
    const isMention =
      event.type === "app_mention" && !event.bot_id && !event.subtype;
    const isDM =
      event.type === "message" && event.channel_type === "im" && !event.bot_id && !event.subtype;
    if (!mirrored && (isMention || isDM) && eventId && event.channel) {
      // One atomic mutation: dedup + resolve channel→anchor + wake. If the wake
      // throws it returns 500 and Slack retries — the dedup row rolls back with
      // it, so a transient failure never silently drops the mention.
      await ctx.runMutation(internal.slack.wakeFromSlackEvent, {
        event_id: eventId,
        channel: event.channel,
        workspace: payload.team_id as string | undefined,
        user: event.user,
        text: String(event.text || ""),
        thread: event.thread_ts || event.ts,
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
