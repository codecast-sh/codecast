// Recall's two webhooks for meeting bots (meetingBots.ts): the account
// webhook's status changes and each bot's real-time endpoint. Both verify
// Recall's signature before reading a byte of the body.
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { verifyRecallRequest } from "./lib/recall";

async function verified(request: Request): Promise<{ ok: true; body: any } | { ok: false; response: Response }> {
  const raw = await request.text();
  const check = await verifyRecallRequest({ secret: process.env.RECALL_VERIFICATION_SECRET, headers: request.headers, body: raw });
  if (!check.ok) {
    console.warn(`[meetingBots] refused a Recall request: ${check.reason}`);
    return { ok: false, response: new Response(check.reason, { status: 401 }) };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: new Response("bad json", { status: 400 }) };
  }
}

/** Recall's account webhook: bot status changes. */
export const statusWebhook = httpAction(async (ctx, request) => {
  const v = await verified(request);
  if (!v.ok) return v.response;
  const event = String(v.body?.event ?? "");
  if (!event.startsWith("bot.")) return new Response("ignored", { status: 200 });
  const data = v.body?.data ?? {};
  const updatedAt = Date.parse(data?.data?.updated_at ?? "");
  await ctx.runMutation(internal.meetingBots.applyStatus, {
    meet_id: data?.bot?.metadata?.meet_id ?? undefined,
    bot_id: data?.bot?.id ?? undefined,
    event,
    sub_code: data?.data?.sub_code ?? undefined,
    at: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  });
  return new Response("ok", { status: 200 });
});

/** The bot's real-time endpoint: finished transcript lines and who joined.
 *  Recall sends a bot's next event only after this one answers, so the
 *  handler does one mutation and returns. */
export const realtimeWebhook = httpAction(async (ctx, request) => {
  const v = await verified(request);
  if (!v.ok) return v.response;
  const event = String(v.body?.event ?? "");
  const data = v.body?.data ?? {};
  const botId: string | undefined = data?.bot?.id;
  const meetId: string | undefined = data?.bot?.metadata?.meet_id;
  if (!botId) return new Response("ignored", { status: 200 });
  if (event === "transcript.data") {
    const inner = data?.data ?? {};
    const p = inner.participant ?? {};
    await ctx.runMutation(internal.meetingBots.applyTranscriptLine, {
      meet_id: meetId,
      bot_id: botId,
      participant: { id: p.id ?? "unknown", name: p.name ?? null, email: p.email ?? null, is_host: p.is_host ?? null },
      words: (inner.words ?? []).map((w: any) => ({
        text: typeof w?.text === "string" ? w.text : undefined,
        start_timestamp: w?.start_timestamp ? { relative: Number(w.start_timestamp.relative) || 0 } : null,
        end_timestamp: w?.end_timestamp ? { relative: Number(w.end_timestamp.relative) || 0 } : null,
      })),
    });
    return new Response("ok", { status: 200 });
  }
  if (event === "participant_events.chat_message") {
    const inner = data?.data ?? {};
    const p = inner.participant ?? {};
    const text = typeof inner.data?.text === "string" ? inner.data.text : "";
    // Only what the whole meeting saw; a direct message to the bot is not
    // the room talking.
    const to = String(inner.data?.to ?? "everyone").toLowerCase();
    if (text && (to === "everyone" || to === "")) {
      await ctx.runMutation(internal.meetingBots.applyChatLine, {
        meet_id: meetId,
        bot_id: botId,
        participant: { id: p.id ?? "unknown", name: p.name ?? null, email: p.email ?? null },
        text,
      });
      return new Response("ok", { status: 200 });
    }
  }
  await ctx.runMutation(internal.meetingBots.beat, { meet_id: meetId, bot_id: botId });
  return new Response("ok", { status: 200 });
});
