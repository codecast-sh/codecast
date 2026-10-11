// Triage: an Auto message is stored as chat marked pending, and a fast model
// decides whether it asks for a change. A change becomes a request with a
// queued build, in place; chat stays chat. When triage fails, or a change
// can't be queued (the asker's build rate, a spent budget), the message stays
// chat and Clay says why under it, so nobody waits on a change that isn't
// coming. The composer's "Change it" and "Just chat" skip this.
import { runAssistant } from "@platform/agent";
import { ConvexError, v } from "convex/values";
import type { PlaygroundErrorData } from "../lib/errors";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { BUILD_ROOM_CONTEXT, TRIAGE_CEILING_USD } from "../lib/limits";
import { TRIAGE_MODEL, TRIAGE_SYSTEM, parseTriage, triagePrompt } from "../prompts";
import { postClayReply } from "../model";
import { chargeSpend, enqueueBuild, roomBefore } from "./queue";

/** Clay's word when triage could not decide. */
export const TRIAGE_UNSURE = "I couldn't tell if that was a change. Send it with Change it if it was.";

const TRIAGE_DEADLINE_MS = 15_000;
/** The smallest cap the harness makes a call with; the answer is one word. */
const TRIAGE_MAX_TOKENS = 1_024;

export const input = internalQuery({
  args: { message_id: v.id("messages") },
  handler: async (ctx, { message_id }) => {
    const message = await ctx.db.get(message_id);
    if (message?.triage !== "pending") return null;
    return {
      body: message.body,
      element: message.element ?? null,
      room: await roomBefore(ctx, message, Math.ceil(BUILD_ROOM_CONTEXT / 2)),
    };
  },
});

export const classify = internalAction({
  args: { message_id: v.id("messages") },
  handler: async (ctx, { message_id }): Promise<null> => {
    const found = await ctx.runQuery(internal.builder.triage.input, { message_id });
    if (!found) return null;
    let kind: "change" | "chat" | "unsure" = "unsure";
    let cost = TRIAGE_CEILING_USD;
    try {
      const result = await runAssistant({
        model: TRIAGE_MODEL,
        system: TRIAGE_SYSTEM,
        history: [{ role: "user", content: triagePrompt(found) }],
        ceilingUsd: TRIAGE_CEILING_USD,
        deadlineMs: TRIAGE_DEADLINE_MS,
        maxTokens: TRIAGE_MAX_TOKENS,
        apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY },
      });
      cost = result.costUsd;
      const answer = result.messages.map((m) => (m.role === "assistant" ? (m.content ?? "") : "")).join(" ");
      if (result.reason !== "done") console.warn(`[triage] ${message_id} stopped: ${result.reason} ${result.error ?? ""}`);
      kind = parseTriage(answer) ?? "unsure";
    } catch (e) {
      console.warn(`[triage] ${message_id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await ctx.runMutation(internal.builder.triage.settle, { message_id, kind, cost_usd: cost });
    return null;
  },
});

/** Settle a pending message: a change queues its build; chat just clears
 *  the mark. A change that can't be queued, or a triage that couldn't
 *  decide, stays chat with Clay's reply saying why. The call's real cost
 *  replaces the hold messages.send put on the budgets. */
/** Why a change Clay heard won't be built now, as Clay says it. */
export function cantQueue(err: PlaygroundErrorData): string {
  if (err.code !== "rate_limited") return `${err.message} Chat still works.`;
  const minutes = Math.max(1, Math.ceil((err.retry_after_ms ?? 60_000) / 60_000));
  return `That's a lot of changes in a few minutes. Ask again in ${minutes} min and I'll build it. Chat still works.`;
}

export const settle = internalMutation({
  args: { message_id: v.id("messages"), kind: v.union(v.literal("change"), v.literal("chat"), v.literal("unsure")), cost_usd: v.number() },
  handler: async (ctx, { message_id, kind, cost_usd }) => {
    const message = await ctx.db.get(message_id);
    const app = message && (await ctx.db.get(message.app_id));
    if (app) await chargeSpend(ctx, app._id, message.visitor_id, cost_usd - TRIAGE_CEILING_USD);
    if (!app || message.triage !== "pending") return;
    let reply = kind === "unsure" ? TRIAGE_UNSURE : null;
    if (kind === "change" && message.visitor_id) {
      try {
        await enqueueBuild(ctx, app, message, message.visitor_id);
        return;
      } catch (e) {
        if (!(e instanceof ConvexError)) throw e;
        reply = cantQueue(e.data as PlaygroundErrorData);
      }
    }
    await ctx.db.patch(message_id, { triage: undefined });
    if (reply) await postClayReply(ctx, app._id, reply);
  },
});
