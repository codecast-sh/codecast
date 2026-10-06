// A provider that cannot serve the hosted assistant (plan pl-840): an empty
// account, a bad key, an outage. Every turn that fails for it is counted on
// one open incident per provider, and the operator hears about it once, on
// the first failure, so an outage never shows up first in a customer's first
// conversation. The next turn the provider serves closes the incident.
import { v } from "convex/values";
import type { ProviderFault } from "@platform/agent";
import { internalAction, query, type MutationCtx, type QueryCtx } from "../functions";
import { internal } from "../_generated/api";

/** The provider a model id runs on: `openai/...` names OpenAI, a bare id is Claude. */
export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "anthropic";
}

/** Counts a provider failure on the provider's open incident, opening one
 *  (and alerting the operator) when none is open. */
export async function noteProviderFault(
  ctx: MutationCtx,
  failure: { model: string; fault: ProviderFault; error: string },
): Promise<void> {
  const provider = providerOf(failure.model);
  const now = Date.now();
  const open = await ctx.db
    .query("assistant_incidents")
    .withIndex("by_provider_closed", (q) => q.eq("provider", provider).eq("closed_at", undefined))
    .first();
  if (open) {
    await ctx.db.patch(open._id, { last_at: now, count: open.count + 1, fault: failure.fault, error: failure.error.slice(0, 1_000) });
    return;
  }
  await ctx.db.insert("assistant_incidents", {
    provider,
    fault: failure.fault,
    model: failure.model,
    error: failure.error.slice(0, 1_000),
    first_at: now,
    last_at: now,
    count: 1,
  });
  await ctx.scheduler.runAfter(0, internal.assistant.incidents.alertOperator, {
    provider,
    fault: failure.fault,
    model: failure.model,
    error: failure.error.slice(0, 1_000),
  });
}

/** Closes the provider's open incident: a turn on it was just served. */
export async function closeProviderIncident(ctx: MutationCtx, model: string): Promise<void> {
  const open = await ctx.db
    .query("assistant_incidents")
    .withIndex("by_provider_closed", (q) => q.eq("provider", providerOf(model)).eq("closed_at", undefined))
    .first();
  if (open) await ctx.db.patch(open._id, { closed_at: Date.now() });
}

/** Whether a provider has an open incident: its last turn failed and none
 *  has been served since. */
async function providerDown(ctx: QueryCtx, provider: string): Promise<boolean> {
  const open = await ctx.db
    .query("assistant_incidents")
    .withIndex("by_provider_closed", (q) => q.eq("provider", provider).eq("closed_at", undefined))
    .first();
  return !!open;
}

/** Whether the assistant can think right now: the default provider serves,
 *  or the fallback tier has a key and serves. Read by the start of the
 *  funnel (/welcome) and the composer's empty state, so a newcomer hears
 *  "I'm having trouble thinking right now" before typing rather than after.
 *  It says no more than that: no provider names or errors. */
export const thinkingAvailable = query({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    if (!(await providerDown(ctx, "anthropic"))) return true;
    return !!process.env.OPENAI_API_KEY && !(await providerDown(ctx, "openai"));
  },
});

/** A Sentry DSN's envelope endpoint and key, or null for anything else. */
export function sentryTarget(dsn: string | undefined): { url: string; key: string } | null {
  if (!dsn) return null;
  try {
    const parsed = new URL(dsn);
    const project = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!parsed.username || !project) return null;
    return { url: `${parsed.protocol}//${parsed.host}/api/${project}/envelope/`, key: parsed.username };
  } catch {
    return null;
  }
}

/** Tells the operator a provider stopped serving the assistant: always in
 *  the deployment's error log, and as a Sentry event when the deployment
 *  has SENTRY_DSN. */
export const alertOperator = internalAction({
  args: { provider: v.string(), fault: v.string(), model: v.string(), error: v.string() },
  handler: async (_ctx, args): Promise<null> => {
    const message = `Hosted assistant: ${args.provider} cannot serve turns (${args.fault}) on ${args.model}`;
    console.error(`[assistant incident] ${message}: ${args.error}`);
    const target = sentryTarget(process.env.SENTRY_DSN);
    if (!target) return null;
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      level: "fatal",
      platform: "javascript",
      logger: "assistant.incidents",
      message: { formatted: message },
      tags: { surface: "hosted-assistant", provider: args.provider, fault: args.fault, model: args.model },
      extra: { error: args.error },
      fingerprint: ["hosted-assistant-provider", args.provider, args.fault],
    };
    const body = [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=codecast-convex/1, sentry_key=${target.key}`,
        },
        body,
      });
      if (!response.ok) console.error(`[assistant incident] Sentry answered ${response.status}`);
    } catch (error) {
      console.error("[assistant incident] Sentry unreachable", error);
    }
    return null;
  },
});
