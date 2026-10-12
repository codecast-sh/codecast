// A provider that cannot serve the hosted assistant (plan pl-840): an empty
// account, a bad key, an outage. Every turn that fails for it is counted on
// one open incident per provider, and the operator hears about it once, on
// the first failure, so an outage never shows up first in a customer's first
// conversation. The next turn the provider serves closes the incident, and
// so does a probe: while an incident is open, a one-token request goes to
// the provider every few minutes, so the assistant comes back by itself even
// when nobody can send (the funnel hides its asks while thinking is down).
import { v } from "convex/values";
import type { ProviderFault } from "@platform/agent";
import { internalAction, internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "../functions";
import { internal } from "../_generated/api";
import { postMessages } from "../lib/anthropic";

/** How the probe reaches outside, as one object tests replace: the delay
 *  before each probe (doubling from the first to the last), and the ping. */
export const incidentDeps: {
  probeDelaysMs: readonly number[];
  ping: (provider: string, model: string) => Promise<boolean>;
} = {
  probeDelaysMs: [2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000],
  ping: pingProvider,
};

/** One smallest-possible request on the deployment's key: true when the
 *  provider answered it. Spends a few tokens, never a person's usage. */
async function pingProvider(provider: string, model: string): Promise<boolean> {
  try {
    if (provider === "anthropic") {
      const response = await postMessages({ model, max_tokens: 1, prompt: "ping" });
      return !!response?.ok;
    }
    if (provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return false;
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: model.slice(model.indexOf("/") + 1), max_completion_tokens: 16, messages: [{ role: "user", content: "ping" }] }),
      });
      return response.ok;
    }
  } catch {
    return false;
  }
  return false;
}

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
  await ctx.scheduler.runAfter(incidentDeps.probeDelaysMs[0] ?? 120_000, internal.assistant.incidents.probe, { provider, model: failure.model, attempt: 0 });
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

/** The provider's open incident, if any, for the probe. */
export const openIncident = internalQuery({
  args: { provider: v.string() },
  handler: async (ctx, { provider }) =>
    await ctx.db
      .query("assistant_incidents")
      .withIndex("by_provider_closed", (q) => q.eq("provider", provider).eq("closed_at", undefined))
      .first(),
});

/** Closes the provider's open incident after a probe got through. */
export const closeFromProbe = internalMutation({
  args: { model: v.string() },
  handler: async (ctx, { model }) => {
    await closeProviderIncident(ctx, model);
  },
});

/** Tries the provider while its incident is open: a served ping closes it,
 *  a failed one tries again later, backing off to the last delay. */
export const probe = internalAction({
  args: { provider: v.string(), model: v.string(), attempt: v.number() },
  handler: async (ctx, { provider, model, attempt }): Promise<null> => {
    const open = await ctx.runQuery(internal.assistant.incidents.openIncident, { provider });
    if (!open) return null;
    if (await incidentDeps.ping(provider, open.model)) {
      await ctx.runMutation(internal.assistant.incidents.closeFromProbe, { model: open.model });
      return null;
    }
    const delays = incidentDeps.probeDelaysMs;
    const next = delays[Math.min(attempt + 1, delays.length - 1)] ?? 15 * 60_000;
    await ctx.scheduler.runAfter(next, internal.assistant.incidents.probe, { provider, model, attempt: attempt + 1 });
    return null;
  },
});

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

/** One alert to the operator: always the deployment's error log, and a
 *  Sentry event when the deployment has SENTRY_DSN. Never throws. */
export async function reportToOperator(alert: {
  message: string;
  detail?: string;
  logger: string;
  tags: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint: string[];
}): Promise<void> {
  console.error(`[${alert.logger}] ${alert.message}${alert.detail ? `: ${alert.detail}` : ""}`);
  const target = sentryTarget(process.env.SENTRY_DSN);
  if (!target) return;
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    level: "fatal",
    platform: "javascript",
    logger: alert.logger,
    message: { formatted: alert.message },
    tags: alert.tags,
    extra: alert.extra ?? {},
    fingerprint: alert.fingerprint,
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
    if (!response.ok) console.error(`[${alert.logger}] Sentry answered ${response.status}`);
  } catch (error) {
    console.error(`[${alert.logger}] Sentry unreachable`, error);
  }
}

/** Tells the operator a provider stopped serving the assistant. */
export const alertOperator = internalAction({
  args: { provider: v.string(), fault: v.string(), model: v.string(), error: v.string() },
  handler: async (_ctx, args): Promise<null> => {
    await reportToOperator({
      message: `Hosted assistant: ${args.provider} cannot serve turns (${args.fault}) on ${args.model}`,
      detail: args.error,
      logger: "assistant.incidents",
      tags: { surface: "hosted-assistant", provider: args.provider, fault: args.fault, model: args.model },
      extra: { error: args.error },
      fingerprint: ["hosted-assistant-provider", args.provider, args.fault],
    });
    return null;
  },
});

/** Tells the operator the Free plan reached its daily ceiling
 *  (assistant/freeGate.ts): new Free turns pause until the next UTC day. */
export const alertFreeCeiling = internalAction({
  args: { day: v.string(), spent_usd: v.number(), ceiling_usd: v.number(), turns: v.number() },
  handler: async (_ctx, args): Promise<null> => {
    await reportToOperator({
      message: `Hosted assistant: Free turns spent $${args.spent_usd.toFixed(2)} on ${args.day} (ceiling $${args.ceiling_usd}); new Free turns are paused until tomorrow UTC`,
      detail: `${args.turns} Free turns today. Raise HOSTED_FREE_DAILY_USD to resume them now.`,
      logger: "assistant.free",
      tags: { surface: "hosted-assistant", gate: "free-daily-ceiling" },
      extra: { ...args },
      fingerprint: ["hosted-assistant-free-ceiling", args.day],
    });
    return null;
  },
});
