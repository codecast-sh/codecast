// The two HTTP entries into the Sentry source: the signed webhook
// (POST /api/webhooks/sentry) and `cast events resolve|ignore|reopen|mute`
// (/cli/events/set-status). Both work through internal/api functions, so
// http.ts mounts them without loading sources/sentry.ts, which reaches the big
// import cycle (ct-92432).
import { httpAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { GroupStatus } from "@codecast/shared/contracts/ingest";
import { verifyHmacHex } from "./hmac";
import { parseSentryWebhook, sentryStatusFor, SENTRY_WEBHOOK_SECRET_ENV } from "../sources/sentryShape";

/**
 * `POST /api/webhooks/sentry`. Sentry signs the raw body with the internal
 * integration's client secret (Sentry-Hook-Signature, hex HMAC-SHA256) and
 * names each delivery with Request-ID. A missing secret is our
 * misconfiguration (500, so Sentry retries once it is set); a bad signature is
 * a caller we refuse (401). The work is scheduled and the answer is fast.
 */
export const sentryWebhook = httpAction(async (ctx, request) => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const raw = await request.text();
  const secret = process.env[SENTRY_WEBHOOK_SECRET_ENV];
  if (!secret) {
    console.error(`[sentry webhook] ${SENTRY_WEBHOOK_SECRET_ENV} not configured; refusing webhook`);
    return json(500, { error: "Webhook not configured" });
  }
  if (!(await verifyHmacHex(raw, request.headers.get("sentry-hook-signature"), secret))) return json(401, { error: "Invalid signature" });
  const requestId = request.headers.get("request-id");
  if (!requestId) return json(400, { error: "Missing Request-ID" });
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  const work = parseSentryWebhook(request.headers.get("sentry-hook-resource"), body);
  const result: any = await ctx.runMutation(internal.sources.sentry.takeWebhook, { request_id: requestId.slice(0, 200), work_json: JSON.stringify(work) });
  return json(200, result);
});

/**
 * `cast events resolve|ignore|reopen|mute` (/cli/events/set-status). A group
 * mirrored from Sentry is resolved, ignored or reopened in Sentry (on a
 * person's grant), since the next poll follows Sentry's status; a mute is
 * codecast's own and is set here. Sentry decides its own regressions, so a
 * release named with --in is not used for a mirrored group, and the answer
 * says so.
 */
export async function setEventGroupStatus(
  ctx: { runQuery: (...a: any[]) => Promise<any>; runMutation: (...a: any[]) => Promise<any>; runAction: (...a: any[]) => Promise<any> },
  body: { api_token?: string; group: string; status: GroupStatus; resolved_in?: string; conversation_id?: string; [k: string]: unknown },
): Promise<any> {
  const { group } = await ctx.runQuery(api.ingest.getGroup, { api_token: body.api_token, group: body.group });
  const status = sentryStatusFor(group, body.status);
  if (!status) return await ctx.runMutation(api.ingest.setGroupStatus, body);
  const out = await ctx.runAction(api.sources.sentry.setIssueStatus, {
    api_token: body.api_token,
    group: body.group,
    status,
    // The agent session that asked, so the app_calls row names it.
    ...(typeof body.conversation_id === "string" ? { conversation_id: body.conversation_id } : {}),
  });
  if (!out.ok) return { error: out.error ?? "Sentry refused the change" };
  return {
    ...(await ctx.runQuery(api.ingest.getGroup, { api_token: body.api_token, group: body.group })),
    sentry_status: out.status,
    ...(body.resolved_in?.trim() ? { note: `--in ${body.resolved_in.trim()} was not used: ${group.short_id} is mirrored from Sentry, which decides its regressions` } : {}),
  };
}
